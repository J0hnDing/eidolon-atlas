# Eidolon-Atlas

Eidolon-Atlas is a private, local atlas of one person's life. It keeps eight
connected kinds of information in one place:

- Person
- Experience
- Goal
- Project
- Resource
- Relationships
- Interest (Hobbies and Preferences)
- Knowledge

The application runs on `127.0.0.1`, stores its data in SQLite, and encrypts
all personal content with a passphrase-derived key. The browser provides the
primary user interface. Trusted local integrations can use the same native API
while Atlas is unlocked. Settings contains the complete native API reference
and access to Recently removed.

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
another local path, or `ATLAS_PORT` to choose another loopback port.
`ATLAS_PUBLIC_DIR` can point development builds at a different static asset
directory. The server intentionally cannot bind to a non-loopback host.

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

Exports are versioned `.atlas` files: backup v3 streams individually framed
records, revisions, Knowledge entries, and images without a whole-atlas
manifest limit. Imports use encrypted staging and atomically replace the
atlas without decrypted temporary images. Backup v1 JSON and v2 binary files
remain import-compatible.

See [Core model](docs/core-model.md), [Architecture](docs/architecture.md), and
[Security](docs/security.md) for the product contracts and limitations.
