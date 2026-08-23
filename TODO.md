## TODO-001: Authenticate structural metadata at rest

- Priority: high
- Category: refactor
- Area: storage-integrity
- Dependencies: none
- Rationale: Record and Knowledge payloads are encrypted, but clear SQLite structure such as trash state, parent, position, status, and timestamps is not authenticated. Offline database modification can silently alter hierarchy or deletion eligibility. This requires an explicit integrity architecture rather than isolated field checks.

-Acceptance Criteria:
Select and document an integrity design for structural metadata, such as authenticated structural manifests, encrypted structural fields, or whole-database encryption.
Bind every security-relevant record and Knowledge structural value to authenticated state without breaking required query behavior.
Detect tampering with trash state, hierarchy, sibling position, status, and timestamps before affected data is displayed, restored, imported, or permanently deleted.
Provide a migration or controlled compatibility boundary for existing databases and backups.
Add tamper tests for records, Goals, Knowledge nodes, revisions, and destructive lifecycle operations.

## TODO-002: Unify router and OpenAPI contract definitions

- Priority: medium
- Category: refactor
- Area: api-contracts
- Dependencies: none
- Rationale: HTTP routing and OpenAPI are maintained independently. The audit found a live required-header mismatch that existing operation-count tests did not detect. A shared operation definition or strict bidirectional conformance layer is needed to prevent future method, path, header, body, and response drift.

-Acceptance Criteria:
Choose and implement a single source of truth, or an equally strict generated conformance mechanism, for native route and OpenAPI metadata.
Verify every documented method and path resolves to exactly one live implementation and every live API operation is documented.
Verify required headers, request content types, request schemas, success statuses, response content types, and locked/error responses.
Ensure Settings renders the same canonical contract exposed by the server.
Add regression tests that fail on route/OpenAPI drift without relying only on operation counts.

## TODO-003: Add browser behavior and smoke-test harness

- Priority: medium
- Category: test
- Area: browser-ui
- Dependencies: none
- Rationale: The primary dependency-free browser client contains substantial rendering, navigation, form, authentication, backup, and accessibility behavior. Syntax checks and a focused VM lock test do not cover complete user workflows or real browser integration.

-Acceptance Criteria:
Add maintainable DOM-level tests for rendering, form payloads, navigation, dialogs, stale-request handling, and locked-state transitions.
Add a small real-browser smoke suite covering setup, CRUD, lock and unlock, Goal progression, image handling, and backup export/import.
Run the browser suites through the standard project check or a documented CI command.
Keep tests isolated with temporary databases and deterministic cleanup.
Document the browser test architecture and troubleshooting workflow.
