# Low/Medium Review Fixes Design

Date: 2026-06-14
Status: Approved design, pending implementation plan

## Purpose

Implement the enforceable low and medium thesis review comments that remain partially applied. This pass excludes process-only adviser/title/sign-off evidence items because the user chose to skip process-only items.

## Scope

This change targets the existing static HTML, Express, and PostgreSQL codebase without introducing a frontend framework or new test framework.

In scope:

- Admin account creation required-field markers.
- Admin-created account password policy parity with public registration.
- Automated test script wiring and static regression checks.
- Admin reports that honor filters consistently and support all matching transactions.
- Complete report status categories, including zero-count categories.
- Consistent 12-hour report date/time formatting.
- Minimal staff walk-in consultation capture for existing patients.
- Build refresh for generated static frontend output.

Out of scope:

- Adviser/panel review evidence documents.
- Title revision discussion records.
- Formal adviser approval/sign-off artifacts.
- Full authentication/session redesign.
- Full registration/scheduling workflow refactor.

## Approach

### Admin Account Creation

The admin Add User form will reuse the public registration visual conventions. Required labels will include the existing `required-marker` span, and the password field will show the same password restrictions used by `register.html`.

The backend `/api/admin/users` route will call the existing `getPasswordValidationMessage(password)` helper. This makes the server enforce the same password rules for public and admin-created accounts instead of relying only on browser validation.

### Testing

The repository will use the existing Node built-in test style. `EMRsystem/package.json` will gain a `test` script for `test-revisions.js`, and the root `package.json` will delegate to it.

`test-revisions.js` will be extended with static regression checks for:

- Admin password policy enforcement in the server route.
- Admin required-field markers and password restriction UI.
- Report all-transaction behavior markers.
- Report 12-hour formatter usage.
- Walk-in consultation support markers.

No new test dependency is required.

### Reports

`db.getAdminReportData()` will apply report filters consistently to consultation aggregates, daily trends, totals, and detailed rows where those fields are consultation-based.

The consultations report will return all matching transaction rows instead of limiting the detail table to ten recent rows. The UI label will reflect this by rendering the detail panel as all matching transactions.

Known statuses will be padded into count arrays with zero counts while preserving unknown legacy statuses returned from the database. This avoids hiding valid old data while satisfying the requirement that reports show statuses such as pending, scheduled, completed, denied, cancelled, and no-show states.

### Date And Time Formatting

Admin report rendering will use a dedicated formatter that explicitly sets `hour12: true`. Report generated timestamps and report table timestamps will use that helper. Doctor report generated timestamps will also use explicit 12-hour formatting.

### Walk-In Capture

Staff will get a minimal walk-in capture workflow for existing patients. The backend will expose a staff/admin route that creates a consultation with `consultation_source = 'walk-in'`. When schedule details are provided, the route will create the consultation in a scheduled state using existing consultation fields.

The staff dashboard will add a small form for patient ID, concerns, optional doctor, date, time, and end time. Created walk-in consultations will then appear in existing history and reports as walk-in records.

## Data Flow

Admin account creation:

1. Admin fills Add User form.
2. Browser applies required fields and password hints.
3. `/api/admin/users` enforces the shared backend password policy.
4. Existing user/profile creation logic continues.

Reports:

1. Admin selects search and date filters.
2. Frontend sends filters to `/api/admin/reports/:type`.
3. Backend applies filters to detail rows and consultation-based aggregates.
4. Frontend renders all matching rows, status counts, and 12-hour timestamps.

Walk-in capture:

1. Staff enters an existing patient ID and walk-in details.
2. Backend verifies staff/admin role and patient identity.
3. Backend creates a consultation with source `walk-in`.
4. Existing report/history views categorize it as walk-in.

## Error Handling

- Admin account creation will return the existing password policy message on weak passwords.
- Walk-in creation will reject missing staff/admin identity, invalid patient IDs, non-patient users, past dates, unavailable doctors, and slot/capacity conflicts using existing scheduling helpers where applicable.
- Report APIs will continue returning JSON error responses through existing route-level `try/catch` patterns.

## Verification

Planned verification commands:

```powershell
node --check EMRsystem/server.js
node --check EMRsystem/db.js
node --check EMRsystem/test-revisions.js
npm --prefix EMRsystem test
npm test
npm --prefix EMRsystem run build
```

Manual verification targets:

- Admin weak password is rejected.
- Admin form shows required markers and password rules.
- Consultation report detail no longer caps all-transactions output at ten rows.
- Report timestamps show AM/PM where applicable.
- Staff-created walk-in consultation appears as walk-in in report/history output.

## Risks

- Returning all matching consultations may create large printable reports. This is acceptable for the review requirement but may later need pagination/export.
- Staff walk-in capture assumes the patient already exists. Anonymous walk-in registration remains out of scope.
- Generated `VercelFrontend` output must be refreshed after canonical `EMRsystem` edits.
