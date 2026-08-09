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

The browser's JSON API is an application interface, not an agent contract.
There are no agent discovery, tool catalog, OpenAPI, MCP, or autonomous write
surfaces in v1.

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
