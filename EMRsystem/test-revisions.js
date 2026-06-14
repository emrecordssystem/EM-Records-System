const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectDir = __dirname;
const server = require(path.join(projectDir, 'server.js'));

function readProjectFile(fileName) {
  return fs.readFileSync(path.join(projectDir, fileName), 'utf8');
}

test('password revision rules reject weak passwords and accept a compliant password', () => {
  assert.equal(server.getPasswordValidationMessage('short'), 'Password must be at least 8 characters.');
  assert.equal(server.getPasswordValidationMessage('lowercase1!'), 'Password must include at least one uppercase letter.');
  assert.equal(server.getPasswordValidationMessage('UPPERCASE1!'), 'Password must include at least one lowercase letter.');
  assert.equal(server.getPasswordValidationMessage('NoNumber!'), 'Password must include at least one number.');
  assert.equal(server.getPasswordValidationMessage('NoSpecial1'), 'Password must include at least one special character.');
  assert.equal(server.getPasswordValidationMessage('StrongPass1!'), '');
});

test('verification helpers create usable local verification data', () => {
  const token = server.createEmailVerificationToken();
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(server.getVerificationUrl({ protocol: 'http', get: () => 'localhost:3000' }, token), `http://localhost:3000/api/verify-email?token=${token}`);
});

test('registration page exposes required markers, password restrictions, optional mobile, and provider messaging', () => {
  const html = readProjectFile('register.html');
  assert.match(html, /required-marker/);
  assert.match(html, /Password restrictions/);
  assert.match(html, /Google email\/social media registration/);
  assert.match(html, /Mobile Number[\s\S]*\(optional\)/);
  assert.doesNotMatch(html, /id="mobile"[^>]*required/);
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
