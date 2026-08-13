# Eidolon-Atlas

Eidolon-Atlas is a private, local atlas of one person's life. It keeps eight
connected kinds of information in one place:

- Person
- Experience
- Goal
- Project
- Resource
- Relationships
- Preference
- Knowledge

The application runs on `127.0.0.1`, stores its data in SQLite, and encrypts
all personal content with a passphrase-derived key. The browser provides the
primary user interface. A small, read-only agent API is available when
explicitly enabled with a local API key. Settings contains key management, the
complete Agent and local browser API references, and access to Recently removed; see
[Agent API](docs/agent-api.md).

## Requirements

- Node.js 24 or newer
- A modern desktop browser

No package installation is required.

## Run locally

```powershell
npm start
```

Open `http://127.0.0.1:4817`. On first use, choose a passphrase. The
passphrase is never stored and cannot be recovered; keep an encrypted backup
and its passphrase somewhere safe.

For development with automatic server restart:

```powershell
npm run dev
```

The database path defaults to `data/atlas.sqlite`. Set `ATLAS_DATABASE` to use
another local path. The server intentionally cannot bind to a non-loopback
host.

## Verify

```powershell
npm run check
```

This runs syntax checks and the focused Node test suite.

## Data safety

Record contents, custom fields, notes, and Experience image bytes are encrypted
at rest. Minimal structural metadata, including attachment association and
count, timestamps, and approximate attachment size, remains visible in SQLite.
Restarting the server or choosing **Lock** removes the derived key from memory.

Exports are versioned `.atlas` files: backup v2 streams encrypted binary data
and imports decrypt into a staged area without writing decrypted temporary
images, then atomically replace the atlas. Backup v1 JSON envelopes remain
import-compatible.

See [Core model](docs/core-model.md), [Architecture](docs/architecture.md),
[Security](docs/security.md), and [Agent guide](docs/agent-guide.md) for the
product contracts and limitations.
