# EMR System Revision Implementation Design

Date: 2026-05-31
Status: Approved design draft, pending written-spec review

## Purpose

Implement the confirmed adviser revision list for the existing EMR application while preserving the current project structure. The changes cover registration validation, account verification messaging, patient notifications, doctor scheduling, admin reports, and patient history reporting.

The implementation will use the current static multi-page frontend, Express backend, and PostgreSQL data layer. `EMRsystem/` remains the canonical source. `VercelFrontend/` and `EMRsystem/dist/` are generated outputs refreshed by the existing build script.

## Confirmed Revision List

1. Show asterisk markers for required fields during account creation.
2. Add password restrictions during account creation.
3. Add email verification and email notification behavior.
4. Allow registration conceptually through Google email or social media account.
5. Make mobile number optional.
6. Improve report generation with search, date filter, tabular details, statuses, and 12-hour time format.
7. Remove doctor slot selection for patients where applicable.
8. Allow doctors to add additional slot options.
9. Notify patients after account creation.
10. Notify patients about schedule approval or disapproval.
11. Notify patients that registration must be confirmed within 24 hours or it will be forfeited.
12. Notify patients when the registration confirmation deadline is under 24 hours.
13. Reports must support viewing and printing all transactions and statuses.
14. Scheduled reports/status should show the current status.
15. Report transaction tables should include Transaction ID and Signature.
16. Check the registration and scheduling workflow from registration to completion.
17. Support adviser/panel demonstration readiness by making system workflows and documents easier to show.
18. Provide walk-in and online scheduled patient history.
19. Provide report generation for patient history.

## Scope Decision

The first implementation will use a practical local flow rather than real SMTP or real Google OAuth.

- Email verification will use generated verification tokens, verification status fields, deadline fields, and in-app/system-visible messaging.
- Email notification will be represented by persisted notifications and verification URLs that can be displayed or copied in the app.
- Google/social registration will be represented as a UI-supported planned provider path, with clear messaging that real OAuth provider setup is required before production use.
- Real SMTP and OAuth credentials are out of scope for this pass.

## Architecture

### Backend

Modify `EMRsystem/server.js` for route behavior and `EMRsystem/db.js` for schema/helpers.

Expected backend additions:

- Verification fields on `users`, such as `email_verification_token`, `email_verification_expires_at`, `email_verified_at`, and `registration_forfeited_at` where needed.
- Registration helper behavior to create pending patient accounts with a verification deadline.
- Verification endpoint, for example `GET /api/verify-email?token=...`, returning a clear success/failure JSON response or redirect-friendly output.
- Notification creation during registration, approval/disapproval, consultation scheduling, cancellation, and completion workflows.
- Report query support for search, date filters, current statuses, transaction identifiers, and patient history.
- Patient history query support separating walk-in and online scheduled history where existing data can support it.

### Frontend

Modify canonical pages in `EMRsystem/` first.

Expected frontend additions:

- `EMRsystem/register.html`: required-field asterisks, password rule UI, optional mobile number, account verification messaging, and Google/social provider setup messaging.
- `EMRsystem/dashboard.html`: clearer patient notifications and consultation history display.
- `EMRsystem/doctor-dashboard.html`: availability UI that allows doctors to add additional time slot options without requiring patient-side doctor slot selection.
- `EMRsystem/admin-dashboard.html`: report filters, searchable tabular report output, transaction/status report view, printable signature section, and patient history reports.
- `EMRsystem/styles.css`: shared styles for required markers, filter controls, printable report tables, and notification/status badges if page-local styles are insufficient.

After canonical edits, run `npm run build` from the repository root to refresh `VercelFrontend/` and `EMRsystem/dist/`.

## Data Flow

### Registration and Verification

1. Patient opens registration page.
2. Required fields show asterisks and password requirements are visible before submission.
3. Mobile number is accepted as blank.
4. Backend validates password strength and required patient fields.
5. Backend creates a pending patient account with email verification token and 24-hour deadline.
6. Backend creates an account-created notification and a confirmation-deadline notification.
7. Registration response explains that the account must be verified or confirmed within 24 hours and then approved.
8. Verification endpoint marks email as verified when token is valid and not expired.

### Scheduling

1. Patient requests consultation through the existing patient dashboard.
2. The patient does not have to pick a doctor slot directly.
3. Backend assigns or validates an available doctor/date/time based on existing availability rules.
4. Patient receives notification when schedule status changes to approved, disapproved, scheduled, cancelled, or completed.
5. Doctor can add additional availability time slots through the doctor dashboard.

### Reports and History

1. Admin opens Reports.
2. Admin can search and filter by date range.
3. Report output is tabular and shows current statuses.
4. Transaction rows include Transaction ID and a Signature field/line for printouts.
5. Admin can view/print all transactions/statuses.
6. Patient history report shows walk-in and online scheduled patient history when the data source indicates consultation type; if no explicit source exists, the implementation will add a simple source/type field with a safe default.

## Error Handling

- Backend responses should continue using `{ success: true, ... }` and `{ success: false, message }`.
- Password validation failures should return `400` with specific rule guidance.
- Expired or invalid verification tokens should return `400` with a clear message.
- Report filters should tolerate missing dates and empty search strings.
- If patient-history source/type is absent for existing records, old records should display as `Online scheduled` or `Unspecified` based on the least misleading available data.
- Notification failures should be logged but should not block core actions unless the core action depends on the notification record.

## Testing and Review Plan

Because the project has no automated test runner, verification will use syntax checks, build checks, and focused manual/static review.

Required checks after implementation:

- `node --check EMRsystem/server.js`
- `node --check EMRsystem/db.js`
- `node --check EMRsystem/scripts/build-static.js`
- `npm run build`

Manual review checklist:

- Registration page shows required asterisks and password restrictions.
- Mobile number is optional in the browser and backend.
- Registration response includes verification and 24-hour confirmation guidance.
- Email verification token flow works for valid, expired, and invalid tokens where possible without a live database.
- Patient notification records are created at registration and scheduling status changes.
- Patient consultation request no longer depends on selecting a doctor slot directly.
- Doctor availability supports adding additional slots.
- Admin reports can search, date-filter, display statuses, show transaction IDs/signature fields, and print.
- Patient history report includes walk-in and online scheduled history categories.
- Generated `VercelFrontend/` output reflects canonical `EMRsystem/` changes after build.

## Out of Scope

- Real SMTP delivery.
- Real Google OAuth/social login.
- Full session/JWT authentication rewrite.
- Complete security hardening of all existing IDOR/auth concerns.
- New automated test framework setup unless needed for a blocking implementation issue.

## Risks

- The backend is a large monolith, so route changes must be minimal and localized.
- Existing auth relies on request-supplied `userId`; this design follows the existing architecture and does not solve that production security risk.
- Report and patient-history quality depends on available consultation data. A small database field may be needed to distinguish walk-in from online scheduled records.
- Email/social requirements are partially simulated until SMTP/OAuth provider credentials are available.

## Implementation Approach

Use a practical feature-complete revision inside the current app structure.

1. Add database fields/helpers for verification, deadlines, notification triggers, report filters, and patient history.
2. Update registration and verification routes.
3. Update patient, doctor, and admin frontend pages.
4. Refresh generated static output with the existing build script.
5. Run syntax/build verification and manually review the implemented revision list.
