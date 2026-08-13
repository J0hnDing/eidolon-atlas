# Agent API

The Agent API is a local, read-only interface for assistants that need a
small view of an unlocked Atlas. It is not a second browser UI or a mutation
surface.

## Authentication and discovery

Generate or rotate one key from **Settings → Agent access** in the browser. The
secret has the form `atlas_...` and is displayed only once. Atlas stores only
its SHA-256 verifier; rotation and revocation invalidate the prior key. Keys
are installation-local and are excluded from encrypted backups.

Settings renders every Agent discovery and read endpoint, its operation schema,
the complete agent guide, and the Agent OpenAPI 3.1 document from the same
server-owned contract used by the authenticated resources. A second complete
local API document lists every implemented non-agent `/api/*` operation,
including lifecycle, Settings, records, goals, images, custom fields, links,
Knowledge, and backups. The Knowledge-only document remains available in the
reference payload for clients that need that narrower contract.

The unlocked browser may inspect key state with `GET /api/agent-key`, generate
or rotate with `POST /api/agent-key`, and revoke with `DELETE /api/agent-key`.
These management routes use the normal same-origin browser session, not the
agent Bearer key.

Send the key on every agent request:

```http
Authorization: Bearer atlas_...
```

The following endpoints all require that header and an unlocked Atlas:

- `GET /api/agent/tools`
- `GET /api/agent/guide`
- `GET /api/openapi.json`
- `POST /api/agent/get_personal_info`
- `POST /api/agent/list_experiences`
- `POST /api/agent/get_goals`
- `POST /api/agent/list_projects`

Read operations accept only `{}`. Missing, malformed, revoked, or incorrect
credentials return `401`; a valid key while Atlas is locked returns `423`.
Errors use the standard Atlas error envelope. The discovery endpoints publish
the same operation names, empty-object input schema, response schemas, and
Bearer security requirement as OpenAPI 3.1.

## Response contracts

`get_personal_info` returns `{ "personal_info": ... }`. The value is `null`
when no Person exists; otherwise it contains only non-sensitive built-in
profile fields in stable snake_case. Government identifiers, custom fields,
links, revisions, and metadata are never returned.

`list_experiences` returns newest-first `{ "experiences": [...] }`. Each item
contains only `title`, `time` (`start_date`, `end_date`, `ongoing`), and
`description`; missing optional values are `null` and partial dates are kept.

`get_goals` returns `{ "goals": [...], "progressions": [...] }`. Goal nodes
contain only `id`, `title`, `description`, `importance`, `horizon`,
`target_date`, and recursive `subgoals`. `progressions` records each parent's
ordered `subgoal_ids` and sibling prerequisite edges as
`{ prerequisite_goal_id, dependent_goal_id }`.

`list_projects` returns alphabetically ordered `{ "projects": [...] }` items
with only `title`, `description`, `status`, and `github_link`.

All operations omit trashed records. The API has no agent write operations,
MCP surface, Knowledge export/import, plaintext Knowledge transfer, or reset
endpoint.
