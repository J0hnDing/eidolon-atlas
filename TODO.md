## TODO-001: Add stateless permission-controlled agent API

- Priority: medium
- Category: feature
- Area: agent integration
- Dependencies: none
- Rationale: Atlas v1 intentionally exposes only its local browser API. Agents need a separately designed, stateless, permission-controlled contract built on the validated domain service without exposing encryption credentials or process-wide navigation state.

-Acceptance Criteria:
- Define explicit read and mutation permissions for every agent operation.
- Expose compact stateless discovery and record operations without a current-record session.
- Keep passphrases, derived keys, decrypted exports, and credential material out of agent context and logs.
- Use optimistic revisions for mutations and preserve all Atlas validation, revision, and trash invariants.
- Document and test the agent contract independently from the browser API.
