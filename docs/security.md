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
Restart or manual lock discards the in-memory key.

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

## Agent API keys

The optional agent API uses one local, rotatable key. Atlas stores only a
SHA-256 verifier and non-secret display metadata; the `atlas_...` secret is
shown once when generated or rotated and is never logged or included in
encrypted backups. Revocation and rotation invalidate the previous key
immediately. Every agent discovery and read request requires
`Authorization: Bearer <key>` and an unlocked Atlas; missing or invalid keys
return `401`, while a valid key while locked returns `423`.

## Backups

Exports use their own salt, key derivation parameters, nonce, and authentication
tag. Backup v2 is a streamed binary encrypted `.atlas` format; imports stage
encrypted content and atomically replace the database without decrypted
temporary image files. v1 JSON envelopes remain import-compatible. A backup
passphrase is requested for every export or import and is never stored. Keep at
least one tested backup away from the live database.
