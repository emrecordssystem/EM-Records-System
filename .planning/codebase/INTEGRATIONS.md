# External Integrations

**Analysis Date:** 2026-05-31

## APIs & External Services

**Static frontend to API:**
- Browser pages call the Node API through `fetch`.
  - Client wiring: `EMRsystem/api-config.js`, `VercelFrontend/api-config.js`, `EMRsystem/app.js`, `VercelFrontend/auth-client.js`.
  - Local API base: `http://localhost:3000` when hostname is `localhost` or `127.0.0.1`.
  - Deployed API base: hardcoded Render service URL in `EMRsystem/api-config.js` and `VercelFrontend/api-config.js`.
  - Auth/session model: login result stored in browser `localStorage` as `authUser`; no token or cookie flow detected.

**Roboflow:**
- Optional Philippine ID detector/cropper for `POST /api/scan-id`.
  - Endpoint: `https://detect.roboflow.com/philippine-ids-2loru/1` in `EMRsystem/server.js`.
  - SDK/Client: built-in `fetch` plus `form-data` package (`EMRsystem/server.js`, `EMRsystem/package.json`).
  - Auth: `ROBOFLOW_API_KEY` environment variable (`EMRsystem/server.js`, `render.yaml`).
  - Behavior: if enabled and no valid ID is detected, `POST /api/scan-id` rejects the upload before Tesseract fallback (`EMRsystem/server.js`).

**OCR runtime:**
- Tesseract runs locally in Node process via `tesseract.js` / `tesseract.js-core` (`EMRsystem/server.js`, `EMRsystem/package.json`).
- No cloud OCR provider detected besides optional Roboflow object detection.

## Network Endpoints Exposed by the App

**Public/auth/patient API (`EMRsystem/server.js`):**
- `GET /api/public-registration-qr` - returns a registration URL and QR code.
- `POST /api/register` - creates pending/active users and role profiles.
- `POST /api/login` - validates email/password and returns `{ id, role, email, displayName }`.
- `POST /api/forgot-password` - creates admin-visible password reset requests.
- `GET /api/invite` - validates invite token metadata.
- `POST /api/assessment` - stores patient health assessments.
- `POST /api/consultation-request`, `GET /api/my-consultations`, `POST /api/my-consultations/:id/cancel` - patient consultation flow.
- `GET /api/doctor-availability` - public/patient availability lookup.
- `GET /api/notifications`, `POST /api/notifications/:id/read` - notification flow.
- `GET /api/my-qr`, `GET /api/my-emr`, `GET /api/profile`, `PUT /api/profile` - patient profile/EMR access.
- `GET /api/patient-record-files`, `POST /api/patient-record-files`, `GET /api/patient-record-files/:id` - base64 medical record file storage and retrieval.
- `POST /api/scan-id` - OCR/National ID extraction from `imageBase64`.

**Staff/admin/doctor API (`EMRsystem/server.js`):**
- Staff: `POST /api/staff/invite`, `GET /api/staff/schedules`, `GET /api/staff/consultations`, `PUT /api/staff/consultations/:id/prescription`.
- Consultation management: `PUT /api/consultations/:id/schedule`.
- Admin: `GET /api/admin/stats`, `GET /api/admin/reports/:type`, `GET /api/admin/users`, `POST /api/admin/users`, `GET /api/admin/users/:id`, `DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/status`, `GET /api/admin/password-reset-requests`, `POST /api/admin/password-reset-requests/:id/reset`, `GET /api/admin/emr-records`, `GET /api/admin/consultations`, `GET /api/admin/audit-logs`, `GET /api/admin/qr-codes`, `GET /api/admin/access-permissions`.
- Doctor: `GET /api/doctor/consultations`, `GET /api/doctor/consultation/:id`, `PUT /api/doctor/consultation/:id`, `GET /api/doctor/reports/diagnostics`, `GET /api/doctor/report.diagnostics`, `POST /api/doctor/availability`, `PUT /api/doctor/availability/:id`, `POST /api/doctor/availability/:id/update`, `DELETE /api/doctor/availability/:id`, `POST /api/doctor/availability/:id/delete`, `GET /api/doctor/my-availability`, `GET /api/doctor/patient/:patientId`, `GET /api/doctor/profile`, `PUT /api/doctor/profile`, `GET /api/doctor/patients`, `GET /api/doctor/patient/:patientUserId/consultations`.
- Health: `GET /api/health` returns `success`, `status`, and `release` for Render health checks.

## Data Storage

**Databases:**
- PostgreSQL, intended hosted provider Neon.
  - Connection: `DATABASE_URL` (`EMRsystem/db.js`, `render.yaml`, `EMRsystem/DEPLOYMENT.md`).
  - Client: `pg.Pool` (`EMRsystem/db.js`).
  - SSL: enabled when `DATABASE_URL` exists and does not include `localhost` (`EMRsystem/db.js`).
  - Schema: startup migrations create users, invites, patients, login OTPs, assessments, consultations, doctor availability, doctor/staff profiles, notifications, password reset requests, reschedule requests, message board, patient record files, and audit logs (`EMRsystem/db.js`).

**File Storage:**
- No external file/object storage service detected.
- Patient record files are stored in Postgres as base64 text in `patient_record_files.file_data`; retrieval returns `data:<mime>;base64,...` URLs (`EMRsystem/db.js`, `EMRsystem/server.js`).
- Static files are served from `EMRsystem` by Express and copied to `EMRsystem/dist` / `VercelFrontend` by `EMRsystem/scripts/build-static.js`.

**Caching:**
- No Redis or external cache detected.
- Vercel/Express static assets use cache headers configured as `public, max-age=0, must-revalidate` in `vercel.json`, `EMRsystem/vercel.json`, `VercelFrontend/vercel.json`, and generated config in `EMRsystem/scripts/build-static.js`.

## Authentication & Identity

**Auth Provider:**
- Custom email/password auth.
  - Implementation: users table + bcrypt password hashes in `EMRsystem/db.js`; login route in `EMRsystem/server.js`; role-based checks inline in route handlers.
  - Roles: `admin`, `doctor`, `patient`, `staff` in `EMRsystem/server.js`.
  - Sessions: no server-side sessions/JWT detected; frontend stores returned user object in `localStorage` (`EMRsystem/app.js`, `VercelFrontend/auth-client.js`).
  - Invites/QR: admin/staff invite tokens and public registration QR codes use `qrcode` and `crypto.randomUUID()` (`EMRsystem/server.js`).
  - Password reset: admin-mediated reset requests stored in Postgres (`EMRsystem/server.js`, `EMRsystem/db.js`).

## Monitoring & Observability

**Error Tracking:**
- None detected. No Sentry, OpenTelemetry, Datadog, or similar package/config in `EMRsystem/package.json`, root `package.json`, or deployment configs.

**Logs:**
- Console logging only: route errors use `console.error`, warnings use `console.warn`, debug OCR logs are printed in `EMRsystem/server.js`, and frontend fetch/auth logs use `console.log`/`console.debug`/`console.error` in `EMRsystem/api-config.js`, `VercelFrontend/api-config.js`, and `VercelFrontend/auth-client.js`.
- Audit logs are persisted in the `audit_logs` Postgres table through `writeAuditLog()` and `db.createAuditLog()` (`EMRsystem/server.js`, `EMRsystem/db.js`).

## CI/CD & Deployment

**Hosting:**
- Render web service for API: `render.yaml` defines service `emrsystem-api`, `env: node`, `rootDir: EMRsystem`, `buildCommand: npm install`, `startCommand: npm start`, and `healthCheckPath: /api/health`.
- Vercel static frontend: root `vercel.json` builds root project and serves `EMRsystem/dist`; `EMRsystem/vercel.json` serves `EMRsystem/dist`; `VercelFrontend/vercel.json` uses `@vercel/static` routes.
- Neon Postgres: documented deployment target in `EMRsystem/DEPLOYMENT.md` and implied by `EMRsystem/db.js` error messaging.

**CI Pipeline:**
- None detected. No GitHub Actions, GitLab CI, CircleCI, or equivalent config found during tech scan.

## Environment Configuration

**Required env vars:**
- `DATABASE_URL` - required by `EMRsystem/db.js` for all database queries; should be the Postgres/Neon connection string.

**Optional/runtime env vars:**
- `PORT` - server port; defaults to `3000` in `EMRsystem/server.js`.
- `FRONTEND_URL` - used for generated registration/invite links and CORS-adjacent URL generation in `EMRsystem/server.js`.
- `APP_TIME_ZONE` - date calculations; defaults to `Asia/Manila` in `EMRsystem/server.js`.
- `ROBOFLOW_API_KEY` - enables Roboflow ID detection/cropping in `EMRsystem/server.js`.
- `NODE_VERSION` - Render deployment sets this to `20` in `render.yaml`.
- `API_BASE_URL` - used only by ad hoc scripts `EMRsystem/test-cp-abe.js` and `EMRsystem/setup-test-accounts.js`.

**Secrets location:**
- Local: `.env` is expected beside `EMRsystem/server.js` because `dotenv` loads at startup; `.env` and `*.env` are ignored by `EMRsystem/.gitignore`.
- Production: Render environment variables are declared with `sync: false` in `render.yaml` for `DATABASE_URL`, `FRONTEND_URL`, and `ROBOFLOW_API_KEY`.
- `.env.example` exists at `EMRsystem/.env.example`; contents were not read.

## Webhooks & Callbacks

**Incoming:**
- No third-party webhook receiver routes detected. All exposed routes are app APIs under `/api/*` in `EMRsystem/server.js`.

**Outgoing:**
- Roboflow HTTP POST from `detectAndValidateIdCardWithRoboflow()` in `EMRsystem/server.js`.
- No email/SMS provider integration detected; password reset and notification flows persist in-app notifications to Postgres (`EMRsystem/server.js`, `EMRsystem/db.js`).

## Cross-Directory Duplication and Integration Points

- `EMRsystem/api-config.js` and `VercelFrontend/api-config.js` contain the same API base URL logic and hardcoded Render API target.
- `EMRsystem/app.js` and `VercelFrontend/auth-client.js` contain the same auth client logic; `EMRsystem/scripts/build-static.js` copies `EMRsystem/app.js` to `VercelFrontend/auth-client.js`.
- `EMRsystem/scripts/build-static.js` is the canonical bridge from backend/static source files to `EMRsystem/dist` and `VercelFrontend`.
- Root `package.json` delegates all local `build`, `start`, and `dev` commands to `EMRsystem`, while root `vercel.json` expects the build output at `EMRsystem/dist`.

---

*Integration audit: 2026-05-31*
