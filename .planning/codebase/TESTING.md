# Testing Patterns

**Analysis Date:** 2026-05-31

## Test Framework

**Runner:**
- No automated JavaScript test runner is configured. `package.json`, `EMRsystem/package.json`, and `VercelFrontend/package.json` do not define a `test` script.
- No Jest, Vitest, Playwright, Cypress, Mocha, or Node test-runner config files were detected in first-party files.
- Existing first-party validation is script/manual based: `EMRsystem/test-cp-abe.js`, `EMRsystem/test-ocr-improved.js`, and `EMRsystem/setup-test-accounts.js`.

**Assertion Library:**
- Not detected. Manual scripts use `console.log()` PASS/FAIL messages rather than assertions, as shown in `EMRsystem/test-cp-abe.js` and `EMRsystem/test-ocr-improved.js`.

**Run Commands:**
```bash
npm run build                         # Root static build via EMRsystem/scripts/build-static.js
npm start                             # Root backend start via EMRsystem/server.js
npm run dev                           # Root backend dev start; same as start
npm --prefix EMRsystem run build      # Build EMRsystem/dist and refresh VercelFrontend
npm --prefix EMRsystem start          # Start Express API/static server
npm --prefix VercelFrontend run build # Copy VercelFrontend static files to VercelFrontend/dist
node EMRsystem/test-ocr-improved.js   # Manual OCR parser scenario script
node EMRsystem/test-cp-abe.js         # Manual API integration script; requires running backend and DATABASE_URL
node EMRsystem/setup-test-accounts.js # Manual test data setup; requires running backend and DATABASE_URL
```

## Test File Organization

**Location:**
- First-party test/manual validation scripts are at the `EMRsystem/` root: `EMRsystem/test-cp-abe.js`, `EMRsystem/test-ocr-improved.js`, and `EMRsystem/setup-test-accounts.js`.
- No co-located unit tests (`*.test.js`, `*.spec.js`) are present outside `EMRsystem/node_modules/`.
- Browser smoke tests are documented manually in `EMRsystem/OCR_IMPROVEMENTS.md` and operational docs in `EMRsystem/DEPLOYMENT.md`.

**Naming:**
- Manual validation scripts use `test-<feature>.js`, such as `EMRsystem/test-cp-abe.js` and `EMRsystem/test-ocr-improved.js`.
- Setup utilities use action names, such as `EMRsystem/setup-test-accounts.js`.

**Structure:**
```text
EMRsystem/
├── test-cp-abe.js          # Manual API integration test for assessment encryption/policy access
├── test-ocr-improved.js    # Manual parser scenario test for Philippine ID OCR extraction
├── setup-test-accounts.js  # Manual data setup utility for local smoke testing
└── scripts/build-static.js # Static generation/build validation path
```

## Test Structure

**Suite Organization:**
```javascript
// EMRsystem/test-cp-abe.js
async function test() {
  console.log('Step 1: Register Patient User...');
  const patientRegister = await makeRequest('POST', '/api/register', { /* fixture fields */ });
  if (!patientRegister.body.success) {
    console.log('Patient registration failed:', patientRegister.body.message);
    return;
  }

  console.log('Step 5: TEST - Patient Accessing Own Assessment...');
  const patientAccess = await makeRequest('GET', `/api/my-emr?userId=${patientId}`);
  if (patientAccess.body.success && patientAccess.body.emr.assessment) {
    console.log('PASS - Patient CAN access their own assessment');
  }
}
```

**Patterns:**
- Manual scripts are self-contained and use Node built-ins only. `EMRsystem/test-cp-abe.js` and `EMRsystem/setup-test-accounts.js` use `http.request()` and `new URL()` instead of a test framework.
- API integration scripts require a live server at `API_BASE_URL` or `http://localhost:3000` by default.
- Scenario scripts generate timestamped data to reduce email/username collisions, as in `EMRsystem/test-cp-abe.js`.
- OCR parser validation duplicates parser/helper logic in `EMRsystem/test-ocr-improved.js` rather than importing `parsePhilippineIdOcr` from `EMRsystem/server.js`.
- Scripts call `process.exit(0)` at completion in `EMRsystem/test-cp-abe.js` and `EMRsystem/setup-test-accounts.js`; do not treat them as composable tests without refactoring.

## Mocking

**Framework:** Not detected

**Patterns:**
```javascript
// EMRsystem/test-cp-abe.js and EMRsystem/setup-test-accounts.js
function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE_URL + path);
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
```

**What to Mock:**
- No current mocking convention exists. If automated tests are introduced, mock external OCR/Roboflow calls and file/image processing around `EMRsystem/server.js` endpoints while keeping validation helpers deterministic.
- For database-heavy route tests, prefer a controlled test database via `DATABASE_URL` because `EMRsystem/db.js` constructs a module-level `pg.Pool` from `process.env.DATABASE_URL`.

**What NOT to Mock:**
- Do not mock `bcrypt` behavior for authentication regression tests that verify password hashing and login behavior in `EMRsystem/db.js`.
- Do not mock CP-ABE/AES policy logic when testing assessment access; `EMRsystem/test-cp-abe.js` is valuable because it exercises registration, storage, retrieval, and policy denial through HTTP.

## Fixtures and Factories

**Test Data:**
```javascript
// EMRsystem/test-cp-abe.js
const timestamp = Date.now();
const patientRegister = await makeRequest('POST', '/api/register', {
  role: 'patient',
  email: `testpatient${timestamp}@test.com`,
  password: 'password123',
  username: `testpatient${timestamp}`,
  firstName: 'Test',
  lastName: 'Patient',
  mobile: '1234567890',
  dateOfBirth: '1990-01-01',
  age: 34,
  sex: 'M',
  civilStatus: 'Single',
  address: 'Test Address',
  securityQuestion: 'What is your favorite color?',
  securityAnswer: 'Blue',
});
```

**Location:**
- Inline in manual scripts: `EMRsystem/test-cp-abe.js`, `EMRsystem/test-ocr-improved.js`, and `EMRsystem/setup-test-accounts.js`.
- No shared fixture directory exists.

## Coverage

**Requirements:** None enforced

**View Coverage:**
```bash
# Not available: no coverage script or coverage tool is configured in first-party package metadata.
```

## Test Types

**Unit Tests:**
- No formal automated unit tests are present.
- `EMRsystem/test-ocr-improved.js` acts like a unit/scenario test for OCR parsing helpers, but it duplicates helper code rather than importing production code from `EMRsystem/server.js`.
- `EMRsystem/server.js` exports `parsePhilippineIdOcr`, which provides a starting point for real unit tests of OCR parsing.

**Integration Tests:**
- `EMRsystem/test-cp-abe.js` is a manual HTTP integration test for registration, assessment creation, patient access, doctor access, admin denial, and cross-patient policy expectations.
- `EMRsystem/setup-test-accounts.js` is a manual setup utility for smoke testing login/dashboard flows.
- These scripts require the backend to be running and require valid backend environment/database configuration.

**E2E Tests:**
- Not used. No browser automation framework is configured.
- Manual E2E coverage is inferred from docs and pages: registration/login/dashboard flows in `VercelFrontend/login.html`, `VercelFrontend/register.html`, `VercelFrontend/dashboard.html`, `VercelFrontend/doctor-dashboard.html`, `VercelFrontend/staff.html`, and `VercelFrontend/admin-dashboard.html`.

## Common Patterns

**Async Testing:**
```javascript
// EMRsystem/test-cp-abe.js
try {
  const response = await makeRequest('POST', '/api/assessment', { userId: patientId, answers: assessment });
  if (!response.body.success) {
    console.log('Assessment submission failed:', response.body.message);
    return;
  }
} catch (error) {
  console.error('Error during test:', error.message);
}
```

**Error Testing:**
```javascript
// EMRsystem/test-cp-abe.js
const adminAccess = await makeRequest('GET', `/api/admin/emr-records?userId=${adminId}`);
if (adminAccess.status === 403 || (adminAccess.body.success && adminAccess.body.records[0]?.assessment === '[ENCRYPTED - Access Denied for Admin Role]')) {
  console.log('PASS - Admin is BLOCKED from decrypting assessments');
}
```

## Build/static generation checks

- Run `npm run build` from `D:\Desktop\EMRecords-main` to execute `npm --prefix EMRsystem run build` and generate `EMRsystem/dist/` from `EMRsystem/scripts/build-static.js`.
- Run `npm --prefix EMRsystem run build` after changing static files in `EMRsystem/`; the script copies 18 static files into `EMRsystem/dist/` and `VercelFrontend/` and writes `vercel.json`.
- Run `npm --prefix VercelFrontend run build` when validating the standalone `VercelFrontend/` project; `VercelFrontend/build.js` copies files to `VercelFrontend/dist/`.
- Validate API startup with `npm start` or `npm --prefix EMRsystem start`, then visit `/api/health`; `EMRsystem/server.js` returns `{ success: true, status: 'ok', release: APP_RELEASE }`.
- For syntax-only JavaScript checks, use `node --check` on edited files because no lint script exists.

## Local smoke-test steps likely needed

1. Install dependencies under `EMRsystem/` using `npm install`; `render.yaml` and `EMRsystem/DEPLOYMENT.md` use this path as the backend root.
2. Provide environment configuration externally for `DATABASE_URL`; `EMRsystem/db.js` throws if it is missing. Also set `FRONTEND_URL` and `ROBOFLOW_API_KEY` if validating deployed frontend URL generation or OCR detection.
3. Start the backend with `npm --prefix EMRsystem start` or root `npm start`.
4. Confirm `http://localhost:3000/api/health` returns success from `EMRsystem/server.js`.
5. Run `node EMRsystem/setup-test-accounts.js` only against a disposable/local database; it creates predictable test credentials.
6. Manually open `http://localhost:3000/login.html` and verify role redirects to `dashboard.html`, `doctor-dashboard.html`, `staff.html`, or `admin-dashboard.html` based on the `authUser` role.
7. Verify patient flow in `VercelFrontend/dashboard.html` or served `EMRsystem/dashboard.html`: profile load, consultation request, notifications, EMR view, record upload size/type checks, and logout.
8. Verify doctor flow in `VercelFrontend/doctor-dashboard.html`: consultations, patient EMR access, scheduling, availability CRUD, diagnostics/report sections, and notifications.
9. Verify admin flow in `VercelFrontend/admin-dashboard.html`: user management, status changes, password reset requests, reports, audit logs, QR/invites, and permission views.
10. Verify registration/OCR flow in `VercelFrontend/register.html` or served `EMRsystem/register.html`: invite token handling, required patient fields, ID upload/camera, OCR modal confirm/reject, form submit, and back-navigation warning.

## Security and operational validation checks

- Validate login failure returns `401` and audit log entries are written by `writeAuditLog()` in `EMRsystem/server.js`.
- Validate pending/inactive users cannot log in through `/api/login` in `EMRsystem/server.js`.
- Validate admin-only routes reject non-admin `userId` values in `EMRsystem/server.js`, especially `/api/admin/users`, `/api/admin/audit-logs`, `/api/admin/reports/:type`, and `/api/admin/password-reset-requests`.
- Validate patient record uploads reject unsupported MIME types and files over 5 MB using `ALLOWED_RECORD_FILE_TYPES` and `MAX_RECORD_FILE_BYTES` in `EMRsystem/server.js`.
- Validate assessment access policy with `node EMRsystem/test-cp-abe.js`; confirm patients and doctors can access permitted assessments and admins cannot decrypt assessment data.
- Validate frontend deployment target by checking `VercelFrontend/api-config.js`; production pages call the hard-coded Render URL while localhost calls `http://localhost:3000`.

## Current test coverage gaps

- No automated tests cover `EMRsystem/server.js` route validation, status codes, role authorization, or error paths.
- No automated tests cover `EMRsystem/db.js` SQL migrations, Postgres query conversion, cascade deletion, audit log writes, notification behavior, password reset flow, or doctor availability scheduling.
- No automated tests cover browser dashboard behavior in `VercelFrontend/dashboard.html`, `VercelFrontend/doctor-dashboard.html`, `VercelFrontend/staff.html`, or `VercelFrontend/admin-dashboard.html`.
- No automated tests cover `VercelFrontend/api-config.js` fetch rewriting or production/local API base URL behavior.
- No automated tests cover CSS/layout regressions in `VercelFrontend/styles.css`.
- OCR validation in `EMRsystem/test-ocr-improved.js` is not connected to production exports and may drift from `EMRsystem/server.js`.
- CP-ABE validation in `EMRsystem/test-cp-abe.js` relies on live mutable data and console PASS/FAIL output; failures do not consistently produce non-zero process exits.
- There is no CI pipeline detected for running build checks, smoke tests, or static validation.

## Risks around missing automated coverage

- Route-level authorization can regress silently because access control is duplicated in many `EMRsystem/server.js` handlers rather than centralized middleware.
- Static frontend copies can drift between `EMRsystem/` and `VercelFrontend/` if `EMRsystem/scripts/build-static.js` is not run after edits.
- Database schema changes in `EMRsystem/db.js` can break startup or production data access without migration tests.
- Login/session behavior is fragile because the app relies on `localStorage` `authUser` and client-supplied `userId`; automated tests should verify every sensitive route still re-checks role server-side.
- OCR, image preprocessing, and file upload behavior can regress without real image/file fixtures.
- Deployment health can break if `/api/health` or `render.yaml` conventions change without a smoke test.

## Project-specific skills

- No project-local `.claude/skills/` or `.agents/skills/` directories are present in `D:\Desktop\EMRecords-main`; no additional skill-defined testing rules were detected.

---

*Testing analysis: 2026-05-31*
