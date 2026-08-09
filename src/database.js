import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        trashed INTEGER NOT NULL DEFAULT 0 CHECK (trashed IN (0, 1)),
        parent_id TEXT,
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES records(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS record_revisions (
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        category TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (record_id, revision),
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS custom_fields (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS links (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        CHECK (source_id <> target_id),
        FOREIGN KEY (source_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES records(id) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE INDEX IF NOT EXISTS records_category_trashed ON records(category, trashed);
      CREATE INDEX IF NOT EXISTS records_goal_order ON records(category, parent_id, position);
      CREATE INDEX IF NOT EXISTS revisions_record ON record_revisions(record_id, revision DESC);
      CREATE INDEX IF NOT EXISTS links_source ON links(source_id);
      CREATE INDEX IF NOT EXISTS links_target ON links(target_id);
    `,
  },
  {
    version: 3,
    sql: `ALTER TABLE custom_fields ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));`,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE record_images (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        created_at TEXT NOT NULL,
        metadata TEXT NOT NULL,
        content BLOB NOT NULL,
        UNIQUE (record_id, position),
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX record_images_record ON record_images(record_id, position);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE goal_dependencies (
        goal_id TEXT NOT NULL,
        prerequisite_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (goal_id, prerequisite_id),
        CHECK (goal_id <> prerequisite_id),
        FOREIGN KEY (goal_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (prerequisite_id) REFERENCES records(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX goal_dependencies_prerequisite ON goal_dependencies(prerequisite_id);
    `,
  },
];

export function openDatabase(path = 'data/atlas.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
