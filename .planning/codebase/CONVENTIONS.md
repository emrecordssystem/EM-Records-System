# Coding Conventions

**Analysis Date:** 2026-05-31

## Naming Patterns

**Files:**
- Use flat, page-oriented lowercase/kebab-case HTML files for browser screens: `EMRsystem/login.html`, `EMRsystem/admin-dashboard.html`, `EMRsystem/doctor-dashboard.html`, `VercelFrontend/staff-login.html`.
- Keep first-party backend modules as simple CommonJS files at the app root: `EMRsystem/server.js`, `EMRsystem/db.js`, `EMRsystem/app.js`.
- Build and one-off validation scripts use descriptive kebab-case names: `EMRsystem/scripts/build-static.js`, `EMRsystem/test-cp-abe.js`, `EMRsystem/test-ocr-improved.js`, `EMRsystem/setup-test-accounts.js`.
- The deployed static frontend in `VercelFrontend/` mirrors files from `EMRsystem/`; treat `EMRsystem/` as the primary source for static files because `EMRsystem/scripts/build-static.js` copies them into `VercelFrontend/` and `EMRsystem/dist/`.

**Functions:**
- Use camelCase for backend helpers and database operations: `getLocalDateString()`, `normalizeDateOnly()`, `ensureDoctorDailyCapacity()`, `writeAuditLog()` in `EMRsystem/server.js`; `createUser()`, `validateCredentials()`, `getPatientAssessmentByUserId()` in `EMRsystem/db.js`.
- Use verb-oriented async database function names: `createPatientAssessment()`, `updatePatientProfile()`, `deleteUserCascade()` in `EMRsystem/db.js`.
- Use page-local browser helpers with camelCase names: `apiFetch()`, `setHint()`, `hasRegistrationProgress()` in `VercelFrontend/register.html`; `formatTimeSlot()`, `parseSlotArray()` in `VercelFrontend/dashboard.html`.

**Variables:**
- Use `const` by default and `let` only for mutable state in first-party JavaScript: `API_BASE_URL`, `authUser`, `overviewState`, and `TIME_SLOT_LABELS` in `VercelFrontend/dashboard.html`.
- Use UPPER_SNAKE_CASE for backend constants and limits: `PORT`, `FRONTEND_URL`, `APP_TIME_ZONE`, `MAX_RECORD_FILE_BYTES`, `ALLOWED_RECORD_FILE_TYPES`, `MAX_DOCTOR_CONSULTATIONS_PER_DAY` in `EMRsystem/server.js`.
- Use snake_case only when returning database-shaped fields directly to the client, such as `file_name`, `mime_type`, `created_at` in `EMRsystem/server.js` responses and `EMRsystem/db.js` queries.

**Types:**
- No TypeScript types are present. Use plain JavaScript objects with explicit field names, such as the `assessment` object in `EMRsystem/test-cp-abe.js` and the `report` response in `EMRsystem/server.js`.

## Code Style

**Formatting:**
- No Prettier, ESLint, Biome, or TypeScript config is detected in first-party files. Match the current manual formatting style.
- Use two-space indentation in JavaScript and HTML inline scripts, as shown in `EMRsystem/server.js`, `EMRsystem/db.js`, `VercelFrontend/login.html`, and `VercelFrontend/register.html`.
- Use semicolons consistently in JavaScript files: `EMRsystem/server.js`, `EMRsystem/db.js`, `VercelFrontend/api-config.js`, `VercelFrontend/password-toggle.js`.
- Use single quotes for JavaScript strings unless interpolation is required. Template literals are used for URLs and user-facing messages in `EMRsystem/server.js` and `VercelFrontend/dashboard.html`.

**Linting:**
- Not detected. `package.json`, `EMRsystem/package.json`, and `VercelFrontend/package.json` define no `lint` script and no first-party lint config exists.
- Because linting is absent, verify syntax with `node --check` on edited JavaScript files and run build/static scripts before shipping changes.

## Import Organization

**Order:**
1. Built-in Node modules first: `fs`, `path`, `crypto` in `EMRsystem/server.js` and `EMRsystem/scripts/build-static.js`.
2. Third-party packages next: `express`, `cors`, `qrcode`, `sharp`, `tesseract.js`, `form-data` in `EMRsystem/server.js`.
3. Local modules last: `const db = require('./db');` in `EMRsystem/server.js`.

**Path Aliases:**
- Not detected. Use relative paths only, such as `require('./db')` in `EMRsystem/server.js` and relative script tags such as `password-toggle.js` in `VercelFrontend/login.html`.

## API Response Conventions

- Return JSON objects with a top-level `success` boolean from API routes. Examples: `{ success: true, user: ... }` from `EMRsystem/server.js` `/api/login` and `{ success: false, message: ... }` from validation failures in `EMRsystem/server.js`.
- Use HTTP status codes alongside the `success` flag: `400` for missing/invalid input, `401` for invalid credentials, `403` for role/status access denial, `404` for missing resources, `409` for duplicate email, `500` for server errors in `EMRsystem/server.js`.
- Use `message` for user-facing error text and keep internal errors out of responses. Server exceptions are logged with `console.error()` and clients receive `'Internal server error.'` in `EMRsystem/server.js`.
- Return created resources with `201` where applied: registration, assessments, consultation requests, patient record uploads, and invite creation in `EMRsystem/server.js`.
- Backend responses often expose database snake_case fields directly; frontend code should consume existing names rather than renaming unless a new normalization layer is introduced. Examples: `available_time_slots_remaining` in `VercelFrontend/dashboard.html`, `file_name` in `EMRsystem/server.js`.

## Auth/session/security coding conventions

- Passwords are hashed with `bcrypt.hash(password, 10)` in `EMRsystem/db.js` and verified with `bcrypt.compare()` in `EMRsystem/db.js`.
- Login uses email/password only and returns a user object; `EMRsystem/server.js` explicitly notes that a real session/token is not issued. Browser pages persist this returned user in `localStorage` under `authUser` in `VercelFrontend/login.html`, `VercelFrontend/doctor-login.html`, and `VercelFrontend/staff-login.html`.
- Role authorization is performed per route by loading `userId` from query/body and checking `user.role`. Examples: admin checks in `EMRsystem/server.js` `/api/admin/stats`, patient upload checks in `/api/patient-record-files`, and doctor/staff checks throughout `EMRsystem/server.js`.
- Frontend pages perform client-side role gates before loading dashboards: `VercelFrontend/dashboard.html` requires `authUser.role === 'patient'`, `VercelFrontend/doctor-dashboard.html` requires doctor, and `VercelFrontend/staff.html` requires staff.
- Do not introduce bearer-token assumptions without first adding server-side token/session issuance. Existing APIs expect `userId` in query strings or JSON bodies, as shown across `VercelFrontend/dashboard.html` and `VercelFrontend/doctor-dashboard.html`.
- File upload security uses allowlist and size checks: `ALLOWED_RECORD_FILE_TYPES` and `MAX_RECORD_FILE_BYTES` in `EMRsystem/server.js`. Preserve these checks for new upload endpoints.
- Assessment confidentiality uses AES-256-GCM helper functions named as CP-ABE policy enforcement in `EMRsystem/db.js`; doctors and owning patients can decrypt, admins are blocked in `getPatientAssessmentByUserId()`.
- Environment secrets are read from `process.env` via `dotenv` in `EMRsystem/server.js` and `pg.Pool` in `EMRsystem/db.js`. `.env.example` exists but secret file contents are not read or documented here.
- CORS is globally enabled with `app.use(cors())` in `EMRsystem/server.js`; no Helmet, CSRF middleware, rate limiting, secure cookie sessions, or centralized auth middleware is detected.

## Error Handling

**Patterns:**
- Wrap each Express route in `try/catch`; log the caught error with a route-specific label and return a `{ success: false, message }` JSON response. Examples: `register error`, `login error`, `record file upload error`, and `admin users error` in `EMRsystem/server.js`.
- Use early returns for validation and authorization failures. Examples: missing `email/password` in `EMRsystem/server.js` `/api/login`, invalid `role` in `/api/register`, and missing `userId` in admin routes.
- Use custom `Error` objects with `statusCode` for reusable validation helpers. `ensureDoctorDailyCapacity()` and `ensureDoctorSlotAvailable()` in `EMRsystem/server.js` throw `Error` instances with `statusCode = 400`.
- Database helpers throw when `DATABASE_URL` is missing in `EMRsystem/db.js`; startup catches failures around `db.init()` in `EMRsystem/server.js` and exits with code `1`.
- Browser code displays inline hints or alerts and catches fetch failures locally. Examples: `formHint` handling in `VercelFrontend/login.html`, `setHint()` in `VercelFrontend/register.html`, and access-denied alerts in dashboard pages.

## Logging

**Framework:** console

**Patterns:**
- Backend operational errors use `console.error('<context>', err)` in `EMRsystem/server.js` and `EMRsystem/db.js` callers.
- Audit events are persisted separately through `writeAuditLog()` in `EMRsystem/server.js` and `createAuditLog()` in `EMRsystem/db.js`; use this pattern for admin/security-sensitive actions.
- Frontend diagnostics use bracketed labels such as `[API CONFIG]`, `[FETCH]`, `[FETCH ERROR]`, `[AUTH ERROR]`, and `[OCR ERROR]` in `VercelFrontend/api-config.js`, `VercelFrontend/auth-client.js`, and `VercelFrontend/register.html`.
- Avoid logging secrets, passwords, raw tokens, or full medical record payloads. Existing test/setup scripts log test emails and passwords in `EMRsystem/setup-test-accounts.js`; keep that pattern limited to local/manual test utilities.

## Comments

**When to Comment:**
- Comments explain workflow boundaries and domain-specific behavior, especially registration invites, OCR processing, CP-ABE policy checks, and deployment/build behavior. Examples: `EMRsystem/server.js`, `EMRsystem/db.js`, `EMRsystem/test-ocr-improved.js`.
- Avoid comments that describe obvious syntax. Prefer comments for constraints or domain context, such as `MAX_DOCTOR_CONSULTATIONS_PER_DAY` behavior in `EMRsystem/server.js`.

**JSDoc/TSDoc:**
- Not used. There are no JSDoc or TSDoc blocks in first-party files. Keep functions self-explanatory unless adding complex algorithmic logic.

## Function Design

**Size:**
- Backend route handlers in `EMRsystem/server.js` are often long and inline; when adding new code, prefer extracting reusable validation/formatting helpers near the top of `EMRsystem/server.js` if logic is shared.
- Database access functions in `EMRsystem/db.js` are organized as small async wrappers around SQL statements. Add new SQL accessors there instead of embedding database logic in frontend files.

**Parameters:**
- Use object parameters for functions with multiple related inputs: `ensureDoctorDailyCapacity({ doctorId, consultationDate, excludeConsultationId })` in `EMRsystem/server.js`, `createUser({ role, email, password, displayName })` in `EMRsystem/db.js`.
- Use positional parameters for simple IDs and SQL helper functions: `getUserById(id)`, `get(sql, params)`, `run(sql, params)` in `EMRsystem/db.js`.

**Return Values:**
- API handlers return Express responses directly with `return res.json(...)` or `return res.status(...).json(...)` in `EMRsystem/server.js`.
- Database helpers return plain objects mirroring created or fetched records, often with camelCase for newly constructed objects (`createdAt`) and snake_case for database rows (`created_at`) in `EMRsystem/db.js`.

## Module Design

**Exports:**
- `EMRsystem/server.js` exports only selected testable helpers at the bottom (`parsePhilippineIdOcr`). Keep route-only helpers internal unless needed by tests or scripts.
- `EMRsystem/db.js` centralizes database exports via `module.exports` near the bottom; add new database functions there when used by `EMRsystem/server.js`.
- Browser utilities are immediately invoked or page-local rather than bundled modules: `VercelFrontend/api-config.js`, `VercelFrontend/password-toggle.js`, and inline scripts in HTML pages.

**Barrel Files:**
- Not used. There are no `index.js` barrel exports for first-party modules beyond the root `index.js` launcher.

## Frontend HTML/CSS/JS conventions

- Use static HTML pages with inline page scripts plus shared `api-config.js`, `styles.css`, `password-toggle.js`, and `qrcode.min.js` files in `EMRsystem/` and `VercelFrontend/`.
- Load `api-config.js` so `/api/...` fetches are rewritten to the local API in development or Render in deployment. `VercelFrontend/api-config.js` wraps `window.fetch` for string resources starting with `/api/`.
- Use CSS custom properties from `:root` in `VercelFrontend/styles.css`: `--primary`, `--danger`, `--success`, `--radius`, `--shadow`, and related variables.
- Use BEM-like or semantic class names for UI sections: `.card`, `.field`, `.tab`, `.password-field`, `.password-toggle` in `VercelFrontend/styles.css`.
- Use `data-password-toggle` on password inputs and rely on `VercelFrontend/password-toggle.js` to wrap inputs and add accessible show/hide buttons.
- Prefer inline hint elements for validation feedback (`formHint`, `resetHint`, `profileHint`, `consultationHint`) and reserve `alert()` for access denial or workflow confirmation, matching `VercelFrontend/login.html`, `VercelFrontend/register.html`, and `VercelFrontend/dashboard.html`.

## Configuration and environment conventions

- Root scripts in `package.json` delegate to `EMRsystem/package.json`; run backend commands from the root with `npm run build`, `npm start`, or `npm run dev`.
- Backend scripts in `EMRsystem/package.json` are `build`, `start`, and `dev`; there are no automated test/lint scripts.
- Static frontend build in `EMRsystem/scripts/build-static.js` copies source files into `EMRsystem/dist/` and `VercelFrontend/`, and writes a static `vercel.json`.
- `render.yaml` declares Render deployment with `EMRsystem` as `rootDir`, `npm install` as build command, `npm start` as start command, `/api/health` as health check, and environment variables `DATABASE_URL`, `FRONTEND_URL`, and `ROBOFLOW_API_KEY` managed outside the repo.
- `vercel.json`, `EMRsystem/vercel.json`, and `VercelFrontend/vercel.json` configure static deployments with clean URLs and no-cache static headers.
- `EMRsystem/README.md` references SQLite and `data/emr.db`, while the implementation uses Postgres via `pg` and `DATABASE_URL` in `EMRsystem/db.js`; treat implementation and `EMRsystem/DEPLOYMENT.md` as authoritative for current database conventions.

## Inconsistent conventions and duplication patterns

- Static source duplication exists between `EMRsystem/` and `VercelFrontend/`. Update `EMRsystem/` first and run `npm run build` or `npm --prefix EMRsystem run build` to refresh generated/static copies.
- Authentication client code is duplicated across `EMRsystem/app.js`, `VercelFrontend/auth-client.js`, `VercelFrontend/login.html`, `VercelFrontend/simple-login.html`, `VercelFrontend/doctor-login.html`, and `VercelFrontend/staff-login.html`.
- Role checks are repeated route-by-route in `EMRsystem/server.js`; no shared middleware exists. When adding routes, follow the existing explicit checks and consider extracting middleware only as a deliberate refactor.
- README documentation conflicts with implementation: `EMRsystem/README.md` mentions SQLite and `db.js` storage, while `EMRsystem/db.js` requires Postgres `DATABASE_URL` and `render.yaml` deploys with Neon/Postgres.
- `EMRsystem/setup-test-accounts.js` creates a `staff` role while logging it as an admin account; use it cautiously for manual testing and verify expected roles in the UI.
- The generated or vendored `node_modules/` directory exists under `EMRsystem/node_modules/`; ignore it during code review and mapping except for package metadata.

## Project-specific skills

- No project-local `.claude/skills/` or `.agents/skills/` directories are present in `D:\Desktop\EMRecords-main`; no additional skill-defined architecture or convention rules were detected.

---

*Convention analysis: 2026-05-31*
