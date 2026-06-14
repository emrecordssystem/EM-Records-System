# Architecture

**Analysis Date:** Sun May 31 2026

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│ Static multi-page EMR frontend                              │
│ `EMRsystem/*.html`, generated copy `VercelFrontend/*.html`  │
├──────────────┬──────────────┬──────────────┬────────────────┤
│ Patient UI   │ Doctor UI    │ Staff UI     │ Admin UI       │
│ `dashboard.html` │ `doctor-dashboard.html` │ `staff.html` │ `admin-dashboard.html` │
└──────┬───────┴──────┬───────┴──────┬───────┴───────┬────────┘
       │              │              │               │
       ▼              ▼              ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│ Browser API routing / session shim                          │
│ `EMRsystem/api-config.js` + browser `localStorage.authUser` │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Express API monolith                                        │
│ `EMRsystem/server.js`                                       │
├─────────────────────────────────────────────────────────────┤
│ Database/access layer + CP-ABE-like encryption helpers       │
│ `EMRsystem/db.js`                                           │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Neon/PostgreSQL storage (`DATABASE_URL`)                     │
│ tables initialized by `EMRsystem/db.js`                      │
└─────────────────────────────────────────────────────────────┘
```

## High-Level Purpose and User Roles

The application is an EMR-style patient management system with static HTML dashboards and a Node/Express backend. Visible roles are `admin`, `doctor`, `patient`, and `staff` from registration validation in `EMRsystem/server.js:220`, role-specific profile creation in `EMRsystem/server.js:294`, `EMRsystem/server.js:334`, `EMRsystem/server.js:341`, and role-gated dashboards in `EMRsystem/dashboard.html:1164`, `EMRsystem/doctor-dashboard.html:1130`, `EMRsystem/staff.html:675`, and `EMRsystem/admin-dashboard.html:2246`.

Primary capabilities:
- Patient registration with Philippine National ID OCR and admin approval: `EMRsystem/register.html:345`, `EMRsystem/server.js:2282`, `EMRsystem/server.js:287`.
- Health assessment capture and encrypted storage: `EMRsystem/assessment.html:221`, `EMRsystem/server.js:372`, `EMRsystem/db.js:745`.
- Consultation scheduling, doctor availability, and notifications: `EMRsystem/server.js:394`, `EMRsystem/server.js:3912`, `EMRsystem/server.js:134`.
- Doctor EMR review, diagnostics, prescription, patient record files: `EMRsystem/doctor-dashboard.html:1241`, `EMRsystem/server.js:4015`, `EMRsystem/server.js:3791`.
- Admin user/EMR/report/audit management: `EMRsystem/admin-dashboard.html:2272`, `EMRsystem/server.js:1165`, `EMRsystem/server.js:1227`, `EMRsystem/server.js:1727`.
- Staff queue/schedule support and patient invite generation: `EMRsystem/staff.html:674`, `EMRsystem/server.js:953`, `EMRsystem/server.js:1011`.

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Root launcher | Delegates root `npm` scripts to `EMRsystem`; serves built/static frontend fallback for platforms that run root `index.js`. | `package.json`, `index.js` |
| Express API | Owns HTTP routes, validation, role checks, OCR, notification orchestration, consultation workflows, and static serving for local dev. | `EMRsystem/server.js` |
| Data access layer | Owns PostgreSQL pool, schema initialization, user/profile/consultation/report queries, assessment encryption/decryption. | `EMRsystem/db.js` |
| Build copier | Copies canonical static assets from `EMRsystem` to `EMRsystem/dist` and `VercelFrontend`. | `EMRsystem/scripts/build-static.js` |
| API config shim | Sets `window.PROFELECT_API_BASE_URL` and rewrites `/api/*` browser fetches to local or Render API URL. | `EMRsystem/api-config.js`, `VercelFrontend/api-config.js` |
| Auth client | Legacy login client copied from `EMRsystem/app.js` to generated `auth-client.js`. | `EMRsystem/app.js`, `VercelFrontend/auth-client.js` |
| Patient frontend | Patient portal for profile, consultations, notifications, QR, EMR, and uploaded record files. | `EMRsystem/dashboard.html` |
| Doctor frontend | Doctor dashboard for consultations, availability, records, diagnostics reports, QR patient lookup, profile. | `EMRsystem/doctor-dashboard.html` |
| Staff frontend | Staff dashboard for schedule queues, priority labels, invites, and prescription printing. | `EMRsystem/staff.html` |
| Admin frontend | Admin dashboard for stats, users, EMR records, consultations, QR/invites, access permissions, audit logs, password resets, reports. | `EMRsystem/admin-dashboard.html` |

## Pattern Overview

**Overall:** Static multi-page frontend + Express monolith + PostgreSQL data gateway.

**Key Characteristics:**
- Keep canonical application files in `EMRsystem/`; `VercelFrontend/` is a generated/static deployment copy created by `EMRsystem/scripts/build-static.js:5`.
- Use page-local JavaScript inside each HTML page for UI state and API calls instead of a bundled SPA framework, for example `EMRsystem/dashboard.html:1107` and `EMRsystem/admin-dashboard.html:2242`.
- Use `localStorage.authUser` as the browser session object and send `userId` in request bodies/query strings for authorization checks, for example `EMRsystem/dashboard.html:1109`, `EMRsystem/server.js:401`, and `EMRsystem/server.js:932`.
- Centralize persistence behind `EMRsystem/db.js`; route handlers call named helpers like `db.createConsultation`, `db.getPatientEMR`, and `db.getAdminStats` rather than embedding all SQL in frontend code.

## Layers

**Static frontend layer:**
- Purpose: Render role-specific pages, store the minimal browser session, call JSON APIs, and display dashboards.
- Location: `EMRsystem/*.html`, `EMRsystem/styles.css`, `EMRsystem/api-config.js`, `EMRsystem/password-toggle.js`, `EMRsystem/qrcode.min.js`.
- Contains: Plain HTML, CSS, inline scripts, browser `fetch`, `localStorage` session checks.
- Depends on: `window.PROFELECT_API_BASE_URL` from `EMRsystem/api-config.js:6` and backend `/api/*` routes.
- Used by: Local Express static hosting in `EMRsystem/server.js:169`, Vercel static deployment via `VercelFrontend/`, and root static server fallback in `index.js:6`.

**Backend API layer:**
- Purpose: Validate input, enforce role checks, orchestrate DB changes, generate QR codes, run OCR/image processing, emit notifications/audit logs.
- Location: `EMRsystem/server.js`.
- Contains: 59 route handlers including public registration, auth, patient, staff, admin, OCR, and doctor modules.
- Depends on: `express`, `cors`, `qrcode`, `sharp`, `tesseract.js`, `form-data`, `crypto`, `fs`, `path`, and `./db` from `EMRsystem/server.js:1`.
- Used by: All role pages through `fetch` calls and by deployment health checks at `EMRsystem/server.js:4133`.

**Data/persistence layer:**
- Purpose: Create/migrate tables, translate `?` SQL placeholders to PostgreSQL `$n`, hash passwords, encrypt/decrypt assessments, perform all query helpers.
- Location: `EMRsystem/db.js`.
- Contains: `Pool` setup at `EMRsystem/db.js:5`, schema creation in `init()` at `EMRsystem/db.js:130`, and exported helper functions at `EMRsystem/db.js:1578`.
- Depends on: PostgreSQL `DATABASE_URL`, `pg`, `bcryptjs`, `crypto`.
- Used by: `EMRsystem/server.js:11`.

**Deployment/static build layer:**
- Purpose: Copy canonical first-party static files into deployable locations and provide platform config.
- Location: `EMRsystem/scripts/build-static.js`, `EMRsystem/vercel.json`, `VercelFrontend/vercel.json`, `render.yaml`, root `index.js`.
- Contains: Static file list in `EMRsystem/scripts/build-static.js:9`, output directories in `EMRsystem/scripts/build-static.js:5`, Render service config in `render.yaml:1`.
- Depends on: Node filesystem APIs.
- Used by: `npm run build` in `EMRsystem/package.json:7` and root `package.json:6`.

## Backend Architecture and Key Endpoints

`EMRsystem/server.js` is organized as route clusters in one file:
- Public registration QR: `GET /api/public-registration-qr` at `EMRsystem/server.js:171`.
- Registration and login: `POST /api/register` at `EMRsystem/server.js:182`; `POST /api/login` at `EMRsystem/server.js:834`; `POST /api/forgot-password` at `EMRsystem/server.js:892`.
- Patient assessment and dashboard: `POST /api/assessment` at `EMRsystem/server.js:372`; `POST /api/consultation-request` at `EMRsystem/server.js:394`; `GET /api/my-consultations` at `EMRsystem/server.js:486`; `GET /api/my-qr` at `EMRsystem/server.js:611`; `GET /api/my-emr` at `EMRsystem/server.js:632`; profile endpoints at `EMRsystem/server.js:800` and `EMRsystem/server.js:819`.
- Patient files: `GET /api/patient-record-files` at `EMRsystem/server.js:681`; `POST /api/patient-record-files` at `EMRsystem/server.js:706`; `GET /api/patient-record-files/:id` at `EMRsystem/server.js:764`.
- Staff workflow: `POST /api/staff/invite` at `EMRsystem/server.js:953`; schedules at `EMRsystem/server.js:1011`; consultations at `EMRsystem/server.js:1035`; staff scheduling at `EMRsystem/server.js:1055`; staff prescription update at `EMRsystem/server.js:1121`.
- Admin workflow: stats/reports/users/EMR/consultations/audit/QR/access/password-reset routes from `EMRsystem/server.js:1165` through `EMRsystem/server.js:1801`.
- OCR: `POST /api/scan-id` at `EMRsystem/server.js:2282`.
- Doctor workflow: consultation list/detail/update at `EMRsystem/server.js:3740`, `EMRsystem/server.js:3761`, `EMRsystem/server.js:3791`; diagnostics reports at `EMRsystem/server.js:3909`; availability at `EMRsystem/server.js:3912`; patient EMR at `EMRsystem/server.js:4015`; doctor profile at `EMRsystem/server.js:4052`; patient list at `EMRsystem/server.js:4091`.
- Health check: `GET /api/health` at `EMRsystem/server.js:4133`.

## Frontend Architecture and Key Pages/Scripts

Use static, page-specific scripts:
- `EMRsystem/index.html`: public landing page with registration QR fetch (`VercelFrontend/index.html:156` mirrors it).
- `EMRsystem/login.html`, `EMRsystem/simple-login.html`, `EMRsystem/doctor-login.html`, `EMRsystem/staff-login.html`: role-oriented login variants that set `localStorage.authUser`; `EMRsystem/app.js:74` is a shared/legacy auth client copied as `auth-client.js` during static build.
- `EMRsystem/register.html`: patient registration and ID OCR upload flow; includes CDN Tesseract script at `EMRsystem/register.html:202` but sends the compressed image to server OCR at `EMRsystem/register.html:345`.
- `EMRsystem/assessment.html`: post-registration health questionnaire; saves to `/api/assessment` at `EMRsystem/assessment.html:221`.
- `EMRsystem/dashboard.html`: patient portal; checks `authUser.role === 'patient'` at `EMRsystem/dashboard.html:1164` and loads consultations, availability, notifications, EMR, QR, profile, and record files.
- `EMRsystem/doctor-dashboard.html`: doctor portal; checks `authUser.role === 'doctor'` at `EMRsystem/doctor-dashboard.html:1130` and handles consultations, patient files, reports, schedules, notifications, profile.
- `EMRsystem/staff.html`: staff portal; checks `authUser.role === 'staff'` at `EMRsystem/staff.html:675`, calls `/api/staff/schedules` and `/api/staff/consultations` at `EMRsystem/staff.html:682`.
- `EMRsystem/admin-dashboard.html`: admin portal; checks `authUser.role === 'admin'` at `EMRsystem/admin-dashboard.html:2246`, loads sections through `switchSection()` at `EMRsystem/admin-dashboard.html:2272`.
- `EMRsystem/api-config.js`: required on static pages; chooses `http://localhost:3000` for localhost and `https://emrsystem-9gng.onrender.com` otherwise at `EMRsystem/api-config.js:2`.

## Authentication, Session, and Authorization Architecture

**Authentication:** `POST /api/login` validates email/password with `db.validateCredentials()` and returns `{ id, role, email, displayName }` without a server-side session or token (`EMRsystem/server.js:865`, `EMRsystem/server.js:884`). Passwords are hashed with bcrypt in `EMRsystem/db.js:376`.

**Browser session:** Pages persist the returned user object in `localStorage.authUser` and redirect based on `role`, for example `EMRsystem/app.js:95`, `EMRsystem/dashboard.html:1109`, and `EMRsystem/admin-dashboard.html:2244`.

**Authorization:** Most endpoints accept `userId` as a query parameter or JSON body and then retrieve the user and check `role`, for example patient consultation submission (`EMRsystem/server.js:401`), admin invite generation (`EMRsystem/server.js:931`), doctor consultation list (`EMRsystem/server.js:3747`), and staff invite generation (`EMRsystem/server.js:960`). Preserve this pattern when adding endpoints unless the auth architecture is intentionally replaced.

**Approval/status:** Patient registrations are created as `status: pending` and `emailVerified: false` at `EMRsystem/server.js:287`; login blocks pending and inactive accounts at `EMRsystem/server.js:846`.

## Medical Record, OCR, ABE, and Blockchain-Related Flows

**Medical record flow:** Patient profile and assessment data live in `patients` and `patient_assessments` tables (`EMRsystem/db.js:157`, `EMRsystem/db.js:205`). Patient EMR reads use `GET /api/my-emr` (`EMRsystem/server.js:632`) and doctor EMR reads use `GET /api/doctor/patient/:patientId` (`EMRsystem/server.js:4015`). Uploaded medical documents are stored in `patient_record_files.file_data` as base64/text in PostgreSQL (`EMRsystem/db.js:346`, `EMRsystem/db.js:1153`).

**OCR flow:** `EMRsystem/register.html` compresses selected ID images client-side (`EMRsystem/register.html:282`) and posts `imageBase64` to `/api/scan-id` (`EMRsystem/register.html:345`). `EMRsystem/server.js` validates portrait area with Sharp (`EMRsystem/server.js:2053`), optionally calls Roboflow when `ROBOFLOW_API_KEY` exists (`EMRsystem/server.js:1822`, `EMRsystem/server.js:2334`), preprocesses with Sharp and runs multiple Tesseract page segmentation modes (`EMRsystem/server.js:1884`, `EMRsystem/server.js:1901`), then parses and scores Philippine National ID fields.

**ABE/CP-ABE flow:** The code labels assessment protection as CP-ABE but implements local AES-256-GCM encryption with a derived patient key and policy string in `EMRsystem/db.js:12`, `EMRsystem/db.js:22`, and `EMRsystem/db.js:748`. Access policy permits doctors or the matching patient (`EMRsystem/db.js:71`), and explicitly blocks admin assessment decryption (`EMRsystem/db.js:776`). Doctor EMR retrieval attempts policy-checked decryption at `EMRsystem/server.js:4034`.

**Blockchain:** Not detected in first-party backend files. Searches of `EMRsystem/server.js` and `EMRsystem/db.js` did not find blockchain/ledger implementation. Treat blockchain references, if any appear in UI copy or planning docs, as not implemented in runtime code unless new first-party files are added.

## Data Model and Storage Architecture

Storage is PostgreSQL through `pg.Pool` in `EMRsystem/db.js:5`; `DATABASE_URL` is required by query helpers (`EMRsystem/db.js:94`, `EMRsystem/db.js:112`). `EMRsystem/README.md:3` still describes SQLite, but runtime code uses PostgreSQL/Neon semantics including `SERIAL`, `ILIKE`, `RETURNING`, and `expires_at::timestamptz` in `EMRsystem/db.js`.

Tables initialized by `db.init()` include:
- `users`: core account table with role, email, password hash, display name, status, email verification (`EMRsystem/db.js:131`).
- `invites`: invite/QR tokens (`EMRsystem/db.js:145`).
- `patients`: demographic and ID/profile fields (`EMRsystem/db.js:157`).
- `login_otps`: OTP table present in schema/helpers but not wired to `/api/login` flow (`EMRsystem/db.js:192`).
- `patient_assessments`: raw JSON plus encrypted assessment and policy (`EMRsystem/db.js:205`).
- `consultations`: patient-doctor workflow, status, schedule, notes, diagnostic result, prescription (`EMRsystem/db.js:220`).
- `doctor_availability`: doctor schedule slots as JSON text (`EMRsystem/db.js:250`).
- `doctor_profiles`, `staff_profiles`: role-specific profile metadata (`EMRsystem/db.js:261`, `EMRsystem/db.js:272`).
- `notifications`: in-app notifications (`EMRsystem/db.js:283`).
- `password_reset_requests`: admin-mediated password reset (`EMRsystem/db.js:299`).
- `reschedule_requests`: consultation reschedule requests (`EMRsystem/db.js:313`).
- `message_board`: message storage; table exists and reports count it, but route coverage is not prominent in `EMRsystem/server.js` (`EMRsystem/db.js:330`).
- `patient_record_files`: base64/file-data storage for uploaded documents (`EMRsystem/db.js:345`).
- `audit_logs`: user/action/resource/status records (`EMRsystem/db.js:361`).

## Major Runtime Flows

### Patient Registration with OCR and Admin Approval

1. User opens `EMRsystem/register.html` and selects a National ID image.
2. Browser compresses the image via canvas (`EMRsystem/register.html:282`) and posts to `/api/scan-id` (`EMRsystem/register.html:345`).
3. Backend checks known fixtures, validates portrait, optionally runs Roboflow, runs Sharp/Tesseract OCR, and returns parsed fields (`EMRsystem/server.js:2282`).
4. Browser submits `/api/register` with role/profile fields (`EMRsystem/register.html:725`).
5. Backend validates patient fields, creates `users` status `pending`, creates `patients`, notifies admins, and returns review message (`EMRsystem/server.js:282`, `EMRsystem/server.js:317`, `EMRsystem/server.js:355`).

### Login and Role Dashboard Routing

1. Login page posts credentials to `/api/login` (`EMRsystem/app.js:84` or page-local login scripts).
2. Backend blocks pending/inactive accounts, validates bcrypt hash, writes audit log, returns user object (`EMRsystem/server.js:846`, `EMRsystem/server.js:865`, `EMRsystem/server.js:876`).
3. Browser stores `localStorage.authUser` and redirects by role (`EMRsystem/app.js:95`).
4. Target dashboards enforce role again on load using `localStorage.authUser` (`EMRsystem/dashboard.html:1164`, `EMRsystem/doctor-dashboard.html:1130`, `EMRsystem/staff.html:675`, `EMRsystem/admin-dashboard.html:2246`).

### Assessment Save and Protected EMR Access

1. Patient completes questionnaire in `EMRsystem/assessment.html:74`.
2. Browser posts `{ userId, answers }` to `/api/assessment` (`EMRsystem/assessment.html:221`).
3. Backend validates user and calls `db.createPatientAssessment` (`EMRsystem/server.js:379`, `EMRsystem/server.js:384`).
4. DB helper stores plaintext JSON plus AES-GCM encrypted JSON and policy `role:doctor OR userId:{userId}` (`EMRsystem/db.js:748`).
5. Doctor EMR view calls `/api/doctor/patient/:patientId`; backend verifies doctor role and policy-decrypts assessment (`EMRsystem/server.js:4024`, `EMRsystem/server.js:4034`).

### Consultation Request and Scheduling

1. Patient portal posts concerns/date/time to `/api/consultation-request` (`EMRsystem/dashboard.html:1334`).
2. Backend verifies patient, rejects past dates and existing active consultations, finds an available doctor, checks daily and slot capacity (`EMRsystem/server.js:401`, `EMRsystem/server.js:411`, `EMRsystem/server.js:422`, `EMRsystem/server.js:465`).
3. Backend creates consultation and notifications for patient and doctor (`EMRsystem/server.js:468`, `EMRsystem/server.js:469`).
4. Doctor dashboard loads `/api/doctor/consultations` and updates status/diagnostics/prescription via `/api/doctor/consultation/:id` (`EMRsystem/doctor-dashboard.html:1364`, `EMRsystem/doctor-dashboard.html:1688`).
5. Staff dashboard can load queues and set schedule through `/api/consultations/:id/schedule` (`EMRsystem/staff.html:682`, `EMRsystem/staff.html:704`).

### Static Build and Deployment Flow

1. Root `npm run build` delegates to `EMRsystem` (`package.json:6`).
2. `EMRsystem/scripts/build-static.js` copies canonical static files to `EMRsystem/dist` and `VercelFrontend` (`EMRsystem/scripts/build-static.js:5`, `EMRsystem/scripts/build-static.js:58`).
3. `EMRsystem/vercel.json` serves `EMRsystem/dist` on Vercel (`EMRsystem/vercel.json:1`), while `VercelFrontend/vercel.json` is a standalone static config (`VercelFrontend/vercel.json:1`).
4. Render runs the backend from `EMRsystem` using `npm start` and health check `/api/health` (`render.yaml:6`, `render.yaml:8`, `render.yaml:9`).

## Key Abstractions

**Role-specific users:**
- Purpose: One `users` record per account plus optional role profile.
- Examples: `EMRsystem/db.js:131`, `EMRsystem/db.js:157`, `EMRsystem/db.js:261`, `EMRsystem/db.js:272`.
- Pattern: Check `user.role` in each route before returning data.

**Consultation:**
- Purpose: Central workflow record connecting patient, doctor, schedule, status, diagnostic result, and prescription.
- Examples: `EMRsystem/db.js:220`, `EMRsystem/server.js:394`, `EMRsystem/server.js:3791`.
- Pattern: Status transitions plus notifications; enforce one active consultation per patient and daily/slot capacity per doctor.

**Notification:**
- Purpose: In-app updates for registration review, consultation changes, password reset, overdue consultations.
- Examples: `EMRsystem/db.js:283`, `EMRsystem/server.js:134`, `EMRsystem/server.js:469`.
- Pattern: `db.createNotification()` from backend actions, read through `/api/notifications`, mark read through `/api/notifications/:id/read`.

**Protected assessment:**
- Purpose: Health assessment answers with policy-tagged encryption.
- Examples: `EMRsystem/db.js:745`, `EMRsystem/db.js:760`.
- Pattern: Store JSON and encrypted copy; call `getPatientAssessmentByUserId(userId, requestingUser)` for policy checks.

## Entry Points

**Local backend and static app:**
- Location: `EMRsystem/server.js`.
- Triggers: `npm --prefix EMRsystem start` or root `npm start` via `package.json:7`.
- Responsibilities: Initialize DB (`EMRsystem/server.js:4144`), listen on `PORT`, serve static files (`EMRsystem/server.js:169`), serve APIs.

**Root static frontend server:**
- Location: `index.js`.
- Triggers: Platforms running root `node index.js`.
- Responsibilities: Serve `EMRsystem/dist` if present, otherwise `VercelFrontend`, with SPA-like fallback to `index.html` (`index.js:20`, `index.js:52`).

**Static build:**
- Location: `EMRsystem/scripts/build-static.js`.
- Triggers: `npm --prefix EMRsystem run build` or root `npm run build`.
- Responsibilities: Copy static assets to deployment directories and write Vercel static config (`EMRsystem/scripts/build-static.js:54`).

**Production backend deployment:**
- Location: `render.yaml`.
- Triggers: Render service deployment.
- Responsibilities: Use `EMRsystem` as root, install dependencies, start Express, supply `DATABASE_URL`, `FRONTEND_URL`, and optional `ROBOFLOW_API_KEY` (`render.yaml:6`).

## Architectural Constraints

- **Threading:** Single Node.js event loop; CPU-heavy OCR/image processing with Sharp and Tesseract happens inside request handling for `/api/scan-id` (`EMRsystem/server.js:2282`).
- **Global state:** `knownOriginalNationalIdHashes` caches fixture hashes in module scope (`EMRsystem/server.js:2207`); `MASTER_KEY` is generated randomly at process startup but not used in key derivation (`EMRsystem/db.js:13`); `pg.Pool` is module-global (`EMRsystem/db.js:5`).
- **Auth trust boundary:** Browser-supplied `userId` is the effective credential for many API calls. Add new endpoints consistently if maintaining current architecture, or replace this globally with tokens/sessions in a dedicated security phase.
- **Static duplication:** Modify canonical files in `EMRsystem/` first, then run/copy build outputs. Direct edits in `VercelFrontend/` are overwritten by `EMRsystem/scripts/build-static.js`.
- **Database:** `DATABASE_URL` is mandatory; despite README references, no first-party SQLite runtime is active in `EMRsystem/db.js`.
- **File storage:** Uploaded record files are stored in DB as text/base64, not on disk or object storage (`EMRsystem/db.js:353`).
- **Circular imports:** Not detected; `EMRsystem/server.js` imports `EMRsystem/db.js`, while `EMRsystem/db.js` does not import `server.js`.

## Anti-Patterns

### Editing Generated Static Copies First

**What happens:** `VercelFrontend/*.html`, `VercelFrontend/api-config.js`, and `VercelFrontend/styles.css` mirror `EMRsystem/*` and are produced by `EMRsystem/scripts/build-static.js`.
**Why it's wrong:** Changes made only in `VercelFrontend/` are not canonical and are overwritten when the build copier runs.
**Do this instead:** Edit `EMRsystem/<file>` and run the static build so `EMRsystem/dist` and `VercelFrontend/` refresh (`EMRsystem/scripts/build-static.js:58`).

### Adding Backend Logic to Frontend Pages

**What happens:** Large inline scripts already make pages heavy, but persistence/security/OCR decisions belong in `EMRsystem/server.js` and `EMRsystem/db.js`.
**Why it's wrong:** Frontend checks are bypassable; role enforcement already happens server-side by loading users from DB.
**Do this instead:** Add validation and authorization in the route handler (`EMRsystem/server.js`) and use a `db.js` helper for storage.

### Assuming Server Sessions Exist

**What happens:** `/api/login` explicitly notes that a real session/token is not issued (`EMRsystem/server.js:884`).
**Why it's wrong:** New endpoints that assume cookies/JWT will not integrate with existing pages.
**Do this instead:** Either follow current `userId` + role-check pattern or implement a full authentication migration across `EMRsystem/server.js` and all page scripts.

## Error Handling

**Strategy:** Route handlers use `try/catch`, log with `console.error`, and return JSON `{ success: false, message }` with appropriate HTTP status. Business validation often returns `400`, role failures return `403`, missing records return `404`, conflicts return `409`, and unexpected failures return `500`.

**Patterns:**
- Use early returns for validation and authorization, as in `EMRsystem/server.js:212`, `EMRsystem/server.js:401`, and `EMRsystem/server.js:932`.
- Attach `statusCode` to thrown business errors for consultation capacity checks (`EMRsystem/server.js:117`, `EMRsystem/server.js:128`) and use it in route catch blocks (`EMRsystem/server.js:482`).
- Audit log failures are swallowed after logging so core actions continue (`EMRsystem/server.js:158`).
- Frontend pages parse JSON and surface `data.message` or fall back to generic messages, for example `EMRsystem/staff.html:536` and `EMRsystem/assessment.html:226`.

## Cross-Cutting Concerns

**Logging:** Use `console.error`, `console.warn`, and selected `console.log` debug logs in `EMRsystem/server.js`; audit logs are persisted through `db.createAuditLog` and admin-visible through `/api/admin/audit-logs` (`EMRsystem/server.js:1727`).

**Validation:** Use explicit helper functions for names/digits/email/date in `EMRsystem/server.js:85`; endpoint-local checks for required fields; OCR-specific validation in `EMRsystem/server.js:1971` and `EMRsystem/server.js:2053`.

**Authentication:** Password authentication with bcrypt in `EMRsystem/db.js:376`; browser session in `localStorage.authUser`; role checks in route handlers.

**Configuration:** Environment comes from `.env` loaded by `dotenv` in `EMRsystem/server.js:1`, Render env vars in `render.yaml:10`, and browser API routing in `EMRsystem/api-config.js:2`.

---

*Architecture analysis: Sun May 31 2026*
