# Complete Review Closure Design

Date: 2026-06-14
Status: Approved design, pending implementation plan

## Purpose

Close the remaining partial and unverifiable low/medium thesis review items without inventing adviser sign-off evidence. This pass completes technical gaps and creates honest process-evidence templates marked pending adviser confirmation.

## Scope

In scope:

- Add CI so test activities are wired beyond local `npm test`.
- Extend report filtering so non-consultation report sections apply search/date where practical.
- Normalize consultation statuses consistently in staff/doctor/admin update paths.
- Pad doctor diagnostic report statuses with zero-count known statuses.
- Create pending adviser/title/process evidence documents under `docs/review/`.
- Extend static regression tests for the new closure items.
- Refresh generated static frontend output after canonical changes.

Out of scope:

- Fabricating completed adviser approval or title discussion evidence.
- Adding a full database-backed integration test suite.
- Reworking authentication/session architecture.
- Redesigning the report UI beyond the existing static dashboard patterns.

## Approach

### CI And Test Evidence

Add a GitHub Actions workflow at `.github/workflows/ci.yml`. The workflow will run on pushes and pull requests, install dependencies in `EMRsystem`, run syntax checks, run tests, and run the static build. This closes the "tests are not wired into CI" gap while preserving the existing Node built-in test approach.

### Report Filtering

`db.getAdminReportData()` already applies search/date filters to consultation report sections. This pass will add scoped filters for user/security sections where the data supports it:

- User role/status/recent rows will filter by user search text and created date.
- Password reset rows will filter by requested date where available.
- Notification counts will filter by type/message search and created date where available.
- Invite counts will filter by created/expiry date where available.

Consultation reports will keep their current all-matching transaction behavior. Patient-history reports will continue to use `getPatientHistoryReport()`.

### Status Normalization

Add a single server-side status normalization helper for consultation updates. It will map:

- `approved` to `scheduled`
- `rejected` to `denied`
- `no-show` and `no_show` to `marked-no-show`

The helper will be used in doctor consultation updates and staff schedule updates so reports do not receive divergent status labels from different routes. Existing report padding will continue showing canonical statuses with zero counts.

### Doctor Diagnostic Status Padding

`db.getDiagnosticReportData()` will use the same consultation status padding helper as admin reports. This makes doctor report status tables include known zero-count statuses and align with admin report behavior.

### Review Evidence Documents

Create `docs/review/` documents that are truthful templates, not fake approvals:

- `adviser-panel-system-document-review.md`: checklist for system and document review before panel consultation, status marked pending adviser confirmation.
- `title-revision-discussion.md`: title discussion log template, status marked pending adviser confirmation.
- `incorporated-changes-approval.md`: matrix linking implemented changes to files/tests, with approval fields marked pending adviser confirmation.

These documents make the process requirements trackable in the repo while clearly showing they are not completed until real adviser details are supplied.

## Data Flow

CI:

1. GitHub Actions checks out the repo.
2. Node is installed.
3. `npm --prefix EMRsystem install` installs dependencies.
4. Syntax, tests, and build commands run.

Reports:

1. Admin enters search/date filters.
2. `/api/admin/reports/:type` passes filters to the database layer.
3. `getAdminReportData()` applies filters to consultation, user, and security report sections where fields exist.
4. Admin UI renders filtered statistics and detail tables.

Status updates:

1. Doctor/staff submits a consultation status update.
2. Server normalizes aliases to canonical status labels.
3. Database stores canonical statuses.
4. Reports aggregate canonical statuses and pad known missing statuses.

Process evidence:

1. Docs are created with pending status and required evidence fields.
2. Future adviser/title details can be filled in without changing app code.

## Error Handling

- CI failures will block the workflow and surface failing command logs.
- Report filters with unsupported fields will not throw; they will simply apply to the relevant report section only.
- Unknown legacy consultation statuses will remain visible in reports while known statuses are padded.
- Process docs will explicitly distinguish pending fields from confirmed evidence.

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

Static regression tests will verify:

- CI workflow exists and runs install, syntax, tests, and build.
- Report data applies user/security filters in addition to consultation filters.
- Staff schedule and doctor update routes share status normalization.
- Doctor diagnostics use padded consultation statuses.
- Review evidence docs exist and are marked pending adviser confirmation.

## Risks

- CI cannot be proven to execute until the repository is pushed to a platform that runs GitHub Actions, but the workflow file can be verified locally.
- User/security date filtering depends on available timestamp columns and may not be meaningful for every aggregate.
- Pending process templates do not prove actual adviser review; they only create honest evidence placeholders.
