const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectDir = __dirname;
const repoDir = path.resolve(projectDir, '..');
const server = require(path.join(projectDir, 'server.js'));

function readProjectFile(fileName) {
  return fs.readFileSync(path.join(projectDir, fileName), 'utf8');
}

function readRepoFile(fileName) {
  return fs.readFileSync(path.join(repoDir, fileName), 'utf8');
}

function assertIncludes(source, text, message) {
  assert.ok(source.includes(text), message || `Expected source to include ${JSON.stringify(text)}`);
}

function assertMatches(source, pattern, message) {
  pattern.lastIndex = 0;
  assert.ok(pattern.test(source), message || `Expected source to match ${pattern}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRouteBlock(source, routeStartText, message) {
  const routeStart = source.indexOf(routeStartText);
  assert.ok(routeStart !== -1, message || `${routeStartText} route is present`);

  const nextRouteOffset = source.slice(routeStart + 1).search(/\r?\napp\./);
  return source.slice(routeStart, nextRouteOffset === -1 ? undefined : routeStart + 1 + nextRouteOffset);
}

function extractBetween(source, startText, endText, message) {
  const start = source.indexOf(startText);
  assert.ok(start !== -1, message || `${startText} block is present`);

  const end = endText ? source.indexOf(endText, start + startText.length) : -1;
  assert.ok(!endText || end !== -1, `${endText} marker follows ${startText}`);
  return source.slice(start, end === -1 ? undefined : end);
}

function extractTaggedBlockById(source, tagName, id) {
  const pattern = new RegExp(`<${tagName}\\b(?=[^>]*\\bid=["']${escapeRegExp(id)}["'])[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'i');
  const match = source.match(pattern);
  assert.ok(match, `${id} ${tagName} is present`);
  return match[0];
}

function extractFunctionBlock(source, functionName) {
  const functionMatch = new RegExp(`(?:async\\s+)?function\\s+${escapeRegExp(functionName)}\\s*\\(`).exec(source);
  assert.ok(functionMatch, `${functionName} function is present`);

  const openBrace = source.indexOf('{', functionMatch.index);
  assert.ok(openBrace !== -1, `${functionName} function body is present`);

  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(functionMatch.index, index + 1);
  }

  assert.fail(`${functionName} function body is closed`);
}

function assertLabelHasRequiredMarker(source, labelText) {
  const pattern = new RegExp(
    `<label\\b[^>]*>\\s*${escapeRegExp(labelText)}\\s*<span\\b[^>]*class=["'][^"']*\\brequired-marker\\b[^"']*["'][^>]*>\\s*\\*\\s*<\\/span>\\s*<\\/label>`,
    'i'
  );
  assertMatches(source, pattern, `${labelText} label shows a required marker`);
}

test('password revision rules reject weak passwords and accept a compliant password', () => {
  assert.equal(server.getPasswordValidationMessage('short'), 'Password must be at least 8 characters.');
  assert.equal(server.getPasswordValidationMessage('lowercase1!'), 'Password must include at least one uppercase letter.');
  assert.equal(server.getPasswordValidationMessage('UPPERCASE1!'), 'Password must include at least one lowercase letter.');
  assert.equal(server.getPasswordValidationMessage('NoNumber!'), 'Password must include at least one number.');
  assert.equal(server.getPasswordValidationMessage('NoSpecial1'), 'Password must include at least one special character.');
  assert.equal(server.getPasswordValidationMessage('StrongPass1!'), '');
});

test('public user response omits internal account fields', () => {
  const publicUser = server.toPublicUser({
    id: 7,
    role: 'patient',
    email: 'patient@example.com',
    display_name: 'Patient Name',
    displayName: 'Alternate Name',
    password_hash: 'secret-hash',
    google_sub: 'google-subject',
    status: 'active',
    email_verification_token: 'token',
  });

  assert.deepEqual(publicUser, {
    id: 7,
    role: 'patient',
    email: 'patient@example.com',
    displayName: 'Patient Name',
  });
});

test('Google token verifier maps invalid credentials to an auth error', () => {
  const script = `
    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    const server = require('./server.js');
    server.verifyGoogleIdToken('not-a-valid-google-token')
      .then(() => process.exit(2))
      .catch((err) => {
        console.log(String(err.statusCode) + ':' + err.message);
      });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, GOOGLE_CLIENT_ID: 'test-google-client-id' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /401:Invalid Google credential\./);
});

test('verification helpers create usable local verification data', () => {
  const token = server.createEmailVerificationToken();
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(server.getVerificationUrl({ protocol: 'http', get: () => 'localhost:3000', ip: '127.0.0.1' }, token), `http://localhost:3000/api/verify-email?token=${token}`);
});

test('registration page exposes required markers, password restrictions, optional mobile, and provider messaging', () => {
  const html = readProjectFile('register.html');
  assert.match(html, /required-marker/);
  assert.match(html, /Password restrictions/);
  assert.match(html, /Google email\/social media registration/);
  assert.match(html, /Mobile Number[\s\S]*\(optional\)/);
  assert.doesNotMatch(html, /id="mobile"[^>]*required/);
  assertIncludes(html, "let activeInviteToken = inviteToken || '';", 'Registration page tracks the currently valid invite token');
  assertIncludes(html, "activeInviteToken = '';", 'Registration page clears invalid or expired invite tokens');
  assertIncludes(html, 'inviteToken: activeInviteToken', 'Registration submit payload omits invalid or expired invite tokens');
  assertIncludes(html, 'checkInvite();', 'Registration page validates invite tokens on load');
  assert.doesNotMatch(html, /You can still register, but this token will not be used/, 'Registration page does not promise invalid invite tokens will be ignored while still submitting them');
});

test('frontend exposes Google Identity Services sign-in when configured', () => {
  const loginHtml = readProjectFile('login.html');
  const registerHtml = readProjectFile('register.html');
  const googleRegistrationHandler = extractFunctionBlock(registerHtml, 'handleGoogleRegistration');

  assertIncludes(loginHtml, 'https://accounts.google.com/gsi/client', 'Login page loads Google Identity Services script');
  assertIncludes(loginHtml, 'id="googleSignInPanel"', 'Login page has Google sign-in panel');
  assertIncludes(loginHtml, 'initializeGoogleSignIn', 'Login page initializes Google sign-in');
  assertIncludes(loginHtml, "fetch('/api/auth/google'", 'Login page posts Google credential to API');
  assertIncludes(registerHtml, 'id="googleRegistrationPanel"', 'Registration page has Google registration panel');
  assertIncludes(registerHtml, 'window.PROFELECT_GOOGLE_CLIENT_ID', 'Registration page checks Google client config');
  assertIncludes(registerHtml, "fetch('/api/auth/google'", 'Registration page posts Google credential to API');
  assertIncludes(googleRegistrationHandler, "document.getElementById('dataPrivacyConsent').checked", 'Google registration requires Data Privacy Act consent before API submission');
  assertIncludes(googleRegistrationHandler, 'You must consent to the Data Privacy Act of 2012.', 'Google registration shows the same privacy consent message as standard registration');
  assertIncludes(registerHtml, "privacyConsent: document.getElementById('dataPrivacyConsent').checked", 'Google registration sends checked privacy consent to API');
  assertIncludes(googleRegistrationHandler, "privacyConsent: document.getElementById('dataPrivacyConsent').checked", 'Google registration sends checked privacy consent from the Google handler');
});

test('doctor dashboard exposes additional custom slot options', () => {
  const html = readProjectFile('doctor-dashboard.html');
  assert.match(html, /Additional Slot Options/);
  assert.match(html, /customTimeSlots/);
  assert.match(html, /parseCustomTimeSlots/);
});

test('admin reports expose patient history, transaction status, and signature print fields', () => {
  const html = readProjectFile('admin-dashboard.html');
  assert.match(html, /patient-history/);
  assert.match(html, /Transaction ID/);
  assert.match(html, /Signature/);
  assert.match(html, /View \/ Print Report/);
  assert.match(html, /formatReportDateTime/);
});

test('database layer contains verification, consultation source, and patient history report helpers', () => {
  const dbSource = readProjectFile('db.js');
  assert.match(dbSource, /email_verification_token/);
  assert.match(dbSource, /email_verification_expires_at/);
  assert.match(dbSource, /consultation_source/);
  assert.match(dbSource, /getPatientHistoryReport/);
});

test('database layer supports Google account linking safely', () => {
  const dbSource = readProjectFile('db.js');
  const createUserFunction = extractBetween(dbSource, 'async function createUser', 'async function getUserByEmail', 'createUser function is present');

  assertIncludes(dbSource, 'ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;', 'Database adds google_sub column');
  assertIncludes(dbSource, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub', 'Database enforces unique non-null Google subject');
  assertIncludes(createUserFunction, 'googleSub = null', 'createUser accepts optional Google subject');
  assertIncludes(createUserFunction, 'google_sub', 'createUser persists Google subject');
  assertIncludes(dbSource, 'async function getUserByGoogleSub(googleSub)', 'Database can look up users by Google subject');
  assertIncludes(dbSource, 'async function linkUserGoogleSub(userId, googleSub)', 'Database can link Google subject to existing user');
  assertIncludes(dbSource, 'getUserByGoogleSub,', 'Google lookup helper is exported');
  assertIncludes(dbSource, 'linkUserGoogleSub,', 'Google linking helper is exported');
});

test('server implements Google Identity Services auth safely', () => {
  const serverSource = readProjectFile('server.js');
  const googleRoute = extractRouteBlock(serverSource, "app.post('/api/auth/google'", 'Google auth route is present');
  const verifyGoogleIdToken = extractFunctionBlock(serverSource, 'verifyGoogleIdToken');

  assertIncludes(serverSource, 'const { OAuth2Client } = require(\'google-auth-library\');', 'Server imports OAuth2Client');
  assertIncludes(serverSource, 'const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || \'\';', 'Server reads Google client ID from env');
  assertIncludes(verifyGoogleIdToken, 'verifyIdToken', 'Server verifies Google ID token');
  assertIncludes(verifyGoogleIdToken, 'audience: GOOGLE_CLIENT_ID', 'Google token audience must match configured client ID');
  assertIncludes(verifyGoogleIdToken, 'Invalid Google credential.', 'Google verifier maps invalid Google tokens to auth errors');
  assertIncludes(verifyGoogleIdToken, "typeof payload.sub !== 'string'", 'Google verifier rejects non-string subject');
  assertIncludes(verifyGoogleIdToken, "typeof payload.email !== 'string'", 'Google verifier rejects non-string email payloads');
  assertIncludes(verifyGoogleIdToken, '!isValidEmail(payload.email)', 'Google verifier rejects invalid Google email payloads');
  assertIncludes(googleRoute, "typeof req.body.credential !== 'string'", 'Google auth rejects non-string credentials before verification');
  assertIncludes(googleRoute, 'db.getUserByGoogleSub', 'Google auth first checks linked Google subject');
  assertIncludes(googleRoute, 'db.getUserByEmail', 'Google auth can link existing clinic-created account by email');
  assertIncludes(googleRoute, "role: 'patient'", 'New Google users are patients only');
  assertIncludes(googleRoute, 'req.body.privacyConsent !== true', 'New Google patient accounts require explicit privacy consent');
  assertIncludes(googleRoute, 'Data privacy consent is required.', 'Google auth rejects new patient creation without privacy consent');
  assertIncludes(googleRoute, 'emailVerified: true', 'Google-verified email is trusted as verified');
  assertIncludes(googleRoute, "status: 'pending'", 'New Google patients still require admin approval');
  assert.doesNotMatch(googleRoute, /createPatientProfile/, 'Google auth does not create patient profile data');
  assertIncludes(googleRoute, 'user: toPublicUser(user)', 'Google auth responses return sanitized users');
});

test('admin-created accounts use the shared password policy', () => {
  const source = readProjectFile('server.js');
  const adminUsersRoute = extractRouteBlock(source, "app.post('/api/admin/users'", 'Admin create-user route is present');

  assertIncludes(adminUsersRoute, 'const passwordMessage = getPasswordValidationMessage(password);', 'Admin create-user route validates passwords with shared helper');
  assertIncludes(adminUsersRoute, 'return res.status(400).json({ success: false, message: passwordMessage });', 'Admin create-user route returns the shared password validation message');
  assertIncludes(adminUsersRoute, 'emailVerified: true', 'Admin-created users are trusted as email verified');
  assert.doesNotMatch(adminUsersRoute, /emailVerified:\s*role\s*!==\s*['"]patient['"]/, 'Admin-created patient accounts do not reuse self-registration verification state');
});

test('admin add-user form shows required markers and password rules', () => {
  const html = readProjectFile('admin-dashboard.html');
  const adminAddUserForm = extractTaggedBlockById(html, 'form', 'adminAddUserForm');

  ['Role', 'Email', 'Password', 'Display Name'].forEach((label) => assertLabelHasRequiredMarker(adminAddUserForm, label));
  assertMatches(adminAddUserForm, /<input\b(?=[^>]*\bid=["']addUserPassword["'])(?=[^>]*\bminlength=["']8["'])[^>]*>/i, 'addUserPassword requires minlength 8');
  assertIncludes(adminAddUserForm, 'Password restrictions:', 'Admin add-user form explains password restrictions');
});

test('admin reports support all matching transactions and padded statuses', () => {
  const dbSource = readProjectFile('db.js');
  const serverSource = readProjectFile('server.js');
  const html = readProjectFile('admin-dashboard.html');
  const reportFunction = extractBetween(dbSource, 'async function getAdminReportData', 'async function getAllEMRRecords', 'Admin report data function is present');
  const adminReportRoute = extractRouteBlock(serverSource, "app.get('/api/admin/reports/:type'", 'Admin report route is present');

  assertMatches(reportFunction, /async function getAdminReportData\(\{\s*search\s*=\s*'',\s*startDate\s*=\s*'',\s*endDate\s*=\s*'',\s*includeAllConsultations\s*=\s*false\s*\}\s*=\s*\{\}\)/, 'Admin reports accept includeAllConsultations option');
  assertMatches(reportFunction, /\$\{\s*includeAllConsultations\s*\?\s*''\s*:\s*'LIMIT 14'\s*\}/, 'Admin report daily trend removes the row limit for full consultation reports');
  assertMatches(reportFunction, /\$\{\s*includeAllConsultations\s*\?\s*''\s*:\s*'LIMIT 10'\s*\}/, 'Admin report consultation details remove the row limit for full consultation reports');
  assertIncludes(dbSource, "const KNOWN_CONSULTATION_STATUSES = ['pending', 'under-review', 'scheduled', 'completed', 'denied', 'cancelled', 'marked-no-show'];", 'Database defines known consultation statuses for report padding');
  assertMatches(reportFunction, /byStatus:\s*padCountRows\(consultationStatusCounts,\s*KNOWN_CONSULTATION_STATUSES\)/, 'Consultation status report pads known statuses');
  assertIncludes(adminReportRoute, "includeAllConsultations: type === 'consultations'", 'Admin report route requests all matching consultation rows for consultation reports');
  assertIncludes(html, 'All Matching Transactions', 'Consultation report labels the full matching transaction list');
  assertMatches(html, /function formatReportFullDateTime\b/, 'Admin reports define the full date-time formatter');
});

test('walk-in capture is wired from staff UI to backend and reports', () => {
  const serverSource = readProjectFile('server.js');
  const dbSource = readProjectFile('db.js');
  const staffHtml = readProjectFile('staff.html');
  const adminHtml = readProjectFile('admin-dashboard.html');
  const staffConsultationRoute = extractRouteBlock(serverSource, "app.post('/api/staff/consultations'", 'Staff walk-in consultation route is present');
  const createConsultationFunction = extractBetween(dbSource, 'async function createConsultation', 'const ACTIVE_CONSULTATION_STATUS_SQL', 'DB createConsultation function is present');
  const submitWalkInConsultation = extractFunctionBlock(staffHtml, 'submitWalkInConsultation');

  assertIncludes(staffConsultationRoute, "consultationSource: 'walk-in'", 'Staff route marks created consultations as walk-in');
  assertIncludes(staffConsultationRoute, 'const DATE_ONLY_PATTERN = /^\\d{4}-\\d{2}-\\d{2}$/;', 'Walk-in route validates date format');
  assertIncludes(staffConsultationRoute, 'const TIME_PATTERN = /^([01]\\d|2[0-3]):[0-5]\\d$/;', 'Walk-in route validates time format');
  assertIncludes(staffConsultationRoute, 'const isScheduledWalkIn = Boolean(consultationDate && consultationTime);', 'Walk-in route schedules only when date and start time are supplied');
  assertIncludes(staffConsultationRoute, "if (consultationTime && !consultationDate)", 'Walk-in route rejects start times without dates');
  assertIncludes(staffConsultationRoute, "if (consultationTimeEnd && !consultationTime)", 'Walk-in route rejects end times without start times');
  assertIncludes(staffConsultationRoute, 'if (consultationTimeEnd && consultationTimeEnd <= consultationTime)', 'Walk-in route rejects end times before start times');
  assertIncludes(staffConsultationRoute, 'if (isScheduledWalkIn)', 'Walk-in route runs schedule checks only for fully scheduled walk-ins');
  assertIncludes(staffConsultationRoute, 'const availability = await db.getDoctorAvailability();', 'Scheduled walk-in route loads published doctor availability');
  assertMatches(staffConsultationRoute, /slot\.available_date\s*===\s*consultationDate/, 'Scheduled walk-in route matches availability by requested date');
  assertIncludes(staffConsultationRoute, "JSON.parse(slot.available_time_slots || '[]')", 'Scheduled walk-in route parses published availability slots');
  assertIncludes(staffConsultationRoute, 'slots.includes(consultationTime)', 'Scheduled walk-in route requires the requested start time in published availability');
  assert.ok(
    staffConsultationRoute.indexOf('const availability = await db.getDoctorAvailability();') < staffConsultationRoute.indexOf('await ensureDoctorDailyCapacity'),
    'Scheduled walk-in route checks published availability before capacity checks'
  );
  assertMatches(staffConsultationRoute, /consultationDate:\s*isScheduledWalkIn \? consultationDate : null/, 'Walk-in route does not persist date-only partial schedules');
  assertMatches(staffConsultationRoute, /status:\s*isScheduledWalkIn \? 'scheduled' : 'pending'/, 'Walk-in route keeps unscheduled walk-ins pending');
  assertMatches(createConsultationFunction, /async function createConsultation\(\{\s*patientId,\s*doctorId,\s*concerns,\s*consultationDate,\s*consultationTime,\s*consultationTimeEnd,\s*consultationSource\s*=\s*'online',\s*status\s*=\s*'pending'\s*\}\)/, 'DB createConsultation accepts end time and status');
  assertIncludes(createConsultationFunction, 'consultation_time_end', 'DB createConsultation persists consultation end time');
  assertIncludes(createConsultationFunction, 'status: normalizedStatus', 'DB createConsultation returns the normalized status');
  assertIncludes(staffHtml, 'data-view="walkin"', 'Staff UI exposes the walk-in tab');
  const walkInForm = extractTaggedBlockById(staffHtml, 'form', 'walkInForm');
  ['patientId', 'doctorId', 'consultationDate', 'consultationTime', 'consultationTimeEnd', 'concerns'].forEach((fieldName) => {
    assertMatches(walkInForm, new RegExp(`<(?:input|textarea)\\b(?=[^>]*\\bname=["']${fieldName}["'])`, 'i'), `Walk-in form includes ${fieldName} field`);
  });
  assertMatches(staffHtml, /document\.getElementById\(\s*['"]walkInForm['"]\s*\)\??\.addEventListener\(\s*['"]submit['"]\s*,\s*submitWalkInConsultation\s*\)/, 'Walk-in form submit event is handled by submitWalkInConsultation');
  assertMatches(submitWalkInConsultation, /apiRequest\(\s*['"`]\/api\/staff\/consultations['"`]/, 'Walk-in handler calls the staff consultations endpoint');
  assertMatches(submitWalkInConsultation, /method:\s*['"]POST['"]/, 'Walk-in handler POSTs to the staff consultations endpoint');
  assertMatches(staffHtml, /function setMessage\(message,\s*type\s*=\s*['"]error['"]\)/, 'Staff messages support typed visual states');
  assertIncludes(staffHtml, ".notice.success", 'Staff success messages have a non-danger visual state');
  assertIncludes(adminHtml, "value === 'walk-in' ? 'Walk-in' : 'Online scheduled'", 'Admin reports display walk-in consultation sources');
});

test('ci workflow runs install syntax tests and build', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');
  assertIncludes(workflow, 'npm --prefix EMRsystem install', 'CI installs EMRsystem dependencies');
  assertIncludes(workflow, 'npm --prefix EMRsystem run check:syntax', 'CI runs syntax checks');
  assertIncludes(workflow, 'npm --prefix EMRsystem test', 'CI runs EMRsystem tests');
  assertIncludes(workflow, 'npm --prefix EMRsystem run build', 'CI verifies static build');
});

test('admin reports filter user and security sections and normalize statuses', () => {
  const dbSource = readProjectFile('db.js');
  const serverSource = readProjectFile('server.js');
  const reportFunction = extractBetween(dbSource, 'async function getAdminReportData', 'async function getAllEMRRecords', 'Admin report data function is present');
  const diagnosticFunction = extractBetween(dbSource, 'async function getDiagnosticReportData', 'async function getAllConsultations', 'Diagnostic report data function is present');
  const staffScheduleRoute = extractRouteBlock(serverSource, "app.put('/api/consultations/:id/schedule'", 'Staff schedule route is present');
  const doctorUpdateRoute = extractRouteBlock(serverSource, "app.put('/api/doctor/consultation/:id'", 'Doctor update route is present');

  assertIncludes(reportFunction, 'const userWhere = userConditions.length', 'Admin reports build a user filter scope');
  assertIncludes(reportFunction, 'FROM users u', 'Admin user reports use an aliased users table for filtering');
  assertIncludes(reportFunction, 'const passwordResetWhere = passwordResetConditions.length', 'Admin reports build a password-reset filter scope');
  assertIncludes(reportFunction, 'FROM password_reset_requests pr', 'Admin security reports filter password reset rows');
  assertIncludes(reportFunction, 'const inviteWhere = inviteConditions.length', 'Admin reports build an invite filter scope');
  assertIncludes(reportFunction, 'FROM invites i', 'Admin security reports filter invite rows');
  assertIncludes(reportFunction, 'const notificationWhere = notificationConditions.length', 'Admin reports build a notification filter scope');
  assertIncludes(reportFunction, 'FROM notifications n', 'Admin security reports filter notification rows');
  assertMatches(reportFunction, /const userRoleCounts = await getAll\(`\s*SELECT u\.role AS role,[\s\S]*?FROM users u[\s\S]*?\$\{userWhere\}[\s\S]*?`,\s*userParams\);/, 'userRoleCounts uses user filter');
  assertMatches(reportFunction, /const userStatusCounts = await getAll\(`\s*SELECT u\.status AS status,[\s\S]*?FROM users u[\s\S]*?\$\{userWhere\}[\s\S]*?`,\s*userParams\);/, 'userStatusCounts uses user filter');
  assertMatches(reportFunction, /const recentUsers = await getAll\(`\s*SELECT u\.id,[\s\S]*?FROM users u[\s\S]*?\$\{userWhere\}[\s\S]*?`,\s*userParams\);/, 'recentUsers uses user filter');
  assertMatches(reportFunction, /const passwordResetCounts = await getAll\(`\s*SELECT pr\.status AS status,[\s\S]*?FROM password_reset_requests pr[\s\S]*?\$\{passwordResetWhere\}[\s\S]*?`,\s*passwordResetParams\);/, 'password resets use filter');
  assertMatches(reportFunction, /const inviteCounts = await getAll\(`\s*SELECT[\s\S]*?FROM invites i[\s\S]*?\$\{inviteWhere\}[\s\S]*?`,\s*inviteParams\);/, 'invites use filter');
  assertMatches(reportFunction, /const notificationCounts = await getAll\(`\s*SELECT n\.type,[\s\S]*?FROM notifications n[\s\S]*?\$\{notificationWhere\}[\s\S]*?`,\s*notificationParams\);/, 'notifications use filter');
  assertMatches(reportFunction, /const totalUsers = \(await get\(`SELECT COUNT\(\*\) AS count FROM users u \$\{userWhere\}`,\s*userParams\)\)\.count \|\| 0;/, 'totalUsers uses user filter');
  const normalizeStatusFunction = extractFunctionBlock(serverSource, 'normalizeConsultationStatus');

  assertIncludes(normalizeStatusFunction, "if (value === 'approved') return 'scheduled';", 'approved maps to scheduled');
  assertIncludes(normalizeStatusFunction, "if (value === 'rejected') return 'denied';", 'rejected maps to denied');
  assertIncludes(normalizeStatusFunction, "if (['no-show', 'no_show'].includes(value)) return 'marked-no-show';", 'no-show maps to marked-no-show');
  assertIncludes(staffScheduleRoute, 'const normalizedStatus = normalizeConsultationStatus(status) || \'scheduled\';', 'Staff schedule route normalizes statuses');
  assertIncludes(staffScheduleRoute, 'status: normalizedStatus', 'Staff schedule writes normalized status');
  assertIncludes(doctorUpdateRoute, 'const normalizedStatus = normalizeConsultationStatus(status);', 'Doctor update route uses shared status normalization');
  assertIncludes(doctorUpdateRoute, 'updates.status = normalizedStatus', 'Doctor update writes normalized status');
  assertMatches(diagnosticFunction, /consultationStatus:\s*padCountRows\(consultationStatus,\s*KNOWN_CONSULTATION_STATUSES\)/, 'Doctor diagnostic report pads known consultation statuses');
});

test('review evidence documents are present and pending adviser confirmation', () => {
  const systemReview = readRepoFile('docs/review/adviser-panel-system-document-review.md');
  const titleReview = readRepoFile('docs/review/title-revision-discussion.md');
  const changesApproval = readRepoFile('docs/review/incorporated-changes-approval.md');

  assertIncludes(systemReview, 'Status: Pending adviser confirmation', 'System/document review evidence is pending, not fabricated');
  assertIncludes(systemReview, 'System Demonstration Checklist', 'System review doc includes a demonstration checklist');
  assertIncludes(titleReview, 'Status: Pending adviser confirmation', 'Title revision evidence is pending, not fabricated');
  assertIncludes(titleReview, 'Title Revision Discussion Log', 'Title revision doc includes discussion log section');
  assertIncludes(changesApproval, 'Status: Pending adviser confirmation', 'Change approval evidence is pending, not fabricated');
  assertIncludes(changesApproval, 'Implemented Change Matrix', 'Change approval doc maps changes to implementation evidence');
});

test('patient self-registration is staged before medical profile persistence', () => {
  const serverSource = readProjectFile('server.js');
  const registerRoute = extractRouteBlock(serverSource, "app.post('/api/register'", 'Registration route is present');
  const adminStatusRoute = extractRouteBlock(serverSource, "app.post('/api/admin/users/:id/status'", 'Admin status route is present');
  const registerHtml = readProjectFile('register.html');
  const registrationPayload = extractBetween(registerHtml, 'const payload = {', "const resp = await apiFetch('/api/register'", 'Registration submit payload is present before api/register');

  assert.ok(
    registerRoute.indexOf('const verificationUrl = role === \'patient\' ? getVerificationUrl(req, verificationToken) : null;') < registerRoute.indexOf('const user = await db.createUser'),
    'Registration validates verification URL before creating the pending user'
  );
  assertIncludes(serverSource, 'function shouldExposeLocalVerificationLink(req)', 'Server gates local verification link exposure');
  assertIncludes(registerRoute, 'shouldExposeLocalVerificationLink(req) ? verificationUrl : undefined', 'Registration only returns verification URL for local no-SMTP testing');
  assertIncludes(registerRoute, 'privacyConsent', 'Registration route requires privacy consent input');
  assertIncludes(registerRoute, 'req.body.privacyConsent !== true', 'Public registration requires strict boolean privacy consent');
  assertIncludes(registerRoute, 'sendAccountEmail({', 'Registration route sends verification through local-first email adapter');
  assertIncludes(registerRoute, "if (role !== 'patient')", 'Public registration only accepts patient self-registration');
  assertIncludes(registerRoute, 'Only patient self-registration is available publicly.', 'Public registration rejects privileged role creation');
  assert.doesNotMatch(registerRoute, /const allowedRoles = \['admin', 'doctor', 'patient', 'staff'\]/, 'Public registration does not allow privileged roles');
  assertIncludes(registerRoute, 'emailVerified: false', 'Public patient registration starts unverified');
  assertIncludes(registerRoute, "status: 'pending'", 'Public patient registration starts pending');
  assertIncludes(registerRoute, 'user: toPublicUser(user)', 'Registration response returns sanitized user data');
  assert.doesNotMatch(registerRoute, /\n\s*user,\s*\n/, 'Registration response does not return raw createUser result with verification token');
  assert.doesNotMatch(registerRoute, /db\.createPatientProfile\(/, 'Self-registration does not save patient profile details before verification and approval');
  assertIncludes(serverSource, "app.post('/api/patient/profile-completion'", 'Patient profile completion endpoint exists');
  assertIncludes(adminStatusRoute, 'email_verified', 'Admin activation checks patient email verification state');
  assertIncludes(adminStatusRoute, 'Verify the patient email before activating this account.', 'Admin activation rejects unverified self-registered patients');
  assertIncludes(registerHtml, 'Account Verification First', 'Registration page explains staged account verification first');
  assert.doesNotMatch(registrationPayload, /\b(?:firstName|lastName|dateOfBirth|securityQuestion|securityAnswer)\s*:/, 'Registration payload no longer submits medical identity fields to api/register');
});

test('patient profile completion fixes SQL and validates medical identity fields', () => {
  const dbSource = readProjectFile('db.js');
  const serverSource = readProjectFile('server.js');
  const createPatientProfile = extractBetween(dbSource, 'async function createPatientProfile', 'async function createConsultation', 'createPatientProfile function is present');
  const patientInsertColumns = extractBetween(createPatientProfile, 'INSERT INTO patients (', ') VALUES', 'Patient insert column list is present');
  const completionRoute = extractRouteBlock(serverSource, "app.post('/api/patient/profile-completion'", 'Patient profile completion route is present');
  const validationFunction = extractFunctionBlock(serverSource, 'getPatientInputValidationMessage');
  const profileUpdateRoute = extractRouteBlock(serverSource, "app.put('/api/profile'", 'Patient profile update route is present');
  const updatePatientProfileFunction = extractBetween(dbSource, 'async function updatePatientProfile', 'async function createPatientAssessment', 'updatePatientProfile function is present');
  const dashboardHtml = readProjectFile('dashboard.html');
  const adminHtml = readProjectFile('admin-dashboard.html');
  const adminUsersRoute = extractRouteBlock(serverSource, "app.post('/api/admin/users'", 'Admin create-user route is present');

  assert.doesNotMatch(patientInsertColumns, /mobile \|\| null,/, 'Patient insert column list uses mobile column, not mobile expression');
  assertMatches(patientInsertColumns, /\n\s+mobile,\s*\n\s+date_of_birth,/, 'Patient insert column list includes mobile before date_of_birth');
  assertMatches(createPatientProfile, /\n\s+mobile \|\| null,\s*\n\s+dateOfBirth,/, 'Patient insert parameters store optional mobile as null value');
  assertIncludes(completionRoute, 'requireActiveVerifiedPatient(userId)', 'Profile completion requires active verified patient account');
  assertIncludes(completionRoute, 'const existingProfile = await db.getPatientProfile(userId);', 'Profile completion prevents duplicate profiles');
  assertIncludes(completionRoute, 'calculateAge(dateOfBirth)', 'Profile completion derives age server-side');
  assertIncludes(validationFunction, 'allowedSexValues', 'Patient validation restricts sex values');
  assertIncludes(validationFunction, 'allowedCivilStatusValues', 'Patient validation restricts civil status values');
  assertIncludes(validationFunction, 'Date of birth must be a valid calendar date.', 'Patient validation checks real calendar dates');
  assertIncludes(validationFunction, 'Address must be 200 characters or fewer.', 'Patient validation length-limits address');
  assertIncludes(validationFunction, 'Security answer must be 120 characters or fewer.', 'Patient validation length-limits security answer');
  assertIncludes(serverSource, 'const allowedPatientProfileUpdateFields', 'Server defines patient profile update allowlist');
  assertIncludes(serverSource, 'function normalizePatientProfileUpdates', 'Server normalizes patient profile updates before DB writes');
  assertIncludes(profileUpdateRoute, 'normalizePatientProfileUpdates', 'Profile update route validates and normalizes updates');
  assertIncludes(profileUpdateRoute, 'db.updatePatientProfile(userId, normalizedUpdates)', 'Profile update route sends only normalized updates to DB');
  assertIncludes(updatePatientProfileFunction, 'allowedPatientProfileUpdateColumns', 'DB profile update helper has allowed column list');
  assertIncludes(updatePatientProfileFunction, 'Unknown patient profile field', 'DB rejects unknown profile update columns');
  assert.doesNotMatch(dashboardHtml, /id="mobile"[^>]*required/, 'Profile edit mobile field is optional');
  assertIncludes(adminHtml, 'Mobile Number (optional)', 'Admin patient creation labels mobile optional');
  assert.doesNotMatch(adminUsersRoute, /mobile,\s*dateOfBirth/, 'Admin-created patients no longer require mobile before date of birth');
});

test('registration lifecycle reminders and local-first identity notifications are implemented', () => {
  const serverSource = readProjectFile('server.js');
  const dbSource = readProjectFile('db.js');
  const loginRoute = extractRouteBlock(serverSource, "app.post('/api/login'", 'Login route is present');
  const notificationsRoute = extractRouteBlock(serverSource, "app.get('/api/notifications'", 'Notifications route is present');
  const adminUsersRoute = extractRouteBlock(serverSource, "app.get('/api/admin/users'", 'Admin users route is present');
  const verifyRoute = extractRouteBlock(serverSource, "app.get('/api/verify-email'", 'Verify email route is present');
  const lifecycleFunction = extractFunctionBlock(serverSource, 'enforcePatientRegistrationLifecycle');
  const emailAdapter = extractFunctionBlock(serverSource, 'sendAccountEmail');
  const apiPublicUrlFunction = extractFunctionBlock(serverSource, 'getApiPublicUrl');
  const isLocalRequestFunction = extractFunctionBlock(serverSource, 'isLocalRequest');
  const localVerificationHelper = extractFunctionBlock(serverSource, 'shouldExposeLocalVerificationLink');
  const verificationUrlFunction = extractFunctionBlock(serverSource, 'getVerificationUrl');
  const verificationResultPageFunction = extractFunctionBlock(serverSource, 'renderEmailVerificationResultPage');
  const sendVerificationResultFunction = extractFunctionBlock(serverSource, 'sendEmailVerificationResult');

  assertIncludes(serverSource, "const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || '').replace(/\\/$/, '');", 'Server reads API_PUBLIC_URL separately from FRONTEND_URL');
  assertIncludes(isLocalRequestFunction, 'remoteAddress', 'Local request detection checks the remote address, not only Host');
  assertIncludes(isLocalRequestFunction, "host === 'localhost'", 'Local request detection allows localhost host');
  assertIncludes(isLocalRequestFunction, "host === '127.0.0.1'", 'Local request detection allows loopback host');
  assertIncludes(isLocalRequestFunction, "remoteAddress === '::1'", 'Local request detection allows IPv6 loopback');
  assertIncludes(isLocalRequestFunction, "remoteAddress.startsWith('127.')", 'Local request detection allows IPv4 loopback range');
  assertIncludes(apiPublicUrlFunction, 'isLocalRequest(req)', 'Verification URL host fallback requires a local request');
  assertIncludes(apiPublicUrlFunction, 'API_PUBLIC_URL is required for non-local verification links.', 'Verification URL fails closed when API_PUBLIC_URL is missing outside local testing');
  assertIncludes(localVerificationHelper, '!hasSmtpConfig() && isLocalRequest(req)', 'Local verification link exposure requires no SMTP and local request');
  assertIncludes(verificationUrlFunction, 'API_PUBLIC_URL', 'Verification URLs prefer API_PUBLIC_URL');
  assertIncludes(verificationResultPageFunction, 'login.html', 'Email verification result page redirects users to login');
  assertIncludes(verificationResultPageFunction, '<meta http-equiv="refresh"', 'Email verification result page auto-redirects in browser');
  assertIncludes(sendVerificationResultFunction, 'renderEmailVerificationResultPage', 'Email verification helper renders browser-friendly result page');
  assertIncludes(sendVerificationResultFunction, "req.accepts('html')", 'Email verification helper detects browser requests');
  assertIncludes(verifyRoute, 'sendEmailVerificationResult', 'Email verification route uses browser-friendly result helper');
  assertIncludes(emailAdapter, 'createTransport', 'Email adapter creates SMTP transport when configured');
  assertIncludes(emailAdapter, 'SMTP is not configured', 'Email adapter keeps honest local fallback when SMTP is missing');
  assertIncludes(emailAdapter, 'safeLocalMessage', 'Local email fallback stores a sanitized notification message');
  assertIncludes(emailAdapter, 'Email delivery is not available.', 'Local email fallback does not store secret email contents');
  assert.doesNotMatch(emailAdapter, /db\.createNotification\(\{ userId, type, message \}\)/, 'Local email fallback does not store verification URLs or reset tokens in notifications');
  assertIncludes(emailAdapter, 'localNotification: false', 'Email adapter reports no local fallback when SMTP delivery succeeds');
  assertIncludes(serverSource, 'const REGISTRATION_EXPIRY_HOURS = 24;', 'Registration expiry is set to 24 hours');
  assertIncludes(serverSource, 'const REGISTRATION_REMINDER_HOURS = 20;', 'Registration reminder threshold is explicit');
  assertIncludes(lifecycleFunction, 'db.getPatientRegistrationsForReminder', 'Lifecycle helper loads reminder candidates');
  assertIncludes(lifecycleFunction, 'registration_confirmation_reminder', 'Lifecycle helper creates reminder notifications');
  assertIncludes(lifecycleFunction, 'db.getExpiredPatientRegistrations', 'Lifecycle helper loads expired unverified registrations');
  assertIncludes(lifecycleFunction, 'db.markUserRegistrationForfeited', 'Lifecycle helper forfeits expired registrations');
  assertIncludes(dbSource, 'async function getPatientRegistrationsForReminder', 'Database exposes reminder candidate query');
  assertIncludes(dbSource, 'async function getExpiredPatientRegistrations', 'Database exposes expired registration query');
  assertIncludes(loginRoute, 'await enforcePatientRegistrationLifecycle();', 'Login triggers lifecycle enforcement');
  assertIncludes(notificationsRoute, 'await enforcePatientRegistrationLifecycle();', 'Notifications trigger lifecycle enforcement');
  assertIncludes(adminUsersRoute, 'await enforcePatientRegistrationLifecycle();', 'Admin user list triggers lifecycle enforcement');
  assertIncludes(verifyRoute, 'await enforcePatientRegistrationLifecycle();', 'Email verification triggers lifecycle enforcement');
  assertIncludes(emailAdapter, 'SMTP is not configured', 'Email adapter honestly reports local-first fallback');
  assertIncludes(emailAdapter, 'db.createNotification({', 'Email adapter creates local notification fallback');
  assert.doesNotMatch(serverSource, /SMTP_PASS\s*=\s*['"][^'"]+['"]/, 'No hardcoded SMTP password is present');
  assert.doesNotMatch(serverSource, /GOOGLE_CLIENT_SECRET\s*=\s*['"][^'"]+['"]/, 'No hardcoded Google client secret is present');
});

test('deployment config uses API_PUBLIC_URL, SMTP, Google client ID, and secret-free examples', () => {
  const apiConfig = readProjectFile('api-config.js');
  const envExample = readProjectFile('.env.example');
  const deploymentDoc = readProjectFile('DEPLOYMENT.md');
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const pythonRequirementsPath = path.join(projectDir, 'requirements.txt');
  const deploymentRequirementsPath = path.join(projectDir, 'REQUIREMENTS.md');

  assertIncludes(apiConfig, 'window.PROFELECT_GOOGLE_CLIENT_ID', 'Frontend exposes Google client ID config');
  assertIncludes(envExample, 'API_PUBLIC_URL=https://RENDER_SERVICE_HOST.onrender.com', 'Env example documents API public URL');
  assertIncludes(envExample, 'FRONTEND_URL=https://VERCEL_FRONTEND_HOST.vercel.app', 'Env example documents frontend URL');
  assertIncludes(envExample, 'DATABASE_URL=postgresql://USERNAME:PASSWORD@HOST:5432/DATABASE?sslmode=require', 'Env example uses placeholder database URL');
  assert.doesNotMatch(envExample, /neondb_owner|npg_[A-Za-z0-9]+|ap-southeast-1\.aws\.neon\.tech/, 'Env example does not contain real-looking Neon credentials');
  assertIncludes(deploymentDoc, 'API_PUBLIC_URL', 'Deployment docs explain API_PUBLIC_URL');
  assertIncludes(deploymentDoc, 'GOOGLE_CLIENT_ID', 'Deployment docs explain Google client ID');
  assertIncludes(deploymentDoc, 'SMTP_HOST', 'Deployment docs explain SMTP configuration');
  assert.ok(packageJson.dependencies.nodemailer, 'Package includes nodemailer dependency');
  assert.ok(packageJson.dependencies['google-auth-library'], 'Package includes google-auth-library dependency');
  assert.ok(!fs.existsSync(pythonRequirementsPath), 'Deployment docs must not use requirements.txt because Railway detects it as Python');
  assert.ok(fs.existsSync(deploymentRequirementsPath), 'System requirements documentation is kept as markdown');
});

test('public and patient QR codes expire and can be regenerated', () => {
  const serverSource = readProjectFile('server.js');
  const dbSource = readProjectFile('db.js');
  const indexHtml = readProjectFile('index.html');
  const dashboardHtml = readProjectFile('dashboard.html');
  const doctorHtml = readProjectFile('doctor-dashboard.html');
  const publicQrRoute = extractRouteBlock(serverSource, "app.get('/api/public-registration-qr'", 'Public registration QR route is present');
  const publicQrRegenerateRoute = extractRouteBlock(serverSource, "app.post('/api/public-registration-qr/regenerate'", 'Public registration QR regeneration route is present');
  const myQrRoute = extractRouteBlock(serverSource, "app.get('/api/my-qr'", 'Patient QR route is present');
  const patientQrRoute = extractRouteBlock(serverSource, "app.get('/api/patient-qr/:token'", 'Patient QR validation route is present');
  const openPatientFromQrText = extractFunctionBlock(doctorHtml, 'openPatientFromQrText');

  assertIncludes(publicQrRoute, 'db.createInvite({ token, expiresAt, createdBy: null })', 'Public QR creates expiring invite token');
  assert.doesNotMatch(publicQrRoute, /revokePublicRegistrationInvites/, 'Public QR GET does not mutate existing public QR tokens');
  assertIncludes(publicQrRegenerateRoute, 'db.revokePublicRegistrationInvites()', 'Public QR POST regeneration invalidates previous unused public QR tokens');
  assertIncludes(publicQrRoute, 'register.html?token=', 'Public QR points to tokenized registration URL');
  assertIncludes(publicQrRoute, 'expiresAt', 'Public QR response includes expiry metadata');
  assertIncludes(dbSource, 'async function revokePublicRegistrationInvites', 'Database can revoke existing public registration invites');
  assertIncludes(indexHtml, 'id="qrExpiresAt"', 'Index page displays public QR expiry');
  assert.doesNotMatch(indexHtml, /id="regenerateQr"/, 'Public landing page does not expose unauthenticated QR invalidation control');
  assertIncludes(publicQrRegenerateRoute, 'requesterId', 'Public QR regeneration requires requester identity');
  assertIncludes(publicQrRegenerateRoute, 'requesterPassword', 'Public QR regeneration requires requester password re-authentication');
  assertIncludes(publicQrRegenerateRoute, 'db.validateCredentials(user.email, requesterPassword)', 'Public QR regeneration verifies requester credentials before revocation');
  assertIncludes(publicQrRegenerateRoute, 'String(authenticatedRequester.id) !== String(user.id)', 'Public QR regeneration credential check must match requester identity');
  assertIncludes(publicQrRegenerateRoute, "['admin', 'staff'].includes(user.role)", 'Public QR regeneration is restricted to admin or staff users');
  assertIncludes(dbSource, 'CREATE TABLE IF NOT EXISTS patient_qr_tokens', 'Database creates persistent patient QR token table');
  assertIncludes(dbSource, 'async function createPatientQrToken', 'Database creates patient QR tokens');
  assertIncludes(dbSource, 'async function getPatientQrToken', 'Database validates patient QR tokens');
  assertIncludes(dbSource, 'async function revokePatientQrTokens', 'Database revokes old patient QR tokens');
  assertIncludes(serverSource, 'async function requireQrRequesterAccess(requesterId, patientId)', 'Server defines QR requester authorization gate');
  assertIncludes(myQrRoute, 'requirePatientProfileReady(userId)', 'Patient QR requires active verified patient profile');
  assertIncludes(myQrRoute, 'String(requesterId) !== String(userId)', 'Patient QR minting requires requester to match the patient');
  assertIncludes(myQrRoute, 'db.createPatientQrToken', 'Patient QR route creates expiring token');
  assertIncludes(myQrRoute, 'expiresAt', 'Patient QR response includes expiry metadata');
  assertIncludes(serverSource, "app.get('/api/patient-qr/:token'", 'Patient QR validation endpoint exists');
  assertIncludes(patientQrRoute, 'await requirePatientProfileReady(qrToken.patient_id)', 'Patient QR validation re-checks current patient readiness');
  assertIncludes(patientQrRoute, 'await requireQrRequesterAccess(requesterId, qrToken.patient_id)', 'Patient QR validation requires authorized requester identity');
  assertIncludes(dashboardHtml, 'requesterId=${authUser.id}', 'Patient dashboard includes requester identity when minting patient QR codes');
  assertIncludes(doctorHtml, 'function getPatientQrTokenFromText', 'Doctor dashboard parses tokenized patient QR payloads');
  assertIncludes(doctorHtml, '/api/patient-qr/${encodeURIComponent(token)}', 'Doctor dashboard validates patient QR tokens before opening records');
  assertIncludes(doctorHtml, 'requesterId=${encodeURIComponent(authUser.id)}', 'Doctor dashboard includes requester identity when validating patient QR codes');
  assertMatches(openPatientFromQrText, /await\s+getPatientIdFromQrText\(value\)/, 'Doctor dashboard waits for QR token validation');
  assert.doesNotMatch(doctorHtml, /EMR-Patient:123/, 'Doctor QR entry no longer prompts for static patient identifiers');
  assertIncludes(dashboardHtml, 'id="patientQrExpiresAt"', 'Dashboard displays patient QR expiry');
  assertIncludes(dashboardHtml, 'id="regeneratePatientQr"', 'Dashboard exposes patient QR regeneration control');
  assert.doesNotMatch(myQrRoute, /EMR-Patient:\$\{userId\}/, 'Patient QR no longer uses static patient identifier payload');
});

test('consultation workflow requires profile readiness and exposes walk-in source to doctors', () => {
  const serverSource = readProjectFile('server.js');
  const dashboardHtml = readProjectFile('dashboard.html');
  const doctorHtml = readProjectFile('doctor-dashboard.html');
  const consultationRoute = extractRouteBlock(serverSource, "app.post('/api/consultation-request'", 'Patient consultation route is present');
  const myConsultationsRoute = extractRouteBlock(serverSource, "app.get('/api/my-consultations'", 'Patient consultation list route is present');
  const cancelConsultationRoute = extractRouteBlock(serverSource, "app.post('/api/my-consultations/:id/cancel'", 'Patient consultation cancellation route is present');
  const patientRecordFileRoute = extractRouteBlock(serverSource, "app.get('/api/patient-record-files/:id'", 'Patient record file retrieval route is present');
  const walkInRoute = extractRouteBlock(serverSource, "app.post('/api/staff/consultations'", 'Staff walk-in route is present');
  const doctorListRoute = extractRouteBlock(serverSource, "app.get('/api/doctor/consultations'", 'Doctor consultation list route is present');
  const scheduleRoute = extractRouteBlock(serverSource, "app.put('/api/consultations/:id/schedule'", 'Consultation scheduling route is present');
  const doctorConsultationUpdateRoute = extractRouteBlock(serverSource, "app.put('/api/doctor/consultation/:id'", 'Doctor consultation update route is present');
  const createAvailabilityRoute = extractRouteBlock(serverSource, "app.post('/api/doctor/availability'", 'Doctor availability create route is present');
  const updateAvailabilityFunction = extractFunctionBlock(serverSource, 'handleUpdateDoctorAvailability');
  const doctorUpdateForm = extractTaggedBlockById(doctorHtml, 'form', 'updateConsultationForm');
  const quickUpdateFunction = extractFunctionBlock(doctorHtml, 'quickUpdateConsultation');

  assertIncludes(serverSource, 'async function requireActiveVerifiedPatient(userId)', 'Server defines active verified patient gate');
  assertIncludes(serverSource, 'async function requirePatientProfileReady(userId)', 'Server defines profile readiness gate');
  assertIncludes(consultationRoute, 'requirePatientProfileReady(userId)', 'Online consultation route requires completed patient profile');
  assertIncludes(myConsultationsRoute, 'requirePatientProfileReady(userId)', 'Patient consultation list route requires completed patient profile');
  assertIncludes(cancelConsultationRoute, 'requirePatientProfileReady(userId)', 'Patient consultation cancellation requires completed patient profile');
  assertMatches(patientRecordFileRoute, /if \(user\.role === 'patient'\)[\s\S]*await requirePatientProfileReady\(userId\)/, 'Patient record file retrieval requires patient requesters to have a completed profile');
  assert.ok(
    patientRecordFileRoute.indexOf('await requirePatientProfileReady(userId)') < patientRecordFileRoute.indexOf('db.getPatientRecordFileById'),
    'Patient record file retrieval checks patient readiness before looking up file details'
  );
  assertIncludes(walkInRoute, 'requirePatientProfileReady(patientId)', 'Staff walk-in route requires completed patient profile');
  assertIncludes(walkInRoute, 'doctor_schedule_changed', 'Walk-in notifications account for assigned doctor schedule visibility');
  assertIncludes(doctorListRoute, 'consultation_source', 'Doctor consultation API returns consultation source');
  assertIncludes(consultationRoute, 'consultationTime && !consultationDate', 'Online consultation rejects a start time without a date');
  assertIncludes(consultationRoute, 'Consultation date is required when start time is supplied.', 'Online consultation explains date is required when time is supplied');
  assertIncludes(consultationRoute, 'DATE_ONLY_PATTERN.test(consultationDate)', 'Online consultation validates date format');
  assertIncludes(consultationRoute, 'parseDateOnly(consultationDate)', 'Online consultation validates real calendar dates');
  assertIncludes(consultationRoute, 'TIME_PATTERN.test(consultationTime)', 'Online consultation validates requested start time');
  assertIncludes(scheduleRoute, 'DATE_ONLY_PATTERN.test(consultationDate)', 'Later scheduling validates date format');
  assertIncludes(scheduleRoute, 'parseDateOnly(consultationDate)', 'Later scheduling validates real calendar dates');
  assertIncludes(scheduleRoute, 'consultationDate < today', 'Later scheduling rejects past dates');
  assertIncludes(scheduleRoute, 'TIME_PATTERN.test(consultationTime)', 'Later scheduling validates start time format');
  assertIncludes(scheduleRoute, 'consultationTimeEnd <= consultationTime', 'Later scheduling rejects invalid end time');
  assertIncludes(scheduleRoute, 'db.getDoctorAvailability()', 'Later scheduling checks published doctor availability');
  assertIncludes(scheduleRoute, 'This doctor does not have published availability for the selected date and time.', 'Later scheduling rejects unpublished slots');
  assertIncludes(doctorConsultationUpdateRoute, 'DATE_ONLY_PATTERN.test(targetDate)', 'Doctor consultation update validates scheduled date format');
  assertIncludes(doctorConsultationUpdateRoute, 'parseDateOnly(targetDate)', 'Doctor consultation update validates real scheduled calendar dates');
  assertIncludes(doctorConsultationUpdateRoute, 'targetDate < today', 'Doctor consultation update rejects past scheduled dates');
  assertIncludes(doctorConsultationUpdateRoute, 'TIME_PATTERN.test(targetStartTime)', 'Doctor consultation update validates scheduled start time');
  assertIncludes(doctorConsultationUpdateRoute, 'targetEndTime <= targetStartTime', 'Doctor consultation update rejects invalid scheduled end time');
  assertIncludes(doctorConsultationUpdateRoute, 'db.getDoctorAvailability()', 'Doctor consultation update checks published doctor availability');
  assertIncludes(doctorConsultationUpdateRoute, 'This doctor does not have published availability for the selected date and time.', 'Doctor consultation update rejects unpublished slots');
  assertIncludes(serverSource, 'function normalizeDoctorAvailabilityInput', 'Server normalizes and validates doctor availability publication input');
  assertIncludes(serverSource, 'Availability date must use YYYY-MM-DD format.', 'Doctor availability rejects malformed dates');
  assertIncludes(serverSource, 'Availability date must be a valid calendar date.', 'Doctor availability rejects impossible dates');
  assertIncludes(serverSource, 'Availability time slots must use HH:mm format.', 'Doctor availability rejects malformed time slots');
  assertIncludes(createAvailabilityRoute, 'normalizeDoctorAvailabilityInput(req.body.availableDate, timeSlots)', 'Doctor availability creation validates published slots');
  assertIncludes(updateAvailabilityFunction, 'normalizeDoctorAvailabilityInput(req.body.availableDate, timeSlots)', 'Doctor availability update validates published slots');
  assertIncludes(doctorHtml, 'consultation_source', 'Doctor dashboard renders consultation source');
  assertIncludes(doctorHtml, 'Walk-in', 'Doctor dashboard labels walk-in consultations');
  assert.doesNotMatch(doctorUpdateForm, /id="consultationDate"|id="consultationTimeStart"|id="consultationTimeEnd"/, 'Doctor manage consultation form does not duplicate scheduling date/time controls');
  assert.doesNotMatch(doctorHtml, /quickUpdateConsultation\(\$\{c\.id\}, 'scheduled'\)/, 'Doctor list does not approve scheduled consultations without the schedule form');
  assert.doesNotMatch(quickUpdateFunction, /consultationDate:|consultationTime:|consultationTimeEnd:/, 'Doctor quick status updates do not send scheduling fields');
  assertIncludes(doctorHtml, 'submitDoctorSchedule(event, ${c.id})', 'Doctor dashboard keeps scheduling in the dedicated schedule form');
  assertIncludes(dashboardHtml, 'id="profileCompletionView"', 'Dashboard includes profile completion view');
  assertIncludes(dashboardHtml, 'loadProfileReadiness()', 'Dashboard checks profile readiness');
  assertIncludes(dashboardHtml, 'submitProfileCompletion', 'Dashboard can submit patient profile completion');
  assertIncludes(dashboardHtml, 'data-requires-profile="true"', 'Dashboard marks profile-gated sections/actions');
});
