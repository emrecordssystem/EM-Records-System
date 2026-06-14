# Codebase Structure

**Analysis Date:** Sun May 31 2026

## Directory Layout

```text
EMRecords-main/
├── package.json                 # Root launcher scripts delegating to EMRsystem
├── index.js                     # Root static server for EMRsystem/dist or VercelFrontend fallback
├── render.yaml                  # Render backend deployment config
├── vercel.json                  # Root Vercel-related config
├── README.md                    # Root README (binary/unreadable in current environment)
├── EMRsystem/                   # Canonical first-party app: Express API, DB layer, static pages, build script
│   ├── package.json             # Backend/static build scripts and dependencies
│   ├── server.js                # Express API monolith and local static host
│   ├── db.js                    # PostgreSQL schema, query helpers, assessment encryption
│   ├── app.js                   # Legacy/shared auth client; copied to auth-client.js during build
│   ├── api-config.js            # Browser API base URL and /api fetch rewrite shim
│   ├── *.html                   # Static role pages and dashboards
│   ├── styles.css               # Shared page styles
│   ├── password-toggle.js       # Shared password visibility behavior
│   ├── qrcode.min.js            # Vendored QR browser library for static pages
│   ├── scripts/build-static.js  # Static asset copier to dist and VercelFrontend
│   ├── test-*.js                # Manual test scripts for OCR/CP-ABE flows
│   ├── setup-test-accounts.js   # Manual account setup helper
│   └── node_modules/            # Dependency/vendor directory; do not edit
└── VercelFrontend/              # Generated/static deployment copy of EMRsystem frontend files
    ├── package.json             # Static frontend build script
    ├── vercel.json              # Standalone Vercel static config
    ├── auth-client.js           # Generated copy of EMRsystem/app.js
    ├── api-config.js            # Generated copy of EMRsystem/api-config.js
    ├── *.html                   # Generated copies of EMRsystem static pages
    └── styles.css               # Generated copy of EMRsystem/styles.css
```

## Directory Purposes

**Root (`D:\Desktop\EMRecords-main`):**
- Purpose: Launcher/deployment wrapper around the canonical `EMRsystem/` application.
- Contains: Root `package.json`, `index.js`, `render.yaml`, root `vercel.json`, `.gitignore`, planning output.
- Key files: `package.json`, `index.js`, `render.yaml`.

**`EMRsystem/`:**
- Purpose: Canonical source for the backend API, database layer, static frontend pages, and static build process.
- Contains: Express server, PostgreSQL data access, static HTML/CSS/JS, docs/manual tests, dependency lockfile, `node_modules/`.
- Key files: `EMRsystem/server.js`, `EMRsystem/db.js`, `EMRsystem/scripts/build-static.js`, `EMRsystem/api-config.js`, `EMRsystem/package.json`.

**`EMRsystem/scripts/`:**
- Purpose: Build/deployment utilities.
- Contains: `EMRsystem/scripts/build-static.js` static copier.
- Key files: `EMRsystem/scripts/build-static.js`.

**`VercelFrontend/`:**
- Purpose: Static deployment copy for Vercel or fallback static hosting.
- Contains: Copies of first-party static pages/assets from `EMRsystem/`; standalone `package.json`; generated `auth-client.js` copy of `EMRsystem/app.js`.
- Key files: `VercelFrontend/index.html`, `VercelFrontend/api-config.js`, `VercelFrontend/vercel.json`.

**`.planning/codebase/`:**
- Purpose: GSD codebase map output consumed by planning/execution commands.
- Contains: `ARCHITECTURE.md` and `STRUCTURE.md` for this focus.
- Key files: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`.

## Key File Locations

**Entry Points:**
- `EMRsystem/server.js`: Main backend/local app entry point; initializes DB and listens when run directly (`EMRsystem/server.js:4141`).
- `index.js`: Root static frontend server; selects `EMRsystem/dist` if built, otherwise `VercelFrontend` (`index.js:20`).
- `EMRsystem/scripts/build-static.js`: Static build entry point that copies canonical frontend files (`EMRsystem/scripts/build-static.js:54`).
- `EMRsystem/index.html`: Public landing/registration QR entry page.
- `EMRsystem/login.html`: General login page.
- `EMRsystem/register.html`: Patient registration/OCR entry page.
- `EMRsystem/dashboard.html`: Patient dashboard entry page.
- `EMRsystem/doctor-dashboard.html`: Doctor dashboard entry page.
- `EMRsystem/staff.html`: Staff dashboard entry page.
- `EMRsystem/admin-dashboard.html`: Admin dashboard entry page.

**Configuration:**
- `package.json`: Root scripts (`build`, `start`, `dev`) delegate to `EMRsystem`.
- `EMRsystem/package.json`: Backend dependencies and scripts (`build`, `start`, `dev`).
- `VercelFrontend/package.json`: Static frontend build script.
- `EMRsystem/api-config.js`: Browser API base URL selection and fetch rewrite.
- `VercelFrontend/api-config.js`: Generated/static copy of `EMRsystem/api-config.js`.
- `EMRsystem/vercel.json`: Vercel build/output config for `EMRsystem/dist`.
- `VercelFrontend/vercel.json`: Standalone Vercel static config generated by build script.
- `render.yaml`: Render backend service config with `rootDir: EMRsystem`, `DATABASE_URL`, `FRONTEND_URL`, `ROBOFLOW_API_KEY`.
- `EMRsystem/.env.example`: Environment template; note existence only and do not copy secret values from real `.env` files.

**Core Logic:**
- `EMRsystem/server.js`: All API route handling, role checks, OCR parsing, QR generation, notifications, audit logging.
- `EMRsystem/db.js`: PostgreSQL schema and data helpers, password hashing, CP-ABE-labeled assessment encryption/decryption.
- `EMRsystem/app.js`: Login client helper used as generated `auth-client.js` in static outputs.

**Frontend Pages:**
- `EMRsystem/index.html`: Public landing and public registration QR fetch.
- `EMRsystem/register.html`: Registration form, client image compression, server OCR request, final registration submission.
- `EMRsystem/assessment.html`: Health questionnaire and `/api/assessment` submission.
- `EMRsystem/dashboard.html`: Patient portal sections and patient API calls.
- `EMRsystem/doctor-dashboard.html`: Doctor portal sections and doctor API calls.
- `EMRsystem/staff.html`: Staff queue/scheduling/invite portal.
- `EMRsystem/admin-dashboard.html`: Admin management/reporting portal.
- `EMRsystem/admin.html`: Admin-related page retained alongside dashboard.
- `EMRsystem/doctor-login.html`, `EMRsystem/doctor-register.html`, `EMRsystem/staff-login.html`, `EMRsystem/staff-register.html`, `EMRsystem/simple-login.html`, `EMRsystem/login.html`: Auth/register variants.

**Testing/Manual Verification:**
- `EMRsystem/test-ocr-improved.js`: Manual OCR test script.
- `EMRsystem/test-cp-abe.js`: Manual CP-ABE/encryption test script.
- `EMRsystem/setup-test-accounts.js`: Manual setup helper.
- No formal test runner config was identified during architecture mapping.

## Routing and Page Boundaries

**Backend HTTP routes:**
- Add or change API endpoints in `EMRsystem/server.js`; existing route groups are plain Express `app.get`, `app.post`, `app.put`, `app.patch`, and `app.delete` calls.
- Put persistence in `EMRsystem/db.js` helpers and call those helpers from `EMRsystem/server.js`.
- Keep API responses JSON-shaped as `{ success: true, ... }` or `{ success: false, message }` to match page scripts.

**Frontend page routing:**
- There is no client-side router. Each page is a separate `.html` document and navigation is via `window.location.href`, links, buttons, and static file paths.
- Root `index.js` uses a fallback-to-`index.html` behavior for unknown static paths (`index.js:52`), but the application itself expects named pages such as `dashboard.html` and `doctor-dashboard.html`.

**API base routing:**
- Static pages should load `api-config.js` before page scripts. It sets `window.PROFELECT_API_BASE_URL` and rewrites `/api/*` fetches (`EMRsystem/api-config.js:9`).
- Use `fetch(`${API_BASE_URL}/api/...`)` or relative `/api/...` with the shim; existing pages use both patterns.

## Duplicated and Generated Copies

`EMRsystem/scripts/build-static.js` defines the generated relationship:
- Output directories: `EMRsystem/dist` is cleaned; `VercelFrontend` is updated without cleaning (`EMRsystem/scripts/build-static.js:5`).
- Copied files: `admin-dashboard.html`, `admin.html`, `api-config.js`, `assessment.html`, `dashboard.html`, `doctor-dashboard.html`, `doctor-login.html`, `doctor-register.html`, `index.html`, `login.html`, `password-toggle.js`, `qrcode.min.js`, `register.html`, `simple-login.html`, `staff-login.html`, `staff-register.html`, `staff.html`, `styles.css` (`EMRsystem/scripts/build-static.js:9`).
- `EMRsystem/app.js` is copied to `auth-client.js` in output directories (`EMRsystem/scripts/build-static.js:62`).
- `vercel.json` is written into each output directory from a static config object (`EMRsystem/scripts/build-static.js:64`).

Hash comparison during mapping found these current relationships:
- Same between `EMRsystem/` and `VercelFrontend/`: `admin-dashboard.html`, `admin.html`, `api-config.js`, `assessment.html`, `dashboard.html`, `doctor-dashboard.html`, `doctor-login.html`, `doctor-register.html`, `index.html`, `login.html`, `password-toggle.js`, `qrcode.min.js`, `register.html`, `simple-login.html`, `staff-login.html`, `staff-register.html`, `staff.html`, `styles.css`.
- Different: `EMRsystem/vercel.json` and `VercelFrontend/vercel.json` intentionally use different deployment config styles.
- Generated-only name: `VercelFrontend/auth-client.js` corresponds to `EMRsystem/app.js`, not `EMRsystem/auth-client.js`.

## Entry Points for Local, Dev, and Production

**Local full app:**
```bash
npm start
```
- Runs root `package.json:7`, which delegates to `npm --prefix EMRsystem start`.
- Starts `EMRsystem/server.js`, initializes PostgreSQL schema, serves static files from `EMRsystem/`, and exposes `/api/*`.

**Local dev:**
```bash
npm run dev
```
- Runs root `package.json:8`, which delegates to `npm --prefix EMRsystem run dev`.
- `EMRsystem/package.json:9` also runs `node server.js`; there is no separate watcher.

**Static build:**
```bash
npm run build
```
- Runs root `package.json:6`, delegates to `EMRsystem/package.json:7`, and copies static files through `EMRsystem/scripts/build-static.js`.

**Render backend production:**
- Config: `render.yaml`.
- Root directory: `EMRsystem` (`render.yaml:6`).
- Build: `npm install` (`render.yaml:7`).
- Start: `npm start` (`render.yaml:8`).
- Health: `/api/health` (`render.yaml:9`).

**Vercel/static production:**
- Config path when deploying from `EMRsystem`: `EMRsystem/vercel.json`, output `dist`.
- Config path when deploying static copy: `VercelFrontend/vercel.json`.
- Static pages call Render backend URL unless hostname is localhost (`EMRsystem/api-config.js:2`).

**Root static server production/fallback:**
- Entry: `index.js`.
- Serves from `EMRsystem/dist` if `EMRsystem/dist/index.html` exists, otherwise `VercelFrontend` (`index.js:20`).

## Naming Conventions

**Files:**
- Static pages use kebab-case or role-dashboard names: `doctor-dashboard.html`, `staff-register.html`, `admin-dashboard.html`.
- Backend modules use short CommonJS names: `server.js`, `db.js`, `app.js`.
- Generated/static deployment copy preserves canonical filenames under `VercelFrontend/`.

**Directories:**
- `EMRsystem/` is the canonical app directory.
- `VercelFrontend/` is a generated static frontend directory.
- `scripts/` under `EMRsystem/` contains build tooling.
- `node_modules/` is dependency/vendor content; ignore for first-party changes.

**Functions and variables:**
- Backend uses camelCase helpers such as `ensureDoctorDailyCapacity`, `notifyOverduePendingConsultations`, and `writeAuditLog` in `EMRsystem/server.js`.
- DB helpers use action names like `createUser`, `getUserByEmail`, `updateConsultation`, `getAdminStats` in `EMRsystem/db.js`.

## Where to Add New Code

**New API endpoint:**
- Route handler: add to `EMRsystem/server.js` near the matching role/domain group.
- Data access: add helper to `EMRsystem/db.js` and export it from the `module.exports` block.
- Frontend caller: update the relevant canonical page in `EMRsystem/*.html`.
- Generated copy: run `npm run build` to refresh `VercelFrontend/` and `EMRsystem/dist` if static deployment needs the change.

**New database table/column:**
- Schema initialization/migration: add `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` inside `EMRsystem/db.js:init()`.
- Query helpers: add functions in `EMRsystem/db.js` next to related helpers.
- Route integration: call helpers from `EMRsystem/server.js`.

**New patient dashboard feature:**
- UI/script: `EMRsystem/dashboard.html`.
- Backend: patient or shared route in `EMRsystem/server.js`.
- DB: `EMRsystem/db.js`.
- Generated copy: `VercelFrontend/dashboard.html` after build.

**New doctor dashboard feature:**
- UI/script: `EMRsystem/doctor-dashboard.html`.
- Backend: doctor route group around `EMRsystem/server.js:3740`.
- DB: doctor/consultation helpers in `EMRsystem/db.js`.

**New staff workflow:**
- UI/script: `EMRsystem/staff.html`.
- Backend: staff route group around `EMRsystem/server.js:953` and schedule route `EMRsystem/server.js:1055`.
- DB: consultation/staff helpers in `EMRsystem/db.js`.

**New admin management/reporting feature:**
- UI/script: `EMRsystem/admin-dashboard.html`.
- Backend: admin route group around `EMRsystem/server.js:1165` through `EMRsystem/server.js:1801`.
- DB: admin/report helpers around `EMRsystem/db.js:1188`.

**New OCR/ID parsing behavior:**
- Client upload UX: `EMRsystem/register.html`.
- Server image/OCR logic: `EMRsystem/server.js` around `detectAndValidateIdCardWithRoboflow`, `runOcrAndParse`, and `/api/scan-id` (`EMRsystem/server.js:1822`, `EMRsystem/server.js:1884`, `EMRsystem/server.js:2282`).
- Manual tests: `EMRsystem/test-ocr-improved.js`.

**New static asset:**
- Source asset: add under `EMRsystem/` unless it is backend-only.
- Build copy list: add filename to `staticFiles` in `EMRsystem/scripts/build-static.js:9`.
- Generated copy: run `npm run build`.

**New shared frontend utility:**
- If loaded by pages directly: add `EMRsystem/<name>.js` and include it in pages plus `staticFiles` in `EMRsystem/scripts/build-static.js`.
- If replacing login helper: update `EMRsystem/app.js`; remember it becomes `auth-client.js` in generated outputs.

## Safe and Unsafe Modification Areas

**Usually safe to modify:**
- `EMRsystem/server.js`: Add route handlers and backend validation, keeping current JSON response and role-check patterns.
- `EMRsystem/db.js`: Add schema migrations and helpers, preserving `DATABASE_URL` checks and PostgreSQL placeholder conversion.
- `EMRsystem/*.html`: Canonical frontend pages; update these before generated copies.
- `EMRsystem/styles.css`: Shared styles for canonical pages.
- `EMRsystem/scripts/build-static.js`: Update when adding/removing static files from deployment outputs.
- `render.yaml`, `EMRsystem/vercel.json`: Deployment behavior, when intentionally changing platform setup.

**Be careful / coordinate changes:**
- `EMRsystem/api-config.js`: Affects every static page's backend target and fetch behavior.
- `EMRsystem/server.js` OCR section: CPU-heavy and validation-sensitive; changes can break registration.
- `EMRsystem/db.js` encryption helpers: Changes can make existing `patient_assessments.assessment_encrypted` undecryptable.
- `EMRsystem/db.js:init()`: Schema changes run on startup; invalid SQL can prevent the app from booting.
- `index.js`: Root static fallback behavior; affects deployments not using `EMRsystem/server.js`.

**Do not edit directly unless intentionally updating generated output:**
- `VercelFrontend/*.html`, `VercelFrontend/styles.css`, `VercelFrontend/api-config.js`, `VercelFrontend/password-toggle.js`, `VercelFrontend/qrcode.min.js`: Generated/static copies of `EMRsystem` files.
- `VercelFrontend/auth-client.js`: Generated from `EMRsystem/app.js`.
- `EMRsystem/dist/` if present: Build output.
- `EMRsystem/node_modules/`: Vendor dependencies.

## Special Directories and Files

**`EMRsystem/node_modules/`:**
- Purpose: Installed npm dependencies.
- Generated: Yes.
- Committed: Present in workspace; treat as vendor/dependency content and do not map or edit for first-party work.

**`VercelFrontend/`:**
- Purpose: Static deployable copy of canonical frontend.
- Generated: Yes, by `EMRsystem/scripts/build-static.js`.
- Committed: Present in workspace.

**`EMRsystem/dist/`:**
- Purpose: Vercel output directory for static frontend.
- Generated: Yes, by `EMRsystem/scripts/build-static.js`.
- Committed: Not observed in current file listing; create via build when needed.

**`.env` / `.env.*`:**
- Purpose: Environment configuration and secrets.
- Generated: Local/deployment-specific.
- Committed: Should not be committed. `EMRsystem/.env.example` exists as a template; do not read or quote real `.env` contents.

**Manual docs:**
- `EMRsystem/README.md`: Project notes; currently inconsistent with runtime DB implementation because it describes SQLite while `EMRsystem/db.js` uses PostgreSQL.
- `EMRsystem/OCR_IMPROVEMENTS.md`, `EMRsystem/OBJECTIVES.md`, `EMRsystem/DEPLOYMENT.md`, `EMRsystem/TODO.md`: Supporting documentation for development context.

---

*Structure analysis: Sun May 31 2026*
