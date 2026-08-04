# Eidolon-Atlas

Eidolon-Atlas is a private, local atlas of one person's life. It keeps seven
connected kinds of information in one place:

- Person
- Experience
- Goal
- Project
- Resource
- Relationships
- Preference

The application runs on `127.0.0.1`, stores its data in SQLite, and encrypts
all personal content with a passphrase-derived key. The browser provides the
only user interface in this release. Agent access is intentionally deferred.

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

Record contents, custom fields, and notes are encrypted at rest. Minimal
structural metadata—IDs, categories, ordering, timestamps, and link topology—
remains visible in the SQLite file. Restarting the server or choosing **Lock**
removes the derived key from application memory.

Exports are versioned, independently encrypted `.atlas.json` documents. An
import is fully decrypted and validated before it atomically replaces the
current atlas.

See [Core model](docs/core-model.md), [Architecture](docs/architecture.md), and
[Security](docs/security.md) for the product contracts and limitations.
