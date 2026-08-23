# Security

## Threat boundary

Eidolon-Atlas protects personal content in a database or backup obtained while
the application is locked. It is designed for one trusted Windows account on
one local machine. It is not hardened for shared hosting, hostile local
administrators, browser compromise, malware, or remote access.

The server binds only to `127.0.0.1` and validates same-origin browser writes.
User-authored content is rendered as text, never executable HTML. Request sizes
are bounded and secrets and decrypted payloads are excluded from logs.

## At-rest encryption

First-time setup creates a random salt and derives a 256-bit key from the
passphrase with versioned scrypt parameters. The salt and parameters are not
secret. The passphrase and derived key are never stored.

Every encrypted payload uses AES-256-GCM with a fresh random nonce and full
authentication tag. Associated data binds ciphertext to its object type,
identity, category, and revision so copied or swapped blobs fail validation.
Restart or manual lock discards the in-memory key and invalidates transient key
copies and asynchronous lifecycle work from the prior unlocked generation.

## Deliberate limitations

Application-layer encryption leaves SQLite structure visible: an observer may
learn record counts, categories, timestamps, hierarchy, and link topology.
Whole-file encryption would require a native SQLCipher dependency and is not a
v1 goal. Experience image bytes are encrypted as attachments; their
association, count, timestamps, and approximate size remain visible. Images
are limited to JPEG, PNG, and WebP, 20 MiB per image, and 50 images per
Experience. Attachment ciphertext is independent of record revision history
and retained through trash.

Knowledge follows the same boundary: branch, parent, status, revision,
timestamps, and connection topology may remain visible, while node names,
explanations, and terms are encrypted. This is an intentional structural
metadata trade-off.

There is no passphrase recovery. If the passphrase and usable backups are lost,
the data is unrecoverable. If the application is unlocked, another process
with control of the same account may be able to access the local service or
application memory.

The Settings Clear All action requires the current atlas passphrase. After it
is verified, Atlas permanently removes all user content, staged imports, and
encryption metadata, discards the in-memory key, and returns to first-time
passphrase setup. A failed passphrase check does not delete data.

## Native local API

The browser and trusted local integrations use the same loopback API. Atlas
does not authenticate individual local clients: protected operations are
available while the process-wide Atlas state is unlocked and return `423`
while it is locked. Browser mutations validate same-origin requests. A local
process running under the trusted Windows account can call the API directly,
which is part of the documented single-user threat boundary.

## Backups

Exports use their own salt, key derivation parameters, nonce, and authentication
tag. Backup v3 streams bounded frames instead of one complete manifest; imports
stage encrypted content and atomically replace the database without decrypted
temporary image files. v1 JSON envelopes and v2 binary files remain
import-compatible. A backup passphrase is requested for every export or import
and is never stored. Keep at least one tested backup away from the live database.
