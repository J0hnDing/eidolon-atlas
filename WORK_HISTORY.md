## 2026-08-04 00:35 — Implemented encrypted Eidolon-Atlas v1

- Category: feature
- Area: application

### Summary

Built the local single-user Atlas application with seven typed personal-information categories, cross-record links, ordered goal hierarchies, custom fields, encrypted SQLite payloads, passphrase setup and locking, revisions, trash and restore, search, encrypted atomic backup transfer, a polished responsive browser interface, and focused security/domain/HTTP tests. Added product, architecture, and security documentation. Browser QA covered setup, onboarding, timeline creation, deep subgoal navigation, desktop layout, and mobile layout. Recorded agent integration separately as TODO-001.

### Limitations

Application-layer encryption leaves structural metadata such as categories, timestamps, hierarchy, and link topology visible. Search and backup transfer decrypt in process memory and target local v1-scale datasets. Custom-field definitions can be created and record values edited in the UI; definition edit/archive/delete remain available only through the local browser API. Agent APIs are deferred to TODO-001.

## 2026-08-05 02:34 — Added structured Person profiles, full-page record routes, and encrypted Experience galleries

- Category: feature
- Area: application

### Summary

Replaced Person contact/status blocks with validated predefined and repeatable profile fields plus a collapsed sensitive section; added SPA list/search/trash and full-page detail routing for Experience, Goal, Project, Resource, and Relationship; added encrypted JPEG/PNG/WebP Experience attachments with gallery and lightbox UI; introduced streamed authenticated .atlas backup v2 with encrypted staging, atomic import, and v1 JSON compatibility; expanded documentation and focused tests.

### Limitations

Images preserve originals without thumbnails, captions, or manual ordering; staged v2 uploads are bounded at 2 GiB. Automated browser-window QA could not complete because both local browser-control helpers failed, though syntax, HTTP, deep-link, encryption, limit, and tamper tests passed.

## 2026-08-07 20:11 — Add relationship categories and category landing page

- Category: feature
- Area: Relationships

### Summary

Replaced the broad person relationship kind with Family, Partner/Spouse, Friends, Acquaintances, Coworkers, Mentors, and Organizations; added a boxed category overview with drill-down views; added one-time person-to-Family migration, tests, and core model documentation.

### Limitations

The already-running Atlas server must be restarted and unlocked once before the encrypted relationship migration executes. Automated visual browser inspection was unavailable because local window connectors could not attach; syntax, domain behavior, migration behavior, and the full test suite were verified.

## 2026-08-07 23:52 — Move lifecycle status from Goals to Projects and add GitHub links

- Category: feature
- Area: Goals and Projects

### Summary

Removed the built-in Goal status field and its status filters; added the planned, active, paused, completed, and abandoned lifecycle status contract and filters to Projects; removed Project currentState; added an optional validated GitHub Link field with a one-click external link in project details; updated tests and core model documentation.

### Limitations

No migration or backward compatibility was added for existing Goal status or Project currentState data, as requested. Automated visual browser inspection was not run; syntax checks and the full automated test suite passed.

## 2026-08-09 00:16 — Refine subgoal parent details and graph sizing

- Category: bugfix
- Area: Goals

### Summary

Added immediate parent-goal context to subgoal Details and made it navigable. Hard-bounded progression and final-goal card dimensions, truncated long titles and prerequisite labels with ellipses, and stabilized card geometry used by DAG arrows.

### Limitations

none

## 2026-08-08 22:51 — Add goal progression DAGs and progress roll-ups

- Category: feature
- Area: Goals

### Summary

Added per-goal progression graphs with sibling prerequisite DAG validation, recursive progress roll-ups, encrypted backup portability, dedicated pre-details UI, subgoal creation and inspection, progress editing, and removal to Recently Removed. Updated model documentation and focused tests.

### Limitations

Subgoal prerequisite relationships are selected when the subgoal is created; changing an existing prerequisite currently requires removing and recreating that subgoal.

## 2026-08-09 00:34 — Simplify goal creation fields and add descriptions

- Category: refactor
- Area: Goals

### Summary

Simplified top-level Goal creation to title, horizon, target date, and description; removed parent and order controls from generic goal editing; retained dedicated Subgoal progress with a zero default; removed progress note and motivation from the goal contract; migrated their encrypted current and historical values into description; and kept parent progress derived from subgoals.

### Limitations

none

## 2026-08-10 02:24 — Integrate encrypted Knowledge workspace

- Category: feature
- Area: Knowledge

### Summary

Added Epistome-compatible Knowledge taxonomy, encrypted storage, hierarchy and connection invariants, backup compatibility, Atlas-native routes and CRUD UI, documentation, and regression coverage as the eighth workspace.

### Limitations

Automated browser visual QA could not run because the in-app browser connector failed during initialization; syntax, unit/integration tests, and isolated live HTTP/deep-link checks passed.

## 2026-08-10 02:24 — Add stateless permission-controlled agent API

- Category: feature
- Area: agent integration

### Summary

Implemented the minimal stateless read-only agent API with verifier-only rotating keys, authenticated discovery/guide/OpenAPI resources, exact allowlisted Person, Experience, Goal, and Project projections, locked-runtime enforcement, UI key management, documentation, and automated/live HTTP coverage.

### Limitations

Automated browser visual QA could not run because the in-app browser connector failed during initialization; syntax, unit/integration tests, and isolated live HTTP/deep-link checks passed.

## 2026-08-10 14:13 — Add authenticated Clear All reset in Settings

- Category: feature
- Area: settings and data lifecycle

### Summary

Added a Settings danger-zone Clear All flow that requires the current atlas passphrase and irreversible-action acknowledgement. Added POST /api/reset and Atlas.clearAll() to verify credentials, clear staged imports and all user/encryption/agent data transactionally, discard the in-memory key, and return uninitialized locked status. Reset browser state and route to first-time passphrase setup. Documented the security behavior and added direct plus HTTP regression tests, including wrong-passphrase preservation and successful setup with a new passphrase. npm run check passes all 28 tests.

### Limitations

SQLite schema migrations are intentionally preserved so the existing database can be initialized again; no browser automation was run.

## 2026-08-12 22:51 — Correct Settings API reference descriptions

- Category: bugfix
- Area: Settings and OpenAPI

### Summary

Added distinct operation descriptions to all Knowledge and Agent OpenAPI operations, replaced misleading generic UI fallbacks, corrected related Knowledge schema and error-response drift, fixed the Knowledge tree HTTP fixture, and repaired a Settings loading-label encoding error. npm run check and live HTTP contract verification passed.

### Limitations

In-app visual browser automation was unavailable due to a runtime bootstrap conflict; the restarted production server is locked and requires the user to unlock it before manual Settings inspection.

## 2026-08-14 00:19 — Removed Agent API and key management

- Category: refactor
- Area: API and Settings

### Summary

Removed all Bearer Agent and agent-key routes, catalogs, projections, controls, styles, and documentation. Retained only native unlocked and Knowledge OpenAPI references, reduced the local contract to 42 operations, and added automatic legacy agent-key verifier purge. Added retired-route, contract, Knowledge, lock, and migration coverage; npm run check passes 29 tests and live HTTP checks confirmed the new contract.

### Limitations

In-app browser visual QA was unavailable because the browser-control runtime failed to initialize; automated UI-independent Atlas checks and live HTTP verification passed.
