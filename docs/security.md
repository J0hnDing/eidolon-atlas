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
v1 goal.

There is no passphrase recovery. If the passphrase and usable backups are lost,
the data is unrecoverable. If the application is unlocked, another process
with control of the same account may be able to access the local service or
application memory.

## Backups

Exports use their own salt, key derivation parameters, nonce, and authentication
tag. A backup passphrase is requested for every export or import and is never
stored. Keep at least one tested backup away from the live database.
