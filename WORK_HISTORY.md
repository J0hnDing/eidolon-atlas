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
