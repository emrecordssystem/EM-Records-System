# Deployment Ready Identity And Security Design

Date: 2026-06-15
Status: Approved design, pending implementation plan

## Purpose

Close the remaining high-priority gaps so the EMR system is ready for a Render API plus Vercel static frontend deployment. This pass turns local-only identity behavior into production-capable SMTP verification and Google sign-in, removes unsafe example secrets, and completes the remaining validation, scheduling, mobile optionality, and QR security edges.

## Scope

In scope:

- Send real verification emails when SMTP environment variables are configured.
- Keep safe local notification fallback when SMTP is not configured.
- Add Google account login/creation using Google Identity Services ID tokens verified by the server.
- Allow Google self-registration only for patient accounts.
- Allow Google sign-in for doctor, staff, and admin only when the clinic has already created that user account.
- Fix deployed verification links so email links target the Express API host, not the static Vercel frontend.
- Validate patient profile updates with a strict allowlist and server-side patient data rules.
- Keep mobile optional in self-registration, profile completion, profile editing, and admin-created patient flows.
- Enforce published doctor availability when later scheduling or rescheduling walk-in/consultation records.
- Move public QR regeneration behind an authorized admin/staff request or remove public invalidation from the landing page.
- Replace real-looking secrets in sample environment files with placeholders.
- Extend regression tests and rebuild generated frontend output.

Out of scope:

- A full session-cookie or JWT auth redesign for every route.
- A new frontend framework.
- A new database ORM.
- Patient portal support for arbitrary social providers beyond Google.
- Background worker infrastructure beyond endpoint-triggered lifecycle enforcement.

## Current Remaining Gaps

- `FRONTEND_URL` is documented as the Vercel URL, but verification links currently use `${FRONTEND_URL}/api/verify-email`; Vercel does not proxy `/api/*` to Render.
- Patient profile completion validates data, but `PUT /api/profile` forwards raw `updates` keys into dynamic SQL.
- Walk-in creation checks published doctor availability, but later scheduling only checks capacity and collisions.
- Public QR regeneration revokes active public invite tokens without requester identity.
- Mobile is optional in the new profile-completion path but still required in the profile edit form and admin-created patient path.
- Google/social account creation is only messaging; no server endpoint verifies Google identity.
- `.env.example` contains a real-looking database URL and must not ship with credential-like values.

## Deployment URL Strategy

Use separate API and frontend URLs.

- Add `API_PUBLIC_URL`, used for backend-owned links such as `/api/verify-email`.
- Keep `FRONTEND_URL`, used for static frontend pages such as `register.html`.
- `getVerificationUrl(req, token)` should prefer `API_PUBLIC_URL`, then fall back to the incoming request host for local development.
- Public and patient QR URLs that open frontend pages keep using `FRONTEND_URL` when configured.
- Deployment docs must instruct Render to set both variables:
  - `API_PUBLIC_URL=https://RENDER_SERVICE_HOST.onrender.com`
  - `FRONTEND_URL=https://VERCEL_FRONTEND_HOST.vercel.app`

## SMTP Email Verification

Add production SMTP delivery through environment variables.

Environment variables:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

Behavior:

- When `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM` are configured, `sendAccountEmail()` sends real email.
- If SMTP auth values are supplied, use them; if not, allow unauthenticated SMTP for local/dev servers.
- The response from `sendAccountEmail()` reports `{ delivered: true, localNotification: false }` on successful delivery.
- When SMTP is incomplete or sending fails, the app records a local notification fallback and logs a safe message without credentials.
- Tests assert no hardcoded SMTP password or Google secret exists.

## Google Identity Services

Use Google Identity Services ID token login instead of a redirect callback flow. This matches the static frontend architecture and avoids storing a Google client secret in the browser.

Environment variables:

- `GOOGLE_CLIENT_ID` on the server.
- `window.PROFELECT_GOOGLE_CLIENT_ID` in `api-config.js` for the static frontend.

Frontend behavior:

- `login.html` shows a Google sign-in button only when a Google client ID is configured.
- `register.html` can offer Google patient registration/sign-in only when a Google client ID is configured.
- The frontend sends the Google credential ID token to `POST /api/auth/google`.

Server behavior:

- Add `POST /api/auth/google`.
- Verify the ID token audience matches `GOOGLE_CLIENT_ID` using `google-auth-library`.
- Reject tokens without a verified email.
- If an account exists:
  - Link `google_sub` to that account if not already linked.
  - Reject if `google_sub` belongs to a different account.
  - Allow login only if the account role/status rules allow login.
- If no account exists:
  - Create a patient `users` row only.
  - Mark `email_verified = 1` because Google verified the email.
  - Set `status = 'pending'` so admin approval is still required.
  - Do not create a patient profile until the patient is active and completes profile completion.
- Doctor, staff, and admin accounts cannot be self-created via Google. They can use Google only after clinic/admin provisioning created their account email.

Database additions:

- Add nullable `google_sub` column on `users`.
- Add unique index for non-null `google_sub`.
- Add helper to find users by Google subject.
- Add helper to link Google subject to an existing user.

## Patient Profile Update Validation

Profile completion and profile update must share validation rules.

Allowed update fields:

- `first_name`
- `middle_name`
- `last_name`
- `email`
- `mobile`
- `address`
- `address2`

Rules:

- Reject any unknown update key before calling the database.
- Validate names with the same Unicode name rule as profile completion.
- Validate email format when email is updated.
- Treat mobile as optional and numeric-only when supplied.
- Require address to remain non-empty and length-limited.
- Limit address 2 length.
- Convert empty optional fields to empty string or `null` consistently with existing DB conventions.
- Update the database helper so it only accepts allowed, server-normalized fields.

## Mobile Optional End-To-End

Mobile remains optional everywhere.

- `register.html`: already optional.
- `dashboard.html` profile completion: optional.
- `dashboard.html` profile editing: remove `required` from mobile and update labels to say optional.
- Admin-created patient path: remove mobile from required fields.
- Server validation: mobile remains numeric-only when supplied.
- Admin UI labels should show mobile as optional for patient creation.

## Scheduling And Walk-In Completion

Later scheduling must enforce the same published availability rules as scheduled walk-in creation.

Rules for `PUT /api/consultations/:id/schedule`:

- Validate date format and real calendar date.
- Reject past dates.
- Validate start and end time formats.
- Reject end time less than or equal to start time.
- Resolve the target doctor consistently.
- Doctor actors schedule for themselves.
- Staff actors schedule for the consultation's currently assigned doctor.
- Require published availability for the target doctor and requested start time.
- Continue enforcing daily capacity and slot collision checks.
- Keep existing notifications.

## QR Regeneration Security

Public landing page QR loading stays public and read-only.

- `GET /api/public-registration-qr` can reuse or create an active public invite token.
- It must not revoke existing tokens.
- Remove the public landing page regeneration button. Public visitors can reload the current active code, but they cannot invalidate an active public registration QR.

Authorized regeneration:

- Keep `POST /api/public-registration-qr/regenerate`, but require `requesterId` in the JSON body.
- The endpoint accepts active admin or staff users only.
- It revokes unused public invite tokens and returns a fresh expiring public registration QR.
- Existing admin/staff invite generation remains separate and keeps creator-specific invite records.

Patient QR remains token-backed:

- Patient QR creation requires profile-ready patient and matching requester identity.
- Patient QR regeneration revokes prior patient QR tokens.
- Patient QR validation requires unexpired, unrevoked token, current patient readiness, and authorized requester identity.

## Environment And Deployment Docs

Update sample and deployment docs.

- Replace `.env.example` database URL with `DATABASE_URL=postgresql://USERNAME:PASSWORD@HOST:5432/DATABASE?sslmode=require`.
- Add placeholders for `API_PUBLIC_URL`, `FRONTEND_URL`, SMTP vars, and Google client ID.
- Document where to configure Google OAuth authorized JavaScript origins:
  - Vercel frontend origin.
  - Local development origin.
- Document that no Google client secret is required for the selected Google Identity Services ID-token flow.
- Document that admin/staff/doctor accounts must be created by clinic admins before Google sign-in can use those roles.

## Testing

Extend `EMRsystem/test-revisions.js` with static regression assertions for:

- `API_PUBLIC_URL` is used for verification links.
- Deployment docs no longer instruct verification links to target Vercel `/api` without a proxy.
- SMTP env vars are supported and no SMTP/Google secrets are hardcoded.
- Google endpoint and frontend Google client configuration exist.
- Google self-registration creates only pending verified patient accounts and does not create profiles.
- Profile update route rejects unknown keys and uses validation before database update.
- DB profile update helper rejects unknown columns or is only called after server allowlisting.
- Mobile is optional in profile edit and admin patient creation.
- Later scheduling enforces date/time validation and published doctor availability.
- Public QR regeneration requires authorized requester identity or public landing page no longer invalidates active tokens.
- `.env.example` contains placeholders, not real-looking credentials.

Verification commands after implementation:

- `node --check EMRsystem/server.js`
- `node --check EMRsystem/db.js`
- `node --check EMRsystem/test-revisions.js`
- `npm --prefix EMRsystem run check:syntax`
- `npm --prefix EMRsystem test`
- `npm test`
- `npm --prefix EMRsystem run build`
- `git diff --check`

## Acceptance Criteria

- Email/password patient registration sends real SMTP verification email when configured and keeps safe local fallback when not configured.
- Deployed verification links point to the Render API host.
- Google sign-in works for existing clinic-created users and creates only pending patient accounts for new Google users.
- No patient profile data is saved before active verified approval.
- Profile update cannot write arbitrary database columns and validates patient fields server-side.
- Mobile is optional across self-service and admin patient flows.
- Walk-in creation and later scheduling both enforce published doctor availability.
- Public QR invalidation is restricted to an authorized admin/staff action.
- Patient QR tokens remain expiring, revocable, readiness-gated, and requester-gated.
- Example environment files contain placeholders only.
- Existing static regression tests pass and cover the deployment-ready changes.

## Risks And Follow-Up

- The app still uses lightweight `userId` and `requesterId` request fields across many legacy routes. This pass improves new identity boundaries but does not replace the whole app with session cookies or JWT middleware.
- Registration lifecycle reminders remain endpoint-triggered. A true background scheduler can be added later if required by hosting constraints.
- Google Identity Services requires correct Google Cloud console configuration before deployment testing.
