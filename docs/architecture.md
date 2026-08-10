# Architecture

One Node.js process serves the dependency-free browser client, exposes a local
JSON API, applies domain rules, and stores encrypted payloads in SQLite.

```mermaid
flowchart LR
    Browser["Browser workspace"] -->|"local JSON"| HTTP["HTTP boundary"]
    HTTP --> Domain["Atlas domain service"]
    Domain --> Crypto["Encryption boundary"]
    Crypto --> SQLite[("SQLite")]
```

The browser routes Experience, Goal, Project, Resource, and Relationship
details to full-page views; Person and Preference details remain drawer views.

## Boundaries

- `public/` owns rendering, interaction, accessible dialogs, and client-side
  guidance. It is not trusted to enforce integrity.
- `src/server.js` owns loopback HTTP, static files, bounded byte-buffered JSON
  parsing, and stable error responses. It contains no category policy.
- The domain service owns validation, optimistic revisions, goal ordering,
  acyclic sibling prerequisites, recursive progress roll-up, links, search,
  trash, history, and atomic transfer.
- The encryption collaborator owns key derivation and authenticated payload
  envelopes. Decrypted content never enters SQL queries or logs.
- The database layer owns numbered migrations, constraints, transactions, WAL,
  and test database injection.
- Experience images are stored as encrypted binary attachments. The database
  keeps only attachment association, count, timestamps, and approximate size in
  clear structural columns; attachment changes do not participate in record
  revisions, and attachments survive trash.

Knowledge uses the same domain, lock, encryption, migration, and backup
boundaries as the other workspaces. Structural Knowledge metadata remains
queryable in SQLite; names, explanations, and terms stay inside encrypted
payloads. The browser contract is namespaced under `/api/knowledge`.

Atlas also exposes a deliberately small read-only agent contract. Discovery,
the guide, OpenAPI, and four read operations require a generated Bearer API
key and an unlocked Atlas. There are no agent mutation routes, MCP surface,
plaintext Knowledge transfer, or Knowledge reset endpoint.

The unlocked Settings page reads the same server-owned agent tool, guide, and
OpenAPI objects plus a separate Knowledge OpenAPI document through
`/api/settings/api-reference`; this browser route is not part of the
Bearer-authenticated agent surface. Settings also owns key management and
navigation into Recently removed.

## Reads and search

SQLite narrows records by clear structural fields such as category and trash
state. The local process decrypts candidates and performs text matching over
titles, summaries, narratives, tags, and custom values. This favors privacy
and a small implementation over a plaintext full-text index.

## Transfer

Export serializes the complete logical state—including history and trash—and
streams attachment bytes through a separately derived backup key. Import
decrypts and validates the complete snapshot before beginning one replacement
transaction. A failed decrypt, validation, or write leaves the existing atlas
unchanged.

Backup v2 is a streamed binary encrypted `.atlas` format containing
attachments. Import uses encrypted staging, never decrypted temporary image
files, and atomically replaces the atlas after validation. Legacy v1 JSON
backup envelopes remain import-compatible.
