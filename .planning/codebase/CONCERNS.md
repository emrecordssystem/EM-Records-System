# Codebase Concerns

**Analysis Date:** Sun May 31 2026

## Tech Debt

**[HIGH] Authentication is identifier-based, not session-based:**
- Issue: The backend trusts `userId`, `doctorId`, and role checks derived from request query/body parameters instead of an authenticated session, signed token, or server-side session. The login handler explicitly notes that no real session/token is issued.
- Files: `EMRsystem/server.js:834-885`, `EMRsystem/server.js:1165-1800`, `EMRsystem/server.js:3738-4131`, `EMRsystem/app.js:94-105`, `EMRsystem/doctor-dashboard.html:1127-1133`
- Impact: Any caller who knows or guesses a privileged user id can invoke admin, doctor, staff, or patient APIs. This is the highest-priority production blocker for medical records.
- Fix approach: Add server-side authentication middleware, issue signed HttpOnly secure cookies or short-lived bearer tokens, derive `req.user` from the token, and remove all authorization decisions based on caller-supplied user ids.

**[HIGH] All roles can self-register, including admin/doctor/staff:**
- Issue: Public `/api/register` accepts `admin`, `doctor`, and `staff` roles. Doctor registration only requires a license value and staff registration only requires a position value.
- Files: `EMRsystem/server.js:182-223`, `EMRsystem/server.js:274-289`, `EMRsystem/server.js:334-346`, `EMRsystem/doctor-register.html:47-73`, `EMRsystem/staff-register.html:58-65`
- Impact: Privileged accounts can be created without verified administrator approval, professional-license validation, or staff onboarding controls.
- Fix approach: Restrict public registration to patients only; move doctor/staff/admin creation behind authenticated admin workflows; validate professional identifiers before activation.

**[HIGH] Medical-record encryption is not reliable protection:**
- Issue: Assessment data is stored both as plaintext `assessment_json` and encrypted `assessment_encrypted`. The encryption key is deterministically derived from `patientId` and the constant salt `'salt'`; `MASTER_KEY` is random per process and unused.
- Files: `EMRsystem/db.js:12-19`, `EMRsystem/db.js:206-218`, `EMRsystem/db.js:745-756`, `EMRsystem/db.js:799-816`, `EMRsystem/server.js:3780-3782`, `EMRsystem/server.js:1658-1666`
- Impact: Database readers can access plaintext health assessments, and anyone with the patient id can derive the encryption key. The CP-ABE label is misleading because access control is implemented in application code, not cryptographic policy enforcement.
- Fix approach: Remove plaintext assessment storage, introduce per-record random data keys protected by a managed key or KMS, rotate existing records, and enforce access at both query and API layers.

**[HIGH] Large monolithic server creates maintenance and review risk:**
- Issue: `server.js` contains routing, auth checks, OCR, ID validation, registration, admin, staff, doctor, patient workflows, and parsing heuristics in one 4,157-line file.
- Files: `EMRsystem/server.js:1-4157`
- Impact: Security-sensitive behavior is hard to audit, changes are likely to regress unrelated workflows, and endpoint ownership is unclear.
- Fix approach: Split into `routes/`, `middleware/auth.js`, `services/ocr.js`, `services/medical-records.js`, and `repositories/` modules; add route-level tests before moving logic.

**[MEDIUM] Duplicate committed frontends drift from source:**
- Issue: Static frontend files exist in both `EMRsystem/` and `VercelFrontend/`; `scripts/build-static.js` copies source files into `VercelFrontend/` without cleaning it.
- Files: `EMRsystem/scripts/build-static.js:4-8`, `EMRsystem/api-config.js:1-22`, `VercelFrontend/api-config.js:1-22`, `EMRsystem/doctor-dashboard.html`, `VercelFrontend/doctor-dashboard.html`
- Impact: Bug fixes can be applied to one copy but deployed from another. Reviewers must inspect duplicated HTML/JS to know what production serves.
- Fix approach: Treat `VercelFrontend/` as generated build output or remove it from source control; deploy from one canonical source directory.

**[MEDIUM] Database schema migration is embedded in startup:**
- Issue: `db.init()` creates and mutates tables with many `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` calls at server startup.
- Files: `EMRsystem/db.js:130-374`, `EMRsystem/server.js:4141-4147`
- Impact: Production startup performs schema changes without migration review, rollback, or version tracking. Failures can prevent the API from booting.
- Fix approach: Add explicit migration files and a migration command; run migrations during deployment with backups and failure visibility.

## Known Bugs

**[HIGH] Admin EMR records expose plaintext assessments despite comments claiming encryption:**
- Symptoms: `/api/admin/emr-records` maps `assessment_json` into `assessment_data` for admins. The test expects admins to be blocked, but the implementation returns records successfully.
- Files: `EMRsystem/server.js:1642-1666`, `EMRsystem/db.js:1354-1369`, `EMRsystem/test-cp-abe.js:161-172`
- Trigger: Call `GET /api/admin/emr-records?userId=<admin-id>`.
- Workaround: None in code; disable this endpoint or remove assessment fields until authorization and encryption are corrected.

**[HIGH] Doctors can access any patient EMR and uploaded file by id:**
- Symptoms: Doctor APIs only verify that the requester has role `doctor`; they do not verify a treatment relationship, assigned consultation, consent, or minimum-necessary access.
- Files: `EMRsystem/server.js:674-679`, `EMRsystem/server.js:681-699`, `EMRsystem/server.js:4015-4045`, `EMRsystem/db.js:1133-1151`
- Trigger: Call `/api/doctor/patient/:patientId?doctorId=<any-doctor-id>` or `/api/patient-record-files?userId=<doctor-id>&patientId=<any-patient-id>`.
- Workaround: None in code; restrict doctor access to patients with assigned consultations or explicit grants.

**[HIGH] Notification read endpoint can modify arbitrary notifications:**
- Symptoms: `/api/notifications/:id/read` marks a notification as read without requiring `userId` or checking notification ownership.
- Files: `EMRsystem/server.js:600-604`, `EMRsystem/db.js:729-730`
- Trigger: POST any notification id to `/api/notifications/:id/read`.
- Workaround: Require authenticated user context and update with `WHERE id = ? AND user_id = ?`.

**[MEDIUM] Profile update accepts arbitrary column names from client input:**
- Symptoms: `updatePatientProfile()` builds SQL column assignments from `Object.keys(updates)`. Values are parameterized, but column names are not allowlisted.
- Files: `EMRsystem/server.js:819-827`, `EMRsystem/db.js:738-742`
- Trigger: Send unexpected keys in `updates` to `PUT /api/profile`.
- Workaround: Allowlist editable patient columns and reject unknown keys before building SQL.

## Security Considerations

**[CRITICAL] No CSRF protection, no rate limiting, and broad CORS:**
- Risk: `app.use(cors())` allows any origin, JSON bodies are accepted without CSRF tokens, and login/registration/password-reset endpoints have no rate limiting.
- Files: `EMRsystem/server.js:166-168`, `EMRsystem/server.js:834-920`, `EMRsystem/server.js:182-369`
- Current mitigation: Passwords are hashed with bcrypt in `EMRsystem/db.js:376-408`.
- Recommendations: Lock CORS to configured frontend origins, add rate limits and account lockout/backoff for auth endpoints, and use SameSite HttpOnly cookies with CSRF protections for state-changing routes.

**[HIGH] Frontend stores authorization identity in mutable localStorage:**
- Risk: UI access and API calls use `localStorage.authUser` as the source of role and id. Any script running on the page can alter it.
- Files: `EMRsystem/app.js:94-105`, `EMRsystem/doctor-dashboard.html:1127-1133`, `EMRsystem/staff.html:506-527`, `EMRsystem/login.html:205-214`
- Current mitigation: Server role checks look up the supplied id, but they still trust the caller-supplied id.
- Recommendations: Store only non-sensitive display state client-side; derive identity server-side from a signed session.

**[HIGH] XSS risk through unsafe `innerHTML` rendering of patient data and API error text:**
- Risk: Patient names, concerns, file names, notes, status strings, and error messages are interpolated directly into HTML strings.
- Files: `EMRsystem/doctor-dashboard.html:1218-1238`, `EMRsystem/doctor-dashboard.html:1318-1339`, `EMRsystem/doctor-dashboard.html:1385-1386`, `EMRsystem/doctor-dashboard.html:1459-1503`, `EMRsystem/register.html:441-460`, `EMRsystem/staff.html:661-664`
- Current mitigation: Not detected.
- Recommendations: Replace string-based `innerHTML` rendering with DOM APIs or HTML-escape all dynamic values; add a restrictive Content Security Policy.

**[HIGH] Sensitive personal identifiers are stored in plaintext:**
- Risk: Patient profile fields include National ID number, PhilHealth number, address, birth date, mobile number, security question, and security answer in plaintext.
- Files: `EMRsystem/db.js:158-183`, `EMRsystem/db.js:485-579`
- Current mitigation: Database transport uses SSL when `DATABASE_URL` is non-local in `EMRsystem/db.js:5-10`.
- Recommendations: Encrypt high-risk identifiers at rest, hash security answers with a slow hash if retained, minimize collected IDs, and define retention/deletion workflows.

**[MEDIUM] OCR endpoint returns and logs sensitive raw OCR text:**
- Risk: Uploaded ID data and extracted text are returned in `debug` payloads and written to server logs.
- Files: `EMRsystem/server.js:2383-2443`, `EMRsystem/server.js:2406-2413`, `EMRsystem/server.js:1887-1918`
- Current mitigation: Some debug text is truncated in error paths.
- Recommendations: Remove OCR debug payloads in production, redact logs, and gate verbose diagnostics behind an explicit non-production flag.

**[MEDIUM] Hard-coded real-looking ID fixtures and hashes are committed in source:**
- Risk: The OCR code embeds names, birth dates, addresses, ID numbers, filenames, and hashes for known National ID images.
- Files: `EMRsystem/server.js:2153-2205`
- Current mitigation: Not detected.
- Recommendations: Move fixtures to private test data, replace with synthetic values, and review repository history for personal-data exposure.

## Performance Bottlenecks

**[HIGH] Base64 medical files are stored in Postgres and returned inline:**
- Problem: `patient_record_files.file_data` stores base64 content; detail API returns a full `dataUrl` payload.
- Files: `EMRsystem/db.js:346-358`, `EMRsystem/db.js:1153-1185`, `EMRsystem/server.js:706-757`, `EMRsystem/server.js:781-792`
- Cause: Files are embedded in database rows and JSON responses instead of object storage/streaming.
- Improvement path: Store files in private object storage with metadata in Postgres; return short-lived signed URLs or stream downloads with authorization checks.

**[MEDIUM] CPU-heavy OCR runs on the API process:**
- Problem: `/api/scan-id` performs Sharp processing and multiple Tesseract passes synchronously inside the request lifecycle.
- Files: `EMRsystem/server.js:1883-1947`, `EMRsystem/server.js:2281-2452`
- Cause: No queue, worker isolation, timeout, or concurrency limit around OCR processing.
- Improvement path: Move OCR to a worker queue with request size limits, timeouts, concurrency caps, and progress/result polling.

**[MEDIUM] Repeated count queries inside loops can grow slowly:**
- Problem: Doctor availability response counts booked slots in nested loops per doctor/date/time slot.
- Files: `EMRsystem/server.js:551-577`, `EMRsystem/db.js:594-635`
- Cause: Availability enrichment calls count queries for every slot.
- Improvement path: Fetch all counts for the date range in one grouped query and compute slot availability in memory.

## Fragile Areas

**OCR/ID parsing heuristics:**
- Files: `EMRsystem/server.js:1821-2452`, `EMRsystem/server.js:2540-3692`, `EMRsystem/test-ocr-improved.js:1-391`
- Why fragile: The parser uses many hand-coded corrections, hard-coded sample matches, verbose debug logs, and duplicated parser logic in the standalone test.
- Safe modification: Extract OCR parsing into a module with fixture-based unit tests and synthetic IDs; remove production dependence on known real ID fixtures.
- Test coverage: Script-style OCR test exists but is not integrated into `npm test`; no automated regression gate is configured.

**Authorization checks duplicated per endpoint:**
- Files: `EMRsystem/server.js:1003-1009`, `EMRsystem/server.js:1165-1800`, `EMRsystem/server.js:3738-4131`
- Why fragile: Each route implements role checks manually, usually using ids from query/body parameters.
- Safe modification: Centralize authentication and authorization middleware, then migrate one role group at a time with tests.
- Test coverage: Not detected for route authorization.

**Data deletion cascades are manual and destructive:**
- Files: `EMRsystem/db.js:1094-1110`, `EMRsystem/server.js:1428-1471`, `EMRsystem/server.js:1551-1560`
- Why fragile: Deleting a user removes audit logs, consultations, messages, record files, assessments, invites, and profiles without archival or soft-delete.
- Safe modification: Add soft-delete/status transitions for medical records and preserve immutable audit trails; only hard-delete data under a defined privacy-retention workflow.
- Test coverage: Not detected for deletion cascade outcomes.

## Scaling Limits

**Render free plan plus synchronous OCR limits reliability:**
- Current capacity: Deployment config uses Render `plan: free` for the API.
- Limit: Free instances can sleep/cold-start, and CPU-heavy OCR can block concurrent medical workflows.
- Scaling path: Use a paid always-on API service, isolate OCR workers, add health checks that verify database connectivity, and add observability.
- Files: `render.yaml:1-18`, `EMRsystem/server.js:2281-2452`

**No explicit upload/request throttles beyond body size:**
- Current capacity: JSON and URL-encoded bodies allow 50 MB while record-file validation allows 5 MB after base64 decoding.
- Limit: Attackers can send many large payloads to exhaust CPU/memory before validation completes.
- Scaling path: Lower global JSON limits, use streaming multipart upload limits, and add per-IP/user rate limits.
- Files: `EMRsystem/server.js:166-168`, `EMRsystem/server.js:724-727`

## Dependencies at Risk

**Frontend uses CDN dependency without integrity pinning:**
- Risk: Doctor dashboard loads QR code code from jsDelivr at runtime without Subresource Integrity.
- Impact: A compromised CDN response can execute script in the medical-record origin.
- Migration plan: Bundle dependencies at build time or add SRI and a strict CSP.
- Files: `EMRsystem/doctor-dashboard.html:1125`

**Documentation and implementation disagree on database technology:**
- Risk: README documents SQLite and local `data/emr.db`, while implementation requires Postgres `DATABASE_URL`.
- Impact: Onboarding and deployment setup can fail or point operators at obsolete storage assumptions.
- Migration plan: Update docs and deployment runbooks to Postgres/Neon and remove stale SQLite references.
- Files: `EMRsystem/README.md:1-10`, `EMRsystem/README.md:45-54`, `EMRsystem/db.js:1-10`, `EMRsystem/db.js:94-128`

## Missing Critical Features

**Medical-record audit and consent model is incomplete:**
- Problem: Audit logs capture some admin actions and logins, but many EMR reads, file downloads, profile reads/updates, doctor patient access, and notification reads are not logged consistently.
- Blocks: Patient privacy review, breach investigation, minimum-necessary access enforcement, and compliance reporting.
- Files: `EMRsystem/server.js:158-164`, `EMRsystem/server.js:632-665`, `EMRsystem/server.js:681-798`, `EMRsystem/server.js:4015-4045`

**No production-grade session lifecycle:**
- Problem: There is no logout invalidation, session expiry, refresh, device tracking, MFA/OTP enforcement, password policy, or forced password change after admin reset.
- Blocks: Safe deployment for privileged medical users.
- Files: `EMRsystem/server.js:834-885`, `EMRsystem/server.js:1602-1635`, `EMRsystem/db.js:193-203`, `EMRsystem/db.js:416-444`

**No automated test script or CI pipeline detected:**
- Problem: `EMRsystem/package.json` has `build`, `start`, and `dev` scripts only; tests are ad-hoc Node scripts.
- Blocks: Safe refactors of authorization, encryption, OCR parsing, and medical-record workflows.
- Files: `EMRsystem/package.json:6-10`, `EMRsystem/test-cp-abe.js:1-223`, `EMRsystem/test-ocr-improved.js:1-391`

## Test Coverage Gaps

**Authorization and IDOR tests:**
- What's not tested: Admin/doctor/staff/patient endpoints rejecting forged or mismatched ids, notification ownership, doctor-patient relationship checks, and file access checks.
- Files: `EMRsystem/server.js:584-604`, `EMRsystem/server.js:681-798`, `EMRsystem/server.js:1165-1800`, `EMRsystem/server.js:3738-4131`
- Risk: High-impact privacy and privilege bugs can ship unnoticed.
- Priority: High

**Medical-record encryption and storage tests:**
- What's not tested: Absence of plaintext assessments, key derivation safety, admin plaintext leakage, and migration behavior for legacy records.
- Files: `EMRsystem/db.js:12-19`, `EMRsystem/db.js:745-794`, `EMRsystem/server.js:1642-1666`, `EMRsystem/test-cp-abe.js:161-172`
- Risk: Sensitive health data remains readable while tests report false confidence.
- Priority: High

**Frontend XSS and API mismatch tests:**
- What's not tested: Escaping of dynamic patient data, error rendering, generated static frontend parity with `EMRsystem/`, and compatibility between hard-coded API URLs and deployment environments.
- Files: `EMRsystem/api-config.js:1-22`, `VercelFrontend/api-config.js:1-22`, `EMRsystem/scripts/build-static.js:4-8`, `EMRsystem/doctor-dashboard.html:1218-1503`
- Risk: A malicious record value or deployment drift can expose users or break production.
- Priority: Medium

## Recommended Follow-Up Investigations

1. Inventory every endpoint in `EMRsystem/server.js` and classify required role, owner relationship, and medical-record data returned.
2. Review production database for plaintext `patient_assessments.assessment_json`, `patients.security_answer`, `patients.national_id_number`, and `patient_record_files.file_data` exposure.
3. Verify whether any `.env` or untracked deployment secrets exist locally; do not commit them. `.env.example` exists as environment documentation, but secret values were not inspected.
4. Check repository history for real National ID fixture data referenced by `EMRsystem/server.js:2153-2205`.
5. Add security headers, CSP, rate limits, centralized error handling, structured logging, and health checks that include database connectivity.

---

*Concerns audit: Sun May 31 2026*
