# High Priority Review Fixes Design

Date: 2026-06-14
Status: Approved design, pending implementation plan

## Purpose

Implement the high-priority thesis review comments that affect security, privacy, registration integrity, scheduling completeness, account lifecycle, notifications, and QR-code expiration. This pass uses a local-first security approach: it closes enforceable workflow and validation gaps without requiring production SMTP or Google OAuth provider credentials.

## Scope

In scope:

- Stage patient onboarding so account creation is verified and approved before patient identity and medical profile data are saved.
- Fix patient profile creation SQL and tighten patient data validation.
- Ensure registration, verification, approval, profile completion, scheduling, consultation completion, and reporting work as one end-to-end flow.
- Harden online and walk-in scheduling so doctor availability, patient readiness, and consultation source are enforced consistently.
- Add local-first email verification and notification boundaries that are testable without external provider secrets.
- Add 24-hour registration reminder and forfeiture enforcement for unverified pending patient accounts.
- Replace permanent public and patient QR codes with expiring token-backed QR flows that can be regenerated.
- Extend static regression tests and refresh generated frontend output.

Out of scope:

- Production SMTP delivery with real provider credentials.
- Google OAuth or other social-login provider callbacks.
- A full session/token authentication redesign.
- Anonymous walk-in patient registration.
- New frontend framework or database ORM.

## Current Findings

- `/api/register` currently creates a pending patient user and immediately writes a `patients` profile row before email verification or admin approval.
- `db.createPatientProfile()` has an invalid insert column expression, `mobile || null`, in the patients insert column list.
- Login is blocked for pending patients, but admin activation currently force-verifies unverified patient email.
- Public registration QR currently points directly to permanent `register.html`.
- Patient QR currently encodes `EMR-Patient:${userId}` with no expiration or revocation path.
- Email verification and 24-hour notices exist only as local notification records and returned local test links.
- Staff walk-in creation exists, but high-priority closure requires stronger end-to-end readiness, doctor visibility, and schedule enforcement.

## Architecture

Keep the existing Express, PostgreSQL, static HTML, and Node built-in test architecture. Add small, focused database helpers and server endpoints instead of introducing new services.

Main units:

- `server.js`: owns registration gates, lifecycle enforcement, QR generation/validation endpoints, scheduling authorization, and local notification/email-adapter orchestration.
- `db.js`: owns persistence helpers for user verification state, patient profile creation, expiring QR tokens, lifecycle queries, and consultation queues.
- `register.html`: becomes account-first patient onboarding, with clear messaging that profile details are completed after verification and approval.
- `dashboard.html`: handles patient profile completion before EMR upload, QR display, or consultation request actions.
- `staff.html` and `doctor-dashboard.html`: continue existing scheduling/consultation workflows, with tightened walk-in and source visibility markers.
- `test-revisions.js`: adds static regression coverage for high-priority workflow/security requirements.

## Registration And Identity Gating

Patient registration is split into account creation and profile completion.

Stage 1 account creation:

- `/api/register` accepts role, email, password, invite token, and privacy-consent fields for patient self-registration.
- For patient self-registration, the endpoint creates only a `users` row with `role = 'patient'`, `status = 'pending'`, `email_verified = 0`, a verification token, and a 24-hour expiration timestamp.
- It does not call `db.createPatientProfile()` and does not persist National ID, address, DOB, mobile, security question, or other medical identity fields.
- It validates email, password policy, invite token if supplied, privacy consent, and duplicate email before creating the pending user.
- It creates local notifications for verification and approval status. The response can include the verification URL for local testing.

Stage 2 profile completion:

- Add `POST /api/patient/profile-completion` for active patients to save their profile after verification and approval.
- The endpoint requires an active patient account with `email_verified = 1` and no existing patient profile.
- It validates and saves patient identity fields only after the account has passed verification and admin activation.
- The patient dashboard detects an active patient without a profile and shows profile completion before allowing EMR, QR, file upload, or consultation requests.

Admin-created patient accounts:

- Admin-created patient accounts may still create a profile immediately because an admin is the trusted actor entering the data.
- Admin-created patient accounts are created with `email_verified = 1` because the clinic/admin is directly provisioning the account.
- Admin-created patients use the same fixed profile SQL and validation rules.
- Admin activation must not silently force email verification for self-registered patients. Activation of a self-registered patient with `email_verified != 1` returns `400` with a clear verification-required message.

## Patient Data Validation

Server-side validation becomes the source of truth.

Rules:

- First and last name are required and allow Unicode letters, spaces, periods, apostrophes, and hyphens.
- Middle name is optional but uses the same character rule when supplied.
- Date of birth is required, must be a valid calendar date, and cannot be in the future.
- Age is derived server-side from DOB and client-supplied age is ignored.
- Sex must be one of the supported canonical values.
- Civil status must be one of the supported canonical values.
- Address is required and length-limited.
- Address 2 is optional and length-limited.
- Mobile is optional and numeric-only when supplied.
- PhilHealth and National ID numbers are optional and numeric-only when supplied.
- Security question and answer are required for patient profile completion and length-limited.

Database fix:

- Replace `mobile || null` in the `INSERT INTO patients` column list with `mobile`.
- Pass `mobile || null` as a parameter value, not as a column expression.

## Scheduling, Walk-Ins, And Completion Flow

Online consultation requests:

- `/api/consultation-request` rejects patients who are not active, not email-verified, or missing a completed patient profile.
- The endpoint continues to enforce no duplicate active consultation, no past dates, doctor availability, daily capacity, and time-slot collisions.
- Consultation source remains `online`.

Staff walk-ins:

- `/api/staff/consultations` requires a staff/admin actor and an active patient with a completed patient profile.
- Scheduled walk-ins require valid doctor availability for the selected date/time.
- Unscheduled walk-ins are allowed as pending walk-in records when no date/time is supplied.
- Created walk-ins set `consultation_source = 'walk-in'`.
- Notifications go to the patient and, when scheduled or assigned, the doctor.

Doctor workflow:

- Doctor consultation lists include both `online` and `walk-in` consultations assigned to that doctor.
- Doctor cards/details display the consultation source.
- Doctor completion continues through `PUT /api/doctor/consultation/:id`, including diagnostic result, prescription, and `completed` status.

End-to-end completion:

- A valid patient flow is: register account, verify email, receive admin approval, complete profile, request consultation, doctor/staff schedules or handles walk-in, doctor completes consultation, patient/report history shows the completed record.
- Each step fails with clear messages when a prerequisite is missing.

## Email, Notifications, And External Identity

Local-first email behavior:

- Keep verification URL generation locally testable.
- Add `sendAccountEmail({ to, subject, text, type })` in `server.js` as the local-first email adapter boundary.
- Without SMTP configuration, the adapter records a local notification and logs a safe development message without secrets.
- The code must not add hardcoded SMTP credentials or OAuth client secrets.

Google/social registration:

- Keep Google/social registration as provider setup documentation and UI messaging for this pass.
- Do not add fake OAuth behavior.
- Add tests that verify the UI and docs honestly state provider setup is required.

User notifications:

- Notifications remain stored in the existing `notifications` table.
- Verification, reminder, forfeiture, approval, walk-in creation, scheduling, and completion events create local notification rows.

## 24-Hour Reminder And Forfeiture Lifecycle

Pending self-registered patient accounts have a 24-hour verification deadline.

Lifecycle enforcement:

- Add `enforcePatientRegistrationLifecycle(now = new Date())`.
- The helper finds pending unverified patient accounts with verification deadlines.
- Before expiry, it creates one reminder notification for accounts approaching the deadline and records `registration_notice_sent_at`.
- After expiry, it marks unverified pending accounts inactive/forfeited and records `registration_forfeited_at`.
- Expired verification links return a clear error and mark the registration forfeited if it has not already been forfeited.

Safe invocation points:

- Run lifecycle enforcement from `/api/login`, `/api/notifications`, `/api/admin/users`, and `/api/verify-email`.
- This avoids adding a background scheduler while still keeping lifecycle state current during normal app use.

## QR Security

Public registration QR:

- Replace permanent `/api/public-registration-qr` behavior with a token-backed invite URL.
- Generate a short-lived invite token, store it in `invites`, and return QR data plus `expiresAt`.
- `index.html` displays the QR expiry and provides a regenerate button.
- `/api/invite` continues to reject invalid, used, or expired tokens.

Staff/admin invite QR:

- Keep existing staff/admin invite generation, but make expiry visible in the response and UI.
- Regenerating creates a new token instead of reusing an expired one.

Patient QR:

- Replace static patient QR payloads with expiring token-backed patient QR records.
- Add persistent storage for patient QR tokens with `token`, `patient_id`, `expires_at`, `revoked_at`, and `created_at`.
- `/api/my-qr` returns a QR URL containing the token and expiry metadata.
- Add a validation endpoint for QR tokens that rejects expired tokens and returns only safe routing metadata unless an authorized doctor/staff context is supplied.
- `dashboard.html` displays QR expiry and lets the patient regenerate the QR.

## Error Handling

- Registration returns specific validation messages for invalid email, weak password, duplicate email, missing privacy consent, expired invite, and invalid role.
- Profile completion returns specific validation messages for each invalid patient field.
- Login returns clear messages for pending approval, unverified email, inactive/forfeited account, and missing profile.
- Scheduling returns clear messages for incomplete profile, unavailable doctor slot, past date, duplicate active consultation, and invalid walk-in patient.
- QR validation returns safe expired/invalid messages without exposing patient data.
- Email adapter failures must not crash registration; they create local notification evidence and log a safe warning.

## Testing

Extend `EMRsystem/test-revisions.js` with static regression checks for:

- `/api/register` no longer calls `db.createPatientProfile()` in the patient self-registration path.
- Patient profile completion endpoint exists and requires active, verified patient state.
- `db.createPatientProfile()` uses `mobile` in the insert column list and passes optional mobile as a value.
- Patient validators cover names, DOB, sex, civil status, address, optional mobile, PhilHealth, and National ID fields.
- Admin activation does not silently bypass self-registered patient email verification.
- Consultation request and staff walk-in routes require active patients with completed profiles.
- Doctor consultation UI/API exposes `consultation_source` for online versus walk-in consultations.
- Local email adapter boundary exists and avoids hardcoded SMTP/OAuth secrets.
- Lifecycle helper creates reminder notifications and forfeits expired unverified registrations.
- Public registration QR and patient QR use expiring token-backed URLs and expose expiry/regeneration UI.
- Google/social registration remains honestly marked as provider setup rather than fake implementation.

Verification commands:

```powershell
node --check EMRsystem/server.js
node --check EMRsystem/db.js
node --check EMRsystem/test-revisions.js
npm --prefix EMRsystem test
npm test
npm --prefix EMRsystem run build
```

## Risks And Tradeoffs

- Moving patient details after approval changes the self-registration user experience, but directly addresses the privacy concern that medical identity data should not be stored before account verification.
- Existing pending users that already have profiles remain as legacy records. The implementation should not delete existing data automatically.
- Without SMTP credentials, real email delivery cannot be proven. The local adapter and notifications make the workflow testable and honest.
- QR token storage adds schema surface area, but it is the smallest durable way to support expiration and regeneration.
- Request-triggered lifecycle enforcement is simpler than a background job, but expiry is processed when the app receives normal traffic rather than exactly at the deadline.

## Implementation Boundaries

- Do not add new secrets to the repository.
- Do not fabricate real email or Google OAuth behavior.
- Do not replace the static HTML architecture.
- Do not commit changes unless explicitly requested.
- Keep generated `VercelFrontend` output in sync through the existing build script after canonical frontend edits.
