import { createReadStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { open, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase, transaction } from './database.js';
import {
  BACKUP_V2_MAGIC, BACKUP_V2_MAX_HEADER_BYTES, BACKUP_V2_MAX_MANIFEST_BYTES, DEFAULT_KDF, createBackupEnvelope,
  createBackupV2Decipher, createBackupV2Stream, decryptBinary, decryptJson, deriveKey,
  encryptBinary, encryptJson, makeKeyCheck, objectAad, openBackupEnvelope, verifyKeyCheck,
} from './crypto.js';
import {
  CATEGORIES, canonicalJson, normalizeCustomField, normalizeLink, normalizeRecord,
  requireObject, requireRevision, validateCustomFieldValue,
} from './domain.js';
import { AtlasError, fail } from './errors.js';

const KEY_CONFIG = 'encryption-config';
const KEY_CHECK = 'key-check';
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_PER_EXPERIENCE = 50;
export const BACKUP_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function now() { return new Date().toISOString(); }
function integerPosition(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) fail(400, 'VALIDATION_ERROR', 'position must be a non-negative integer.');
  return value;
}

function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function validateImageMetadata({ filename, mimeType, byteLength }, { backup = false } = {}) {
  const invalid = (message) => fail(backup ? 400 : 400, backup ? 'INVALID_BACKUP' : 'VALIDATION_ERROR', message);
  if (typeof filename !== 'string' || filename.trim() === '' || Buffer.byteLength(filename, 'utf8') > 1024 || /[\u0000\r\n]/.test(filename)) {
    invalid(backup ? 'An image filename is invalid.' : 'Image filename must be a non-empty string of at most 1024 bytes.');
  }
  if (!IMAGE_MIME_TYPES.has(mimeType)) invalid(backup ? 'An image MIME type is invalid.' : 'Only JPEG, PNG, and WebP images are supported.');
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > IMAGE_MAX_BYTES) {
    invalid(backup ? 'An image byte length is invalid.' : `Image content must be between 1 and ${IMAGE_MAX_BYTES} bytes.`);
  }
}

export class Atlas {
  #db;
  #key = null;
  #closed = false;
  #stagingDir;
  #uploads = new Map();

  constructor({ databasePath = 'data/atlas.sqlite' } = {}) {
    this.#db = openDatabase(databasePath);
    this.#stagingDir = databasePath === ':memory:'
      ? join(tmpdir(), `eidolon-atlas-imports-${randomUUID()}`)
      : `${resolve(databasePath)}.imports`;
    rmSync(this.#stagingDir, { recursive: true, force: true });
    mkdirSync(this.#stagingDir, { recursive: true });
  }

  close() {
    if (this.#closed) return;
    this.lock();
    this.#db.close();
    rmSync(this.#stagingDir, { recursive: true, force: true });
    this.#closed = true;
  }

  get database() { return this.#db; }

  status() {
    const initialized = Boolean(this.#meta(KEY_CONFIG));
    return { initialized, locked: this.#key === null };
  }

  async setup(passphrase) {
    if (this.#meta(KEY_CONFIG)) fail(409, 'ALREADY_INITIALIZED', 'Atlas has already been set up.');
    const salt = randomBytes(16);
    const parameters = { ...DEFAULT_KDF };
    const key = await deriveKey(passphrase, salt, parameters);
    const config = { ...parameters, salt: salt.toString('base64') };
    const check = makeKeyCheck(key);
    try {
      transaction(this.#db, () => {
        this.#setMeta(KEY_CONFIG, config);
        this.#setMeta(KEY_CHECK, check);
      });
      this.#replaceKey(key);
      return this.status();
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  async unlock(passphrase) {
    const config = this.#meta(KEY_CONFIG);
    const check = this.#meta(KEY_CHECK);
    if (!config || !check) fail(409, 'NOT_INITIALIZED', 'Atlas must be set up first.');
    const salt = Buffer.from(config.salt ?? '', 'base64');
    if (salt.length !== 16) fail(500, 'INVALID_ENCRYPTION_CONFIG', 'Stored encryption configuration is invalid.');
    const parameters = { ...config };
    delete parameters.salt;
    const key = await deriveKey(passphrase, salt, parameters);
    try {
      verifyKeyCheck(key, check);
    } catch (error) {
      key.fill(0);
      if (error instanceof AtlasError && error.code === 'DATA_INTEGRITY_ERROR') {
        fail(401, 'INVALID_PASSPHRASE', 'The passphrase is incorrect.');
      }
      throw error;
    }
    this.#replaceKey(key);
    this.#migrateRelationshipKinds();
    return this.status();
  }

  lock() {
    if (this.#key) this.#key.fill(0);
    this.#key = null;
    return this.status();
  }

  createRecord(input) {
    this.#requireUnlocked();
    const content = normalizeRecord(input);
    if (content.category === 'person' && this.#db.prepare("SELECT 1 FROM records WHERE category = 'person' LIMIT 1").get()) {
      fail(409, 'PERSON_EXISTS', 'The singleton person profile already exists.');
    }
    this.#validateCustomValues(content.category, content.customFieldValues);
    const id = randomUUID();
    const createdAt = now();
    let parentId = content.category === 'goal' ? (input.parentId ?? null) : null;
    if (content.category !== 'goal' && (input.parentId !== undefined || input.position !== undefined)) {
      fail(400, 'VALIDATION_ERROR', 'Only goals can have parentId or position.');
    }
    if (content.category === 'goal') this.#validateGoalParent(id, parentId);
    const requestedPosition = integerPosition(input.position);
    const position = content.category === 'goal'
      ? this.#insertPosition(parentId, requestedPosition)
      : 0;
    const snapshot = { ...content, parentId, position, trashed: false };
    transaction(this.#db, () => {
      if (content.category === 'goal') this.#shiftPositions(parentId, position, 1);
      this.#db.prepare(`INSERT INTO records
        (id, category, revision, trashed, parent_id, position, created_at, updated_at, payload)
        VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?)`)
        .run(id, content.category, parentId, position, createdAt, createdAt,
          this.#encryptRecord(id, 1, content.category, snapshot));
      this.#insertRevision(id, 1, content.category, createdAt, snapshot);
    });
    return this.getRecord(id);
  }

  listRecords({ category, q, trashed = false } = {}) {
    this.#requireUnlocked();
    if (category !== undefined && !CATEGORIES.includes(category)) fail(400, 'VALIDATION_ERROR', 'Unknown category.');
    const mode = trashed === 'all' ? 'all' : (trashed === true || trashed === 'true' ? true : false);
    let sql = 'SELECT * FROM records';
    const clauses = [];
    const args = [];
    if (category) { clauses.push('category = ?'); args.push(category); }
    if (mode !== 'all') { clauses.push('trashed = ?'); args.push(mode ? 1 : 0); }
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += " ORDER BY CASE category WHEN 'goal' THEN 0 ELSE 1 END, parent_id, position, updated_at DESC";
    let records = this.#db.prepare(sql).all(...args).map((row) => this.#recordFromRow(row));
    if (typeof q === 'string' && q.trim()) {
      const query = q.normalize('NFKC').toLocaleLowerCase();
      records = records.filter((record) => canonicalJson({
        title: record.title, data: record.data, customFieldValues: record.customFieldValues,
      }).normalize('NFKC').toLocaleLowerCase().includes(query));
    }
    return records;
  }

  getRecord(id, { includeConnections = true } = {}) {
    this.#requireUnlocked();
    const row = this.#recordRow(id);
    const record = this.#recordFromRow(row);
    if (includeConnections) {
      record.links = this.#linksFor(id, true);
      record.backlinks = this.#linksFor(id, false);
    }
    return record;
  }

  patchRecord(id, input) {
    this.#requireUnlocked();
    requireObject(input);
    const row = this.#recordRow(id);
    requireRevision(input.revision);
    if (input.revision !== row.revision) this.#revisionConflict(row.revision);
    const existing = this.#recordFromRow(row);
    const content = normalizeRecord(input, existing);
    this.#validateCustomValues(content.category, content.customFieldValues,
      { existingValues: existing.customFieldValues });
    let parentId = existing.parentId;
    let position = existing.position;
    if (content.category !== 'goal' && (input.parentId !== undefined || input.position !== undefined)) {
      fail(400, 'VALIDATION_ERROR', 'Only goals can have parentId or position.');
    }
    if (content.category === 'goal') {
      parentId = input.parentId === undefined ? existing.parentId : input.parentId;
      if (parentId === '') parentId = null;
      this.#validateGoalParent(id, parentId);
      if (input.position !== undefined) integerPosition(input.position);
      if (parentId !== existing.parentId || input.position !== undefined) {
        const requested = input.position === undefined ? undefined : input.position;
        position = this.#insertPosition(parentId, requested, id);
      }
    }
    const candidate = { ...content, parentId, position, trashed: existing.trashed };
    const current = { category: existing.category, title: existing.title, data: existing.data,
      customFieldValues: existing.customFieldValues, parentId: existing.parentId,
      position: existing.position, trashed: existing.trashed };
    if (canonicalJson(candidate) === canonicalJson(current)) return this.getRecord(id);
    const revision = row.revision + 1;
    const updatedAt = now();
    transaction(this.#db, () => {
      if (content.category === 'goal' && (parentId !== existing.parentId || position !== existing.position)) {
        this.#removePosition(existing.parentId, existing.position, id);
        this.#shiftPositions(parentId, position, 1, id);
      }
      this.#db.prepare(`UPDATE records SET revision = ?, parent_id = ?, position = ?, updated_at = ?, payload = ?
        WHERE id = ? AND revision = ?`)
        .run(revision, parentId, position, updatedAt,
          this.#encryptRecord(id, revision, content.category, candidate), id, row.revision);
      this.#insertRevision(id, revision, content.category, updatedAt, candidate);
    });
    return this.getRecord(id);
  }

  trashRecord(id, revision) {
    this.#requireUnlocked();
    const row = this.#recordRow(id);
    requireRevision(revision);
    if (revision !== row.revision) this.#revisionConflict(row.revision);
    const existing = this.#recordFromRow(row);
    if (existing.trashed) return this.getRecord(id);
    if (existing.category === 'goal') {
      const child = this.#db.prepare("SELECT 1 FROM records WHERE category = 'goal' AND parent_id = ? AND trashed = 0 LIMIT 1").get(id);
      if (child) fail(409, 'GOAL_HAS_ACTIVE_CHILDREN', 'Trash active subgoals before trashing this goal.');
    }
    return this.#changeTrash(existing, true);
  }

  restoreRecord(id, revision) {
    this.#requireUnlocked();
    const row = this.#recordRow(id);
    requireRevision(revision);
    if (revision !== row.revision) this.#revisionConflict(row.revision);
    const existing = this.#recordFromRow(row);
    if (!existing.trashed) return this.getRecord(id);
    if (existing.category === 'goal' && existing.parentId) {
      const parent = this.#db.prepare('SELECT trashed FROM records WHERE id = ?').get(existing.parentId);
      if (!parent || parent.trashed) fail(409, 'GOAL_PARENT_TRASHED', 'Restore the parent goal first.');
    }
    return this.#changeTrash(existing, false);
  }

  listRevisions(id) {
    this.#requireUnlocked();
    this.#recordRow(id);
    return this.#db.prepare('SELECT * FROM record_revisions WHERE record_id = ? ORDER BY revision DESC').all(id)
      .map((row) => {
        const snapshot = decryptJson(this.#key, row.payload, objectAad('revision', id, row.revision, row.category));
        return { id, category: row.category, revision: row.revision, createdAt: row.created_at, ...snapshot };
      });
  }

  restoreRevision(id, revision, expectedRevision = undefined) {
    this.#requireUnlocked();
    requireRevision(revision);
    const currentRow = this.#recordRow(id);
    if (expectedRevision !== undefined) {
      requireRevision(expectedRevision);
      if (expectedRevision !== currentRow.revision) this.#revisionConflict(currentRow.revision);
    }
    const historical = this.#db.prepare('SELECT * FROM record_revisions WHERE record_id = ? AND revision = ?').get(id, revision);
    if (!historical) fail(404, 'REVISION_NOT_FOUND', 'Revision not found.');
    const snapshot = decryptJson(this.#key, historical.payload,
      objectAad('revision', id, historical.revision, historical.category));
    const content = normalizeRecord(snapshot);
    if (content.category === 'goal') this.#validateGoalParent(id, snapshot.parentId);
    const existing = this.#recordFromRow(currentRow);
    this.#validateCustomValues(content.category, content.customFieldValues,
      { existingValues: existing.customFieldValues });
    const candidate = { ...content, parentId: snapshot.parentId ?? null,
      position: integerPosition(snapshot.position) ?? 0, trashed: Boolean(snapshot.trashed) };
    if (candidate.category === 'goal') {
      if (candidate.trashed && !existing.trashed) {
        const child = this.#db.prepare("SELECT 1 FROM records WHERE category = 'goal' AND parent_id = ? AND trashed = 0 LIMIT 1").get(id);
        if (child) fail(409, 'GOAL_HAS_ACTIVE_CHILDREN', 'Trash active subgoals before restoring this revision.');
      }
      if (!candidate.trashed) candidate.position = this.#insertPosition(candidate.parentId, candidate.position, id);
    }
    const current = { category: existing.category, title: existing.title, data: existing.data,
      customFieldValues: existing.customFieldValues, parentId: existing.parentId,
      position: existing.position, trashed: existing.trashed };
    if (canonicalJson(candidate) === canonicalJson(current)) return this.getRecord(id);
    const newRevision = currentRow.revision + 1;
    const updatedAt = now();
    transaction(this.#db, () => {
      if (candidate.category === 'goal') {
        if (!existing.trashed) this.#removePosition(existing.parentId, existing.position, id);
        if (!candidate.trashed) this.#shiftPositions(candidate.parentId, candidate.position, 1, id);
      }
      this.#db.prepare(`UPDATE records SET revision = ?, trashed = ?, parent_id = ?, position = ?, updated_at = ?, payload = ?
        WHERE id = ? AND revision = ?`).run(newRevision, candidate.trashed ? 1 : 0,
        candidate.parentId, candidate.position, updatedAt,
        this.#encryptRecord(id, newRevision, candidate.category, candidate), id, currentRow.revision);
      this.#insertRevision(id, newRevision, candidate.category, updatedAt, candidate);
    });
    return this.getRecord(id);
  }

  listCustomFields({ category } = {}) {
    this.#requireUnlocked();
    if (category !== undefined && !CATEGORIES.includes(category)) fail(400, 'VALIDATION_ERROR', 'Unknown category.');
    const rows = category === undefined
      ? this.#db.prepare('SELECT * FROM custom_fields ORDER BY category, created_at').all()
      : this.#db.prepare('SELECT * FROM custom_fields WHERE category = ? ORDER BY created_at').all(category);
    return rows
      .map((row) => this.#customFieldFromRow(row));
  }

  createCustomField(input) {
    this.#requireUnlocked();
    const field = normalizeCustomField(input);
    const duplicate = this.listCustomFields().find((item) => item.category === field.category &&
      item.name.normalize('NFKC').toLocaleLowerCase() === field.name.normalize('NFKC').toLocaleLowerCase());
    if (duplicate) fail(409, 'CUSTOM_FIELD_EXISTS', 'A custom field with that name already exists in the category.');
    const id = randomUUID();
    const createdAt = now();
    const payload = encryptJson(this.#key, { name: field.name, options: field.options },
      objectAad('custom-field', id, 1, field.category));
    this.#db.prepare(`INSERT INTO custom_fields(id, category, type, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, field.category, field.type, createdAt, createdAt, payload);
    return this.#customFieldFromRow(this.#db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(id));
  }

  patchCustomField(id, input) {
    this.#requireUnlocked();
    const row = this.#customFieldRow(id);
    const existing = this.#customFieldFromRow(row);
    if (existing.archived) fail(409, 'CUSTOM_FIELD_ARCHIVED', 'An archived custom field cannot be changed.');
    const field = normalizeCustomField(input, existing);
    for (const record of this.listRecords({ category: field.category, trashed: 'all' })) {
      if (Object.hasOwn(record.customFieldValues, id)) validateCustomFieldValue(field, record.customFieldValues[id]);
    }
    const updatedAt = now();
    const payload = encryptJson(this.#key, { name: field.name, options: field.options },
      objectAad('custom-field', id, 1, field.category));
    this.#db.prepare('UPDATE custom_fields SET type = ?, updated_at = ?, payload = ? WHERE id = ?')
      .run(field.type, updatedAt, payload, id);
    return this.#customFieldFromRow(this.#db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(id));
  }

  deleteCustomField(id) {
    this.#requireUnlocked();
    const row = this.#customFieldRow(id);
    const field = this.#customFieldFromRow(row);
    let recordsUpdated = 0;
    let revisionsUpdated = 0;
    transaction(this.#db, () => {
      const recordRows = this.#db.prepare('SELECT * FROM records WHERE category = ?').all(field.category);
      for (const recordRow of recordRows) {
        const record = this.#recordFromRow(recordRow);
        if (!Object.hasOwn(record.customFieldValues, id)) continue;
        const customFieldValues = { ...record.customFieldValues };
        delete customFieldValues[id];
        const snapshot = this.#snapshotFromRecord({ ...record, customFieldValues });
        this.#db.prepare('UPDATE records SET payload = ? WHERE id = ?').run(
          this.#encryptRecord(record.id, record.revision, record.category, snapshot), record.id,
        );
        recordsUpdated += 1;
      }
      const revisionRows = this.#db.prepare('SELECT * FROM record_revisions WHERE category = ?').all(field.category);
      for (const revisionRow of revisionRows) {
        const snapshot = decryptJson(this.#key, revisionRow.payload,
          objectAad('revision', revisionRow.record_id, revisionRow.revision, revisionRow.category));
        if (!Object.hasOwn(snapshot.customFieldValues ?? {}, id)) continue;
        const customFieldValues = { ...(snapshot.customFieldValues ?? {}) };
        delete customFieldValues[id];
        const payload = encryptJson(this.#key, { ...snapshot, customFieldValues },
          objectAad('revision', revisionRow.record_id, revisionRow.revision, revisionRow.category));
        this.#db.prepare('UPDATE record_revisions SET payload = ? WHERE record_id = ? AND revision = ?')
          .run(payload, revisionRow.record_id, revisionRow.revision);
        revisionsUpdated += 1;
      }
      this.#db.prepare('DELETE FROM custom_fields WHERE id = ?').run(id);
    });
    return { deleted: true, field, recordsUpdated, revisionsUpdated };
  }

  emptyTrash() {
    this.#requireUnlocked();
    const { count } = this.#db.prepare('SELECT COUNT(*) AS count FROM records WHERE trashed = 1').get();
    if (!count) return { deleted: 0 };
    transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM records WHERE trashed = 1').run();
    });
    return { deleted: count };
  }

  createLink(input) {
    this.#requireUnlocked();
    const link = normalizeLink(input);
    this.#recordRow(link.sourceId);
    this.#recordRow(link.targetId);
    const duplicate = this.#db.prepare('SELECT 1 FROM links WHERE source_id = ? AND target_id = ?').get(link.sourceId, link.targetId);
    if (duplicate) fail(409, 'LINK_EXISTS', 'These records are already linked in this direction.');
    const id = randomUUID();
    const createdAt = now();
    const payload = encryptJson(this.#key, { type: link.type, label: link.label, notes: link.notes },
      objectAad('link', id, 1, 'link'));
    this.#db.prepare(`INSERT INTO links(id, source_id, target_id, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, link.sourceId, link.targetId, createdAt, createdAt, payload);
    return this.#linkFromRow(this.#db.prepare('SELECT * FROM links WHERE id = ?').get(id));
  }

  patchLink(id, input) {
    this.#requireUnlocked();
    const row = this.#linkRow(id);
    const existing = this.#linkFromRow(row);
    const link = normalizeLink(input, existing);
    if (link.sourceId !== existing.sourceId || link.targetId !== existing.targetId) {
      fail(400, 'VALIDATION_ERROR', 'Link endpoints cannot be changed.');
    }
    const updatedAt = now();
    const payload = encryptJson(this.#key, { type: link.type, label: link.label, notes: link.notes },
      objectAad('link', id, 1, 'link'));
    this.#db.prepare('UPDATE links SET updated_at = ?, payload = ? WHERE id = ?').run(updatedAt, payload, id);
    return this.#linkFromRow(this.#db.prepare('SELECT * FROM links WHERE id = ?').get(id));
  }

  deleteLink(id) {
    this.#requireUnlocked();
    this.#linkRow(id);
    this.#db.prepare('DELETE FROM links WHERE id = ?').run(id);
    return { deleted: true };
  }

  listImages(recordId) {
    this.#requireUnlocked();
    this.#experienceRow(recordId);
    return this.#db.prepare('SELECT * FROM record_images WHERE record_id = ? ORDER BY position, created_at, id')
      .all(recordId).map((row) => this.#imageFromRow(row));
  }

  createImage(recordId, { filename, mimeType, bytes }) {
    this.#requireUnlocked();
    this.#experienceRow(recordId);
    if (!Buffer.isBuffer(bytes)) fail(400, 'VALIDATION_ERROR', 'Image content must be binary.');
    validateImageMetadata({ filename, mimeType, byteLength: bytes.length });
    if (imageType(bytes) !== mimeType) fail(415, 'IMAGE_TYPE_MISMATCH', 'Image bytes do not match the declared Content-Type.');
    const count = this.#db.prepare('SELECT COUNT(*) AS count FROM record_images WHERE record_id = ?').get(recordId).count;
    if (count >= IMAGE_MAX_PER_EXPERIENCE) {
      fail(409, 'IMAGE_LIMIT_REACHED', `An experience can have at most ${IMAGE_MAX_PER_EXPERIENCE} images.`);
    }
    const id = randomUUID();
    const createdAt = now();
    const metadata = encryptJson(this.#key, { filename, mimeType, byteLength: bytes.length },
      objectAad('image-metadata', id, 1, recordId));
    const content = encryptBinary(this.#key, bytes, objectAad('image-content', id, 1, recordId));
    this.#db.prepare(`INSERT INTO record_images(id, record_id, position, created_at, metadata, content)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, recordId, count, createdAt, metadata, content);
    return this.#imageFromRow(this.#imageRow(id));
  }

  getImageContent(id) {
    this.#requireUnlocked();
    const row = this.#imageRow(id);
    const metadata = this.#imageFromRow(row);
    const bytes = decryptBinary(this.#key, row.content, objectAad('image-content', id, 1, row.record_id));
    if (bytes.length !== metadata.byteLength || imageType(bytes) !== metadata.mimeType) {
      bytes.fill(0);
      fail(422, 'DATA_INTEGRITY_ERROR', 'Encrypted image content does not match its authenticated metadata.');
    }
    return { metadata, bytes };
  }

  deleteImage(id) {
    this.#requireUnlocked();
    const row = this.#imageRow(id);
    transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM record_images WHERE id = ?').run(id);
      this.#db.prepare('UPDATE record_images SET position = position - 1 WHERE record_id = ? AND position > ?')
        .run(row.record_id, row.position);
    });
    return { deleted: true };
  }

  async export(passphrase) {
    this.#requireUnlocked();
    return createBackupEnvelope(passphrase, this.#exportSnapshot());
  }

  async exportV2(passphrase) {
    this.#requireUnlocked();
    const snapshot = this.#exportSnapshot();
    const rows = this.#db.prepare('SELECT * FROM record_images ORDER BY record_id, position, created_at, id').all();
    const images = rows.map((row) => this.#imageFromRow(row));
    const manifest = Buffer.from(JSON.stringify({
      format: 'eidolon-atlas-archive', version: 2, snapshot, images,
    }), 'utf8');
    if (manifest.length > BACKUP_V2_MAX_MANIFEST_BYTES) fail(413, 'BACKUP_TOO_LARGE', 'The backup manifest is too large.');
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(manifest.length);
    const plaintextLength = 4 + manifest.length + images.reduce((total, image) => total + image.byteLength, 0);
    const key = Buffer.from(this.#key);
    const plaintext = async function* () {
      try {
        yield prefix;
        yield manifest;
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          const bytes = decryptBinary(key, row.content, objectAad('image-content', row.id, 1, row.record_id));
          try {
            const metadata = images[index];
            if (bytes.length !== metadata.byteLength || imageType(bytes) !== metadata.mimeType) {
              fail(422, 'DATA_INTEGRITY_ERROR', 'Encrypted image content does not match its authenticated metadata.');
            }
            yield bytes;
          } finally {
            bytes.fill(0);
          }
        }
      } finally {
        key.fill(0);
      }
    };
    let result;
    try {
      result = await createBackupV2Stream(passphrase, plaintextLength, plaintext());
    } catch (error) {
      key.fill(0);
      throw error;
    }
    return {
      ...result,
      contentType: 'application/vnd.eidolon-atlas-backup',
      filename: `eidolon-atlas-${now().slice(0, 10)}.atlas`,
    };
  }

  async stageImportUpload(source, { maxBytes = BACKUP_UPLOAD_MAX_BYTES } = {}) {
    this.#requireUnlocked();
    const id = randomUUID();
    const path = this.#uploadPath(id);
    const handle = await open(path, 'wx', 0o600);
    let byteLength = 0;
    try {
      for await (const value of source) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        byteLength += chunk.length;
        if (byteLength > maxBytes) fail(413, 'REQUEST_TOO_LARGE', `Backup upload exceeds the ${maxBytes}-byte limit.`);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new Error('Backup staging write made no progress.');
          offset += bytesWritten;
        }
      }
      if (byteLength === 0) fail(400, 'INVALID_BACKUP', 'The backup upload is empty.');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(path, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    this.#uploads.set(id, byteLength);
    return { uploadId: id, byteLength };
  }

  async cancelImportUpload(id) {
    this.#requireUnlocked();
    this.#requireUpload(id);
    this.#uploads.delete(id);
    await rm(this.#uploadPath(id), { force: true });
    return { deleted: true };
  }

  async commitImportUpload(id, passphrase) {
    this.#requireUnlocked();
    this.#requireUpload(id);
    const path = this.#uploadPath(id);
    const stagedImages = [];
    try {
      const { prepared, images } = await this.#openV2Upload(path, passphrase, stagedImages);
      this.#replaceSnapshot(prepared, images);
      return { imported: true, records: prepared.records.length, images: images.length };
    } finally {
      this.#uploads.delete(id);
      await rm(path, { force: true }).catch(() => {});
      await Promise.all(stagedImages.map((image) => rm(image.path, { force: true }).catch(() => {})));
    }
  }

  async import(passphrase, envelope) {
    this.#requireUnlocked();
    const snapshot = await openBackupEnvelope(passphrase, envelope);
    const prepared = this.#validateSnapshot(snapshot);
    this.#replaceSnapshot(prepared, []);
    return { imported: true, records: prepared.records.length };
  }

  #replaceSnapshot(prepared, images) {
    this.#requireUnlocked();
    transaction(this.#db, () => {
      this.#db.exec('DELETE FROM record_images; DELETE FROM links; DELETE FROM record_revisions; DELETE FROM records; DELETE FROM custom_fields;');
      for (const field of prepared.customFields) {
        this.#db.prepare(`INSERT INTO custom_fields(id, category, type, created_at, updated_at, payload, archived)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(field.id, field.category, field.type, field.createdAt, field.updatedAt,
          encryptJson(this.#key, { name: field.name, options: field.options }, objectAad('custom-field', field.id, 1, field.category)),
          field.archived ? 1 : 0);
      }
      for (const record of prepared.records) {
        const snapshotValue = this.#snapshotFromRecord(record);
        this.#db.prepare(`INSERT INTO records
          (id, category, revision, trashed, parent_id, position, created_at, updated_at, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.category, record.revision,
          record.trashed ? 1 : 0, record.parentId, record.position, record.createdAt, record.updatedAt,
          this.#encryptRecord(record.id, record.revision, record.category, snapshotValue));
      }
      for (const revision of prepared.revisions) {
        this.#insertRevision(revision.recordId, revision.revision, revision.category, revision.createdAt, revision.snapshot);
      }
      for (const link of prepared.links) {
        this.#db.prepare(`INSERT INTO links(id, source_id, target_id, created_at, updated_at, payload)
          VALUES (?, ?, ?, ?, ?, ?)`).run(link.id, link.sourceId, link.targetId, link.createdAt, link.updatedAt,
          encryptJson(this.#key, { type: link.type, label: link.label, notes: link.notes }, objectAad('link', link.id, 1, 'link')));
      }
      for (const image of images) {
        const content = readFileSync(image.path);
        try {
          this.#db.prepare(`INSERT INTO record_images(id, record_id, position, created_at, metadata, content)
            VALUES (?, ?, ?, ?, ?, ?)`).run(image.id, image.recordId, image.position, image.createdAt,
            encryptJson(this.#key, { filename: image.filename, mimeType: image.mimeType, byteLength: image.byteLength },
              objectAad('image-metadata', image.id, 1, image.recordId)), content);
        } finally {
          content.fill(0);
        }
      }
    });
  }

  #exportSnapshot() {
    const records = this.#db.prepare('SELECT * FROM records ORDER BY created_at, id').all().map((row) => this.#recordFromRow(row));
    const revisions = this.#db.prepare('SELECT * FROM record_revisions ORDER BY record_id, revision').all().map((row) => ({
      recordId: row.record_id,
      revision: row.revision,
      category: row.category,
      createdAt: row.created_at,
      snapshot: decryptJson(this.#key, row.payload, objectAad('revision', row.record_id, row.revision, row.category)),
    }));
    return {
      format: 'eidolon-atlas-snapshot', version: 1, exportedAt: now(),
      records: records.map(({ links, backlinks, ...record }) => record),
      revisions,
      customFields: this.listCustomFields(),
      links: this.#db.prepare('SELECT * FROM links ORDER BY created_at, id').all().map((row) => this.#linkFromRow(row)),
    };
  }

  async #openV2Upload(path, passphrase, stagedImages) {
    const handle = await open(path, 'r');
    let size;
    let prefix;
    let tag;
    try {
      size = (await handle.stat()).size;
      const preludeLength = BACKUP_V2_MAGIC.length + 4;
      if (size < preludeLength + 2 + 16) fail(400, 'INVALID_BACKUP', 'The v2 backup is truncated.');
      const prelude = Buffer.alloc(preludeLength);
      if ((await handle.read(prelude, 0, prelude.length, 0)).bytesRead !== prelude.length ||
          !prelude.subarray(0, BACKUP_V2_MAGIC.length).equals(BACKUP_V2_MAGIC)) {
        fail(400, 'INVALID_BACKUP', 'The backup is not a supported v2 container.');
      }
      const headerLength = prelude.readUInt32BE(BACKUP_V2_MAGIC.length);
      if (headerLength < 2 || headerLength > BACKUP_V2_MAX_HEADER_BYTES || size < preludeLength + headerLength + 16 + 4) {
        fail(400, 'INVALID_BACKUP', 'The v2 backup header is invalid or the backup is truncated.');
      }
      prefix = Buffer.alloc(preludeLength + headerLength);
      prelude.copy(prefix);
      if ((await handle.read(prefix, preludeLength, headerLength, preludeLength)).bytesRead !== headerLength) {
        fail(400, 'INVALID_BACKUP', 'The v2 backup header is truncated.');
      }
      tag = Buffer.alloc(16);
      if ((await handle.read(tag, 0, 16, size - 16)).bytesRead !== 16) fail(400, 'INVALID_BACKUP', 'The v2 backup tag is truncated.');
    } finally {
      await handle.close();
    }

    const { decipher, key, tagBytes } = await createBackupV2Decipher(passphrase, prefix);
    decipher.setAuthTag(tag);
    const localKey = Buffer.from(this.#key);
    let prepared;
    let images;
    let lengthBytes = Buffer.alloc(4);
    let lengthSeen = 0;
    let manifestLength;
    let manifestSeen = 0;
    let manifestChunks = [];
    let imageIndex = 0;
    let imageSeen = 0;
    let imageChunks = [];
    let parseError;

    const finishImage = async () => {
      const metadata = images[imageIndex];
      const bytes = Buffer.concat(imageChunks, imageSeen);
      imageChunks = [];
      imageSeen = 0;
      try {
        if (bytes.length !== metadata.byteLength || imageType(bytes) !== metadata.mimeType) {
          fail(400, 'INVALID_BACKUP', 'Backup image bytes do not match their authenticated metadata.');
        }
        const encrypted = encryptBinary(localKey, bytes,
          objectAad('image-content', metadata.id, 1, metadata.recordId));
        const imagePath = join(this.#stagingDir, `image-${randomUUID()}.encrypted`);
        try {
          await writeFile(imagePath, encrypted, { flag: 'wx', mode: 0o600 });
          stagedImages.push({ ...metadata, path: imagePath });
        } finally {
          encrypted.fill(0);
        }
      } finally {
        bytes.fill(0);
      }
      imageIndex += 1;
    };

    const consume = async (plaintext) => {
      let offset = 0;
      while (offset < plaintext.length) {
        if (lengthSeen < 4) {
          const take = Math.min(4 - lengthSeen, plaintext.length - offset);
          plaintext.copy(lengthBytes, lengthSeen, offset, offset + take);
          lengthSeen += take;
          offset += take;
          if (lengthSeen === 4) {
            manifestLength = lengthBytes.readUInt32BE(0);
            if (manifestLength < 2 || manifestLength > BACKUP_V2_MAX_MANIFEST_BYTES) {
              fail(400, 'INVALID_BACKUP', 'The v2 backup manifest length is invalid.');
            }
          }
          continue;
        }
        if (manifestSeen < manifestLength) {
          const take = Math.min(manifestLength - manifestSeen, plaintext.length - offset);
          manifestChunks.push(Buffer.from(plaintext.subarray(offset, offset + take)));
          manifestSeen += take;
          offset += take;
          if (manifestSeen === manifestLength) {
            const manifestBytes = Buffer.concat(manifestChunks, manifestLength);
            manifestChunks = [];
            let manifest;
            try {
              manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
            } catch {
              fail(400, 'INVALID_BACKUP', 'The v2 backup manifest is invalid.');
            } finally {
              manifestBytes.fill(0);
            }
            ({ prepared, images } = this.#validateV2Manifest(manifest));
          }
          continue;
        }
        if (imageIndex >= images.length) fail(400, 'INVALID_BACKUP', 'The v2 backup contains trailing plaintext.');
        const remaining = images[imageIndex].byteLength - imageSeen;
        const take = Math.min(remaining, plaintext.length - offset);
        imageChunks.push(Buffer.from(plaintext.subarray(offset, offset + take)));
        imageSeen += take;
        offset += take;
        if (imageSeen === images[imageIndex].byteLength) await finishImage();
      }
    };

    try {
      const ciphertextEnd = size - tagBytes - 1;
      for await (const chunk of createReadStream(path, { start: prefix.length, end: ciphertextEnd })) {
        const plaintext = decipher.update(chunk);
        try {
          if (!parseError) await consume(plaintext);
        } catch (error) {
          parseError = error;
        } finally {
          plaintext.fill(0);
        }
      }
      let final;
      try {
        final = decipher.final();
      } catch {
        fail(401, 'INVALID_BACKUP_PASSPHRASE', 'The backup passphrase is incorrect or the backup was modified.');
      }
      try {
        if (!parseError) await consume(final);
      } catch (error) {
        parseError = error;
      } finally {
        final.fill(0);
      }
      if (parseError) throw parseError;
      if (!prepared || imageIndex !== images.length || imageSeen !== 0) {
        fail(400, 'INVALID_BACKUP', 'The v2 backup archive is truncated.');
      }
      return { prepared, images: stagedImages };
    } finally {
      key.fill(0);
      localKey.fill(0);
      lengthBytes.fill(0);
      for (const chunk of manifestChunks) chunk.fill(0);
      for (const chunk of imageChunks) chunk.fill(0);
    }
  }

  #validateV2Manifest(manifest) {
    if (!manifest || manifest.format !== 'eidolon-atlas-archive' || manifest.version !== 2 || !Array.isArray(manifest.images)) {
      fail(400, 'INVALID_BACKUP', 'The v2 backup manifest is invalid or unsupported.');
    }
    const prepared = this.#validateSnapshot(manifest.snapshot);
    const records = new Map(prepared.records.map((record) => [record.id, record]));
    const ids = new Set();
    const groups = new Map();
    const images = manifest.images.map((image) => {
      if (!image || typeof image.id !== 'string' || image.id === '' || ids.has(image.id) ||
          typeof image.recordId !== 'string' || typeof image.createdAt !== 'string') {
        fail(400, 'INVALID_BACKUP', 'An image has invalid structural metadata.');
      }
      ids.add(image.id);
      const record = records.get(image.recordId);
      if (!record || record.category !== 'experience') fail(400, 'INVALID_BACKUP', 'An image must belong to an Experience record.');
      validateImageMetadata(image, { backup: true });
      const position = integerPosition(image.position);
      if (position === undefined) fail(400, 'INVALID_BACKUP', 'An image position is invalid.');
      if (!groups.has(image.recordId)) groups.set(image.recordId, []);
      groups.get(image.recordId).push(position);
      return { id: image.id, recordId: image.recordId, position, createdAt: image.createdAt,
        filename: image.filename, mimeType: image.mimeType, byteLength: image.byteLength };
    });
    for (const positions of groups.values()) {
      positions.sort((left, right) => left - right);
      if (positions.length > IMAGE_MAX_PER_EXPERIENCE || positions.some((position, index) => position !== index)) {
        fail(400, 'INVALID_BACKUP', 'Experience images must have unique contiguous positions within the image limit.');
      }
    }
    return { prepared, images };
  }

  #validateSnapshot(snapshot) {
    if (!snapshot || snapshot.format !== 'eidolon-atlas-snapshot' || snapshot.version !== 1 ||
      !Array.isArray(snapshot.records) || !Array.isArray(snapshot.revisions) ||
      !Array.isArray(snapshot.customFields) || !Array.isArray(snapshot.links)) {
      fail(400, 'INVALID_BACKUP', 'The decrypted backup snapshot is invalid.');
    }
    const identifiers = (items, label, field = 'id') => {
      const values = new Set();
      for (const item of items) {
        if (!item || typeof item[field] !== 'string' || !item[field]) fail(400, 'INVALID_BACKUP', `${label} has an invalid identifier.`);
        if (values.has(item[field])) fail(400, 'INVALID_BACKUP', `${label} contains duplicate identifiers.`);
        values.add(item[field]);
      }
      return values;
    };
    const recordIds = identifiers(snapshot.records, 'records');
    const fieldIds = identifiers(snapshot.customFields, 'custom fields');
    const linkIds = identifiers(snapshot.links, 'links');
    void fieldIds; void linkIds;
    let people = 0;
    const records = snapshot.records.map((record) => {
      const content = normalizeRecord(record);
      if (content.category === 'person') people += 1;
      requireRevision(record.revision);
      if (typeof record.trashed !== 'boolean' || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
        fail(400, 'INVALID_BACKUP', 'A record has invalid structural metadata.');
      }
      const parentId = record.parentId ?? null;
      const position = integerPosition(record.position) ?? 0;
      if (content.category !== 'goal' && parentId !== null) fail(400, 'INVALID_BACKUP', 'Only goals may have parents.');
      return { id: record.id, ...content, parentId, position, revision: record.revision,
        trashed: record.trashed, createdAt: record.createdAt, updatedAt: record.updatedAt };
    });
    if (people > 1) fail(400, 'INVALID_BACKUP', 'The backup contains more than one person profile.');
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const record of records) {
      if (record.parentId) {
        const parent = byId.get(record.parentId);
        if (!parent || parent.category !== 'goal') fail(400, 'INVALID_BACKUP', 'A goal parent is invalid.');
        if (!record.trashed && parent.trashed) fail(400, 'INVALID_BACKUP', 'An active goal cannot have a trashed parent.');
        const seen = new Set([record.id]);
        let cursor = parent;
        while (cursor) {
          if (seen.has(cursor.id)) fail(400, 'INVALID_BACKUP', 'The goal hierarchy contains a cycle.');
          seen.add(cursor.id);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
        }
      }
      for (const fieldId of Object.keys(record.customFieldValues)) {
        if (!fieldIds.has(fieldId)) fail(400, 'INVALID_BACKUP', 'A record references a missing custom field.');
      }
    }
    const customFields = snapshot.customFields.map((field) => {
      const normalized = normalizeCustomField(field);
      if (typeof field.createdAt !== 'string' || typeof field.updatedAt !== 'string') fail(400, 'INVALID_BACKUP', 'A custom field has invalid timestamps.');
      if (field.archived !== undefined && typeof field.archived !== 'boolean') fail(400, 'INVALID_BACKUP', 'A custom field has invalid archived state.');
      return { id: field.id, ...normalized, archived: Boolean(field.archived),
        createdAt: field.createdAt, updatedAt: field.updatedAt };
    });
    const fieldNames = new Set();
    for (const field of customFields) {
      const key = `${field.category}:${field.name.normalize('NFKC').toLocaleLowerCase()}`;
      if (fieldNames.has(key)) fail(400, 'INVALID_BACKUP', 'Custom field names must be unique within a category.');
      fieldNames.add(key);
    }
    const fieldMap = new Map(customFields.map((field) => [field.id, field]));
    for (const record of records) {
      for (const [fieldId, value] of Object.entries(record.customFieldValues)) {
        const definition = fieldMap.get(fieldId);
        if (definition.category !== record.category) fail(400, 'INVALID_BACKUP', 'A custom field is used by the wrong category.');
        validateCustomFieldValue(definition, value);
      }
    }
    const revisions = snapshot.revisions.map((revision) => {
      if (!recordIds.has(revision.recordId) || !CATEGORIES.includes(revision.category)) fail(400, 'INVALID_BACKUP', 'A revision references an invalid record.');
      if (byId.get(revision.recordId).category !== revision.category) fail(400, 'INVALID_BACKUP', 'A revision category does not match its record.');
      requireRevision(revision.revision);
      if (typeof revision.createdAt !== 'string' || !revision.snapshot) fail(400, 'INVALID_BACKUP', 'A revision is invalid.');
      const normalized = normalizeRecord(revision.snapshot);
      if (normalized.category !== revision.category) fail(400, 'INVALID_BACKUP', 'A revision category does not match.');
      if (typeof revision.snapshot.trashed !== 'boolean') fail(400, 'INVALID_BACKUP', 'A revision has invalid trash state.');
      const parentId = revision.snapshot.parentId ?? null;
      if (normalized.category !== 'goal' && parentId !== null) fail(400, 'INVALID_BACKUP', 'Only goal revisions may have parents.');
      if (parentId !== null && (!byId.has(parentId) || byId.get(parentId).category !== 'goal')) {
        fail(400, 'INVALID_BACKUP', 'A goal revision has an invalid parent.');
      }
      return { ...revision, snapshot: { ...normalized, parentId: revision.snapshot.parentId ?? null,
        position: integerPosition(revision.snapshot.position) ?? 0, trashed: Boolean(revision.snapshot.trashed) } };
    });
    const revisionKeys = new Set();
    for (const revision of revisions) {
      const key = `${revision.recordId}:${revision.revision}`;
      if (revisionKeys.has(key)) fail(400, 'INVALID_BACKUP', 'The backup contains duplicate revisions.');
      revisionKeys.add(key);
    }
    for (const record of records) {
      if (!revisionKeys.has(`${record.id}:${record.revision}`)) fail(400, 'INVALID_BACKUP', 'A current record revision is missing from history.');
      const currentRevision = revisions.find((revision) => revision.recordId === record.id && revision.revision === record.revision);
      if (canonicalJson(currentRevision.snapshot) !== canonicalJson(this.#snapshotFromRecord(record))) {
        fail(400, 'INVALID_BACKUP', 'A current record does not match its current revision.');
      }
      const recordRevisions = revisions.filter((revision) => revision.recordId === record.id)
        .map((revision) => revision.revision).sort((left, right) => left - right);
      if (recordRevisions.length !== record.revision ||
          recordRevisions.some((value, index) => value !== index + 1)) {
        fail(400, 'INVALID_BACKUP', 'Record revision history must be complete and contiguous.');
      }
    }
    const goalGroups = new Map();
    for (const record of records.filter((item) => item.category === 'goal' && !item.trashed)) {
      const group = record.parentId ?? '<root>';
      if (!goalGroups.has(group)) goalGroups.set(group, []);
      goalGroups.get(group).push(record.position);
    }
    for (const positions of goalGroups.values()) {
      positions.sort((left, right) => left - right);
      if (positions.some((position, index) => position !== index)) {
        fail(400, 'INVALID_BACKUP', 'Active sibling goals must have contiguous unique positions.');
      }
    }
    const links = snapshot.links.map((link) => {
      const normalized = normalizeLink(link);
      if (!recordIds.has(normalized.sourceId) || !recordIds.has(normalized.targetId)) fail(400, 'INVALID_BACKUP', 'A link endpoint is missing.');
      if (typeof link.createdAt !== 'string' || typeof link.updatedAt !== 'string') fail(400, 'INVALID_BACKUP', 'A link has invalid timestamps.');
      return { id: link.id, ...normalized, createdAt: link.createdAt, updatedAt: link.updatedAt };
    });
    const linkEndpoints = new Set();
    for (const link of links) {
      const key = `${link.sourceId}:${link.targetId}`;
      if (linkEndpoints.has(key)) fail(400, 'INVALID_BACKUP', 'The backup contains duplicate links.');
      linkEndpoints.add(key);
    }
    const depths = new Map();
    for (const record of records) {
      const path = [];
      let cursor = record;
      while (cursor && !depths.has(cursor.id)) {
        path.push(cursor);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
      }
      let depth = cursor ? depths.get(cursor.id) : -1;
      while (path.length) {
        const item = path.pop();
        depth += 1;
        depths.set(item.id, depth);
      }
    }
    records.sort((left, right) => depths.get(left.id) - depths.get(right.id));
    return { records, revisions, customFields, links };
  }

  #changeTrash(existing, trashed) {
    const revision = existing.revision + 1;
    const updatedAt = now();
    let position = existing.position;
    if (!trashed && existing.category === 'goal') {
      position = this.#insertPosition(existing.parentId, existing.position, existing.id);
    }
    const snapshot = this.#snapshotFromRecord({ ...existing, position, trashed });
    transaction(this.#db, () => {
      if (existing.category === 'goal') {
        if (trashed) this.#removePosition(existing.parentId, existing.position, existing.id);
        else this.#shiftPositions(existing.parentId, position, 1, existing.id);
      }
      this.#db.prepare('UPDATE records SET revision = ?, trashed = ?, position = ?, updated_at = ?, payload = ? WHERE id = ? AND revision = ?')
        .run(revision, trashed ? 1 : 0, position, updatedAt,
          this.#encryptRecord(existing.id, revision, existing.category, snapshot), existing.id, existing.revision);
      this.#insertRevision(existing.id, revision, existing.category, updatedAt, snapshot);
    });
    return this.getRecord(existing.id);
  }

  #snapshotFromRecord(record) {
    return { category: record.category, title: record.title, data: record.data,
      customFieldValues: record.customFieldValues, parentId: record.parentId ?? null,
      position: record.position ?? 0, trashed: Boolean(record.trashed) };
  }

  #migrateRelationshipKinds() {
    for (const record of this.listRecords({ category: 'relationship', trashed: 'all' })) {
      if (record.data?.kind !== 'person') continue;
      this.patchRecord(record.id, {
        revision: record.revision,
        data: { ...record.data, kind: 'family' },
      });
    }
  }

  #encryptRecord(id, revision, category, snapshot) {
    const content = { title: snapshot.title, data: snapshot.data, customFieldValues: snapshot.customFieldValues };
    return encryptJson(this.#key, content, objectAad('record', id, revision, category));
  }

  #insertRevision(id, revision, category, createdAt, snapshot) {
    this.#db.prepare(`INSERT INTO record_revisions(record_id, revision, category, created_at, payload)
      VALUES (?, ?, ?, ?, ?)`).run(id, revision, category, createdAt,
      encryptJson(this.#key, snapshot, objectAad('revision', id, revision, category)));
  }

  #recordFromRow(row) {
    const value = decryptJson(this.#key, row.payload, objectAad('record', row.id, row.revision, row.category));
    return { id: row.id, category: row.category, title: value.title, data: value.data,
      customFieldValues: value.customFieldValues ?? {}, parentId: row.parent_id, position: row.position,
      revision: row.revision, trashed: Boolean(row.trashed), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #recordRow(id) {
    const row = this.#db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    if (!row) fail(404, 'RECORD_NOT_FOUND', 'Record not found.');
    return row;
  }

  #experienceRow(id) {
    const row = this.#recordRow(id);
    if (row.category !== 'experience') fail(400, 'IMAGES_REQUIRE_EXPERIENCE', 'Images can only be attached to Experience records.');
    return row;
  }

  #imageRow(id) {
    const row = this.#db.prepare('SELECT * FROM record_images WHERE id = ?').get(id);
    if (!row) fail(404, 'IMAGE_NOT_FOUND', 'Image not found.');
    return row;
  }

  #imageFromRow(row) {
    const value = decryptJson(this.#key, row.metadata,
      objectAad('image-metadata', row.id, 1, row.record_id));
    validateImageMetadata(value);
    return { id: row.id, recordId: row.record_id, position: row.position, createdAt: row.created_at,
      filename: value.filename, mimeType: value.mimeType, byteLength: value.byteLength };
  }

  #uploadPath(id) {
    return join(this.#stagingDir, `${id}.upload`);
  }

  #requireUpload(id) {
    if (typeof id !== 'string' || !UPLOAD_ID.test(id) || !this.#uploads.has(id)) {
      fail(404, 'IMPORT_UPLOAD_NOT_FOUND', 'Import upload not found.');
    }
  }

  #validateCustomValues(category, values, { existingValues = {} } = {}) {
    const fields = new Map(this.listCustomFields().map((field) => [field.id, field]));
    for (const [id, value] of Object.entries(values)) {
      const field = fields.get(id);
      if (!field) fail(400, 'VALIDATION_ERROR', `Unknown custom field: ${id}.`);
      if (field.category !== category) fail(400, 'VALIDATION_ERROR', 'Custom field category does not match the record.');
      if (field.archived && (!Object.hasOwn(existingValues, id) ||
          canonicalJson(existingValues[id]) !== canonicalJson(value))) {
        fail(409, 'CUSTOM_FIELD_ARCHIVED', `Archived custom field ${field.name} cannot receive new values.`);
      }
      validateCustomFieldValue(field, value);
    }
  }

  #validateGoalParent(id, parentId) {
    if (parentId === undefined || parentId === null || parentId === '') return;
    if (typeof parentId !== 'string') fail(400, 'VALIDATION_ERROR', 'parentId must be a goal ID or null.');
    let cursor = parentId;
    const seen = new Set([id]);
    while (cursor) {
      if (seen.has(cursor)) fail(409, 'GOAL_CYCLE', 'The goal hierarchy cannot contain a cycle.');
      seen.add(cursor);
      const row = this.#db.prepare('SELECT category, parent_id, trashed FROM records WHERE id = ?').get(cursor);
      if (!row || row.category !== 'goal') fail(400, 'INVALID_GOAL_PARENT', 'parentId must identify an existing goal.');
      if (row.trashed) fail(409, 'GOAL_PARENT_TRASHED', 'A goal cannot be placed under a trashed goal.');
      cursor = row.parent_id;
    }
  }

  #insertPosition(parentId, requested, excludeId = undefined) {
    const condition = parentId === null ? 'parent_id IS NULL' : 'parent_id = ?';
    const args = parentId === null ? [] : [parentId];
    const rows = this.#db.prepare(`SELECT id FROM records WHERE category = 'goal' AND trashed = 0 AND ${condition} ORDER BY position`)
      .all(...args).filter((row) => row.id !== excludeId);
    return requested === undefined ? rows.length : Math.min(requested, rows.length);
  }

  #shiftPositions(parentId, from, delta, excludeId = undefined) {
    const rows = this.#db.prepare("SELECT id, position FROM records WHERE category = 'goal' AND trashed = 0 AND ((parent_id = ?) OR (parent_id IS NULL AND ? IS NULL)) ORDER BY position DESC")
      .all(parentId, parentId);
    const update = this.#db.prepare('UPDATE records SET position = ? WHERE id = ?');
    for (const row of rows) if (row.id !== excludeId && row.position >= from) update.run(row.position + delta, row.id);
  }

  #removePosition(parentId, position, excludeId) {
    const rows = this.#db.prepare("SELECT id, position FROM records WHERE category = 'goal' AND trashed = 0 AND ((parent_id = ?) OR (parent_id IS NULL AND ? IS NULL)) AND position > ? ORDER BY position")
      .all(parentId, parentId, position);
    const update = this.#db.prepare('UPDATE records SET position = ? WHERE id = ?');
    for (const row of rows) if (row.id !== excludeId) update.run(row.position - 1, row.id);
  }

  #customFieldRow(id) {
    const row = this.#db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(id);
    if (!row) fail(404, 'CUSTOM_FIELD_NOT_FOUND', 'Custom field not found.');
    return row;
  }

  #customFieldFromRow(row) {
    const value = decryptJson(this.#key, row.payload, objectAad('custom-field', row.id, 1, row.category));
    return { id: row.id, category: row.category, name: value.name, type: row.type,
      options: value.options ?? [], archived: Boolean(row.archived),
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #linkRow(id) {
    const row = this.#db.prepare('SELECT * FROM links WHERE id = ?').get(id);
    if (!row) fail(404, 'LINK_NOT_FOUND', 'Link not found.');
    return row;
  }

  #linkFromRow(row) {
    const value = decryptJson(this.#key, row.payload, objectAad('link', row.id, 1, 'link'));
    return { id: row.id, sourceId: row.source_id, targetId: row.target_id,
      type: value.type, label: value.label, notes: value.notes,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #linksFor(id, outgoing) {
    const column = outgoing ? 'source_id' : 'target_id';
    return this.#db.prepare(`SELECT * FROM links WHERE ${column} = ? ORDER BY created_at`).all(id)
      .map((row) => this.#linkFromRow(row));
  }

  #meta(key) {
    const row = this.#db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { fail(500, 'INVALID_METADATA', 'Stored application metadata is invalid.'); }
  }

  #setMeta(key, value) {
    this.#db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  #replaceKey(key) {
    if (this.#key) this.#key.fill(0);
    this.#key = key;
  }

  #requireUnlocked() {
    if (!this.#meta(KEY_CONFIG)) fail(409, 'NOT_INITIALIZED', 'Atlas must be set up first.');
    if (!this.#key) fail(423, 'LOCKED', 'Atlas is locked.');
  }

  #revisionConflict(currentRevision) {
    fail(409, 'REVISION_CONFLICT', 'The record was changed by another request.', { currentRevision });
  }
}
