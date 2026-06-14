# Technology Stack

**Analysis Date:** 2026-05-31

## Languages

**Primary:**
- JavaScript (CommonJS on backend, browser scripts on frontend) - `EMRsystem/server.js`, `EMRsystem/db.js`, `EMRsystem/app.js`, `VercelFrontend/auth-client.js`.
- HTML/CSS - static pages and styles in `EMRsystem/*.html`, `EMRsystem/styles.css`, duplicated/deployed from `VercelFrontend/*.html` and `VercelFrontend/styles.css`.

**Secondary:**
- Markdown and YAML/JSON configuration - `EMRsystem/README.md`, `EMRsystem/DEPLOYMENT.md`, `render.yaml`, `vercel.json`, `EMRsystem/vercel.json`, `VercelFrontend/vercel.json`.
- Python is listed only as optional/inferred OCR tooling in `EMRsystem/requirements.txt`; no Python application code or Python package manifest is present.

## Runtime

**Environment:**
- Node.js. `render.yaml` pins `NODE_VERSION` to `20`; `EMRsystem/requirements.txt` says Node.js 18+ and npm 9+; `EMRsystem/package-lock.json` includes Sharp packages requiring Node `>=18`/`^18.17.0 || ^20.3.0 || >=21.0.0`.
- Browser runtime for static frontend pages in `EMRsystem/*.html` and `VercelFrontend/*.html`.

**Package Manager:**
- npm. Root launcher scripts in `package.json` delegate to `EMRsystem`; backend scripts live in `EMRsystem/package.json`; frontend static build script lives in `VercelFrontend/package.json`.
- Lockfile: present for backend at `EMRsystem/package-lock.json` (`lockfileVersion: 3`). No root lockfile and no `VercelFrontend/package-lock.json` detected.

## Frameworks

**Core:**
- Express `^4.18.4` - HTTP API and static file server in `EMRsystem/server.js`.
- PostgreSQL via `pg` `^8.13.1` - database connection pool and query adapter in `EMRsystem/db.js`.
- Static HTML/CSS/JS frontend - no SPA framework detected; pages call REST endpoints through `fetch`, `EMRsystem/api-config.js`, and `VercelFrontend/api-config.js`.

**Testing:**
- No formal test runner dependency detected in `EMRsystem/package.json` or root `package.json`.
- Ad hoc Node test/setup scripts exist: `EMRsystem/test-ocr-improved.js`, `EMRsystem/test-cp-abe.js`, and `EMRsystem/setup-test-accounts.js`.

**Build/Dev:**
- `node scripts/build-static.js` copies static assets from `EMRsystem` to `EMRsystem/dist` and `VercelFrontend` (`EMRsystem/scripts/build-static.js`).
- `node build.js` copies `VercelFrontend` static files into `VercelFrontend/dist` (`VercelFrontend/build.js`).
- Vercel static hosting config exists at `vercel.json`, `EMRsystem/vercel.json`, and `VercelFrontend/vercel.json`.
- Render Node web service config exists at `render.yaml`.

## Key Dependencies

**Critical:**
- `express` `^4.18.4` - all `/api/*` routes and static serving in `EMRsystem/server.js`.
- `pg` `^8.13.1` - required for Postgres persistence in `EMRsystem/db.js`.
- `dotenv` `^16.0.0` - loads local environment configuration at `EMRsystem/server.js:1`.
- `cors` `^2.8.5` - global CORS middleware in `EMRsystem/server.js`.
- `bcryptjs` `^2.4.3` - password hashing and comparison in `EMRsystem/db.js`.

**Infrastructure:**
- `qrcode` `^1.5.4` - public registration and invite QR codes in `EMRsystem/server.js`.
- `sharp` `^0.34.5` - image validation, crop, preprocessing, and OCR preparation in `EMRsystem/server.js`.
- `tesseract.js` / `tesseract.js-core` `^7.0.0` - OCR of Philippine National ID uploads in `EMRsystem/server.js`.
- `form-data` `^4.0.0` - multipart request body for optional Roboflow detection in `EMRsystem/server.js`.

## Backend/Frontend Split

- Backend source of truth is `EMRsystem/server.js` + `EMRsystem/db.js`; `EMRsystem/package.json` defines `start` and `dev` as `node server.js`.
- Static frontend source files are in `EMRsystem/*.html`, `EMRsystem/app.js`, `EMRsystem/api-config.js`, and `EMRsystem/styles.css`.
- `EMRsystem/scripts/build-static.js` copies those frontend files to `EMRsystem/dist` and also refreshes `VercelFrontend`; it copies `EMRsystem/app.js` as `auth-client.js`.
- `VercelFrontend` is a deployment copy with its own `build.js`, `package.json`, `api-config.js`, and duplicated static pages.

## Persistence and Storage

- Primary persistence is Postgres through `DATABASE_URL` in `EMRsystem/db.js`; code error messages label this as a Neon Postgres connection string.
- Tables are created/altered at app startup in `db.init()` (`EMRsystem/db.js`) for users, invites, patients, OTPs, assessments, consultations, doctor availability, profiles, notifications, password reset requests, reschedule requests, message board, patient record files, and audit logs.
- Medical record file uploads are stored as base64 text in the `patient_record_files.file_data` column (`EMRsystem/db.js`, `EMRsystem/server.js`). There is no object storage SDK.
- README/requirements still mention SQLite (`EMRsystem/README.md`, `EMRsystem/requirements.txt`), but current runtime code uses `pg` and `DATABASE_URL` (`EMRsystem/db.js`). Treat SQLite references as stale documentation.

## Security/Auth Libraries and Crypto Primitives

- Passwords use `bcrypt.hash(password, 10)` and `bcrypt.compare` in `EMRsystem/db.js`.
- Login returns a user object only; `EMRsystem/server.js` comments that real session/token issuance is not implemented, and frontend stores the user object in `localStorage` (`EMRsystem/app.js`, `VercelFrontend/auth-client.js`).
- OTP hashes use SHA-256 via Node `crypto.createHash('sha256')` in `EMRsystem/db.js`.
- Assessment encryption is implemented with Node `crypto` using AES-256-GCM plus policy AAD in `EMRsystem/db.js`; keys derive from `crypto.scryptSync` with a static salt and patient-derived phrase.
- Invite tokens use `crypto.randomUUID()` in `EMRsystem/server.js`.
- File/hash validation uses SHA-256 in `EMRsystem/server.js` for known National ID fixture matching.

## OCR/AI/Medical-Record Processing

- OCR endpoint: `POST /api/scan-id` in `EMRsystem/server.js` accepts `imageBase64`, validates/crops/preprocesses images, runs Tesseract multiple times, parses Philippine National ID fields, and returns parsed identity data plus debug OCR text.
- Image preprocessing uses `sharp` grayscale/normalize/modulate/sharpen/median/threshold/resize/png in `EMRsystem/server.js`.
- Optional Roboflow integration calls `https://detect.roboflow.com/philippine-ids-2loru/1` when `ROBOFLOW_API_KEY` is set (`EMRsystem/server.js`).
- Patient medical record upload endpoint stores JPG/PNG/WEBP/PDF files up to 5 MB in Postgres as base64 (`EMRsystem/server.js`).

## Configuration

**Environment:**
- Required for production/runtime DB access: `DATABASE_URL` (`EMRsystem/db.js`, `render.yaml`).
- Runtime/server settings: `PORT`, `FRONTEND_URL`, `APP_TIME_ZONE` (`EMRsystem/server.js`).
- Optional ID detection: `ROBOFLOW_API_KEY` (`EMRsystem/server.js`, `render.yaml`).
- `.env.example` exists at `EMRsystem/.env.example`; contents were not read. `.env` and `*.env` are ignored by `EMRsystem/.gitignore`.

**Build:**
- Root launcher: `package.json` (`build`, `start`, `dev` delegate to `EMRsystem`).
- Backend/package build: `EMRsystem/package.json` and `EMRsystem/scripts/build-static.js`.
- Static frontend build: `VercelFrontend/package.json` and `VercelFrontend/build.js`.
- Deployment configs: `render.yaml`, `vercel.json`, `EMRsystem/vercel.json`, `VercelFrontend/vercel.json`.

## Platform Requirements

**Development:**
- Install backend dependencies with `npm install` in `EMRsystem` or run root scripts that delegate to `EMRsystem` (`package.json`, `EMRsystem/package.json`).
- Set `DATABASE_URL` before starting; `EMRsystem/db.js` throws if `DATABASE_URL` is absent.
- Start backend/static server with `npm start` or `npm run dev` from root (delegated) or `EMRsystem` (`package.json`, `EMRsystem/package.json`).
- Open local frontend through the Express server at `http://localhost:3000`; API config also routes localhost static pages to `http://localhost:3000` (`EMRsystem/api-config.js`, `VercelFrontend/api-config.js`).

**Production:**
- API target: Render Node web service rooted at `EMRsystem`, build command `npm install`, start command `npm start`, health check `/api/health` (`render.yaml`).
- Database target: Neon Postgres inferred from `EMRsystem/DEPLOYMENT.md` and `EMRsystem/db.js` error text.
- Frontend target: Vercel static hosting from root `EMRsystem/dist` (`vercel.json`) or `VercelFrontend` static output (`VercelFrontend/vercel.json`).
- Current frontend API base URL is hardcoded to a Render service URL in both `EMRsystem/api-config.js` and `VercelFrontend/api-config.js`.

---

*Stack analysis: 2026-05-31*
