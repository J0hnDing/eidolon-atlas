import { closeSync, createReadStream, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase, transaction } from './database.js';
import {
  BACKUP_V2_MAGIC, BACKUP_V3_MAGIC, BACKUP_V2_MAX_HEADER_BYTES, BACKUP_V2_MAX_MANIFEST_BYTES, DEFAULT_KDF, createBackupEnvelope,
  createBackupV2Decipher, createBackupV2Stream, createBackupV3Decipher, createBackupV3Stream, decryptBinary, decryptJson, deriveKey,
  encryptBinary, encryptJson, makeKeyCheck, objectAad, openBackupEnvelope, verifyKeyCheck,
} from './crypto.js';
import {
  CATEGORIES, canonicalJson, normalizeCustomField, normalizeLink, normalizeRecord,
  requireObject, requireRevision, validateCustomFieldValue,
} from './domain.js';
import { AtlasError, fail } from './errors.js';
import {
  KNOWLEDGE_BRANCHES, KNOWLEDGE_SEED_KEY, createInitialKnowledgeSnapshot, knowledgeId,
  normalizeKnowledgeBranch, normalizeKnowledgeContent, normalizeKnowledgeName, validateKnowledgeSnapshot,
} from './knowledge.js';

const KEY_CONFIG = 'encryption-config';
const KEY_CHECK = 'key-check';
const LEGACY_AGENT_KEY = 'agent-key';
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_PER_EXPERIENCE = 50;
export const BACKUP_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARCHIVE_FRAME_MAX_BYTES = BACKUP_V2_MAX_MANIFEST_BYTES;

function now() { return new Date().toISOString(); }
function processIsActive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function acquireDatabaseLease(databasePath) {
  if (databasePath === ':memory:') return null;
  const path = `${resolve(databasePath)}.atlas.lock`;
  mkdirSync(resolve(path, '..'), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    let descriptor;
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: now() }), 'utf8');
      return { descriptor, path, token };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== 'EEXIST') throw error;
      let holder;
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        fail(409, 'ATLAS_INSTANCE_ACTIVE', 'This atlas database is already owned by another process.');
      }
      if (processIsActive(holder?.pid)) {
        fail(409, 'ATLAS_INSTANCE_ACTIVE', 'This atlas database is already owned by another process.', { pid: holder.pid });
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  fail(409, 'ATLAS_INSTANCE_ACTIVE', 'This atlas database is already owned by another process.');
}

function releaseDatabaseLease(lease) {
  if (!lease) return;
  try { closeSync(lease.descriptor); } catch { /* best effort close */ }
  try {
    const holder = JSON.parse(readFileSync(lease.path, 'utf8'));
    if (holder?.token === lease.token) unlinkSync(lease.path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function archiveFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length < 2 || body.length > ARCHIVE_FRAME_MAX_BYTES) {
    body.fill(0);
    fail(413, 'BACKUP_ENTRY_TOO_LARGE', 'An individual backup entry is too large.');
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

function rejectUnexpectedFields(input, allowed) {
  const fields = Object.keys(input).filter((field) => !allowed.has(field));
  if (fields.length) fail(400, 'UNEXPECTED_FIELD', 'The request contains unsupported fields.', { fields });
}
function integerPosition(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) fail(400, 'VALIDATION_ERROR', 'position must be a non-negative integer.');
  return value;
}

function goalDataWithoutLegacyText(data) {
  const hasLegacyText = Object.hasOwn(data ?? {}, 'progressNote') || Object.hasOwn(data ?? {}, 'motivation');
  const hasImportance = Object.hasOwn(data ?? {}, 'importance');
  if (!hasLegacyText && hasImportance) return data;
  const next = { ...(data ?? {}) };
  if (hasLegacyText) {
    const descriptions = [next.description, next.motivation, next.progressNote]
      .filter((value) => typeof value === 'string' && value.trim())
      .filter((value, index, values) => values.indexOf(value) === index);
    next.description = descriptions.join('\n\n');
    delete next.progressNote;
    delete next.motivation;
  }
  if (!hasImportance) next.importance = 'medium';
  return next;
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
  #lease;
  #lifecycleGeneration = 0;
  #lifecycleTail = Promise.resolve();
  #transientKeys = new Set();

  constructor({ databasePath = 'data/atlas.sqlite' } = {}) {
    this.#lease = acquireDatabaseLease(databasePath);
    try {
      this.#db = openDatabase(databasePath);
      this.#db.prepare('DELETE FROM metadata WHERE key = ?').run(LEGACY_AGENT_KEY);
      this.#stagingDir = databasePath === ':memory:'
        ? join(tmpdir(), `eidolon-atlas-imports-${randomUUID()}`)
        : `${resolve(databasePath)}.imports`;
      rmSync(this.#stagingDir, { recursive: true, force: true });
      mkdirSync(this.#stagingDir, { recursive: true });
    } catch (error) {
      releaseDatabaseLease(this.#lease);
      throw error;
    }
  }

  close() {
    if (this.#closed) return;
    try {
      this.lock();
      this.#db.close();
    } finally {
      rmSync(this.#stagingDir, { recursive: true, force: true });
      releaseDatabaseLease(this.#lease);
      this.#closed = true;
    }
  }

  get database() { return this.#db; }

  status() {
    const initialized = Boolean(this.#meta(KEY_CONFIG));
    return { initialized, locked: this.#key === null };
  }

  async setup(passphrase) {
    return this.#withLifecycle(async (generation) => {
      if (this.#meta(KEY_CONFIG)) fail(409, 'ALREADY_INITIALIZED', 'Atlas has already been set up.');
      const salt = randomBytes(16);
      const parameters = { ...DEFAULT_KDF };
      const key = await deriveKey(passphrase, salt, parameters);
      const config = { ...parameters, salt: salt.toString('base64') };
      const check = makeKeyCheck(key);
      try {
        this.#assertLifecycle(generation);
        transaction(this.#db, () => {
          if (this.#meta(KEY_CONFIG)) fail(409, 'ALREADY_INITIALIZED', 'Atlas has already been set up.');
          this.#setMeta(KEY_CONFIG, config);
          this.#setMeta(KEY_CHECK, check);
        });
        this.#advanceLifecycle(generation);
        this.#replaceKey(key);
        this.#seedKnowledge();
        return this.status();
      } catch (error) {
        key.fill(0);
        throw error;
      }
    });
  }

  async unlock(passphrase) {
    return this.#withLifecycle(async (generation) => {
      const key = await this.#deriveConfiguredKey(passphrase, generation);
      this.#advanceLifecycle(generation);
      this.#replaceKey(key);
      this.#migrateRelationshipKinds();
      this.#migrateGoalData();
      this.#seedKnowledge();
      return this.status();
    });
  }

  lock() {
    this.#lifecycleGeneration += 1;
    this.#lockState();
    return this.status();
  }

  async clearAll(passphrase) {
    return this.#withLifecycle(async (generation) => {
      this.#requireUnlocked();
      const key = await this.#deriveConfiguredKey(passphrase, generation);
      key.fill(0);
      this.#assertLifecycle(generation);

      rmSync(this.#stagingDir, { recursive: true, force: true });
      mkdirSync(this.#stagingDir, { recursive: true });
      this.#uploads.clear();

      transaction(this.#db, () => {
        this.#db.exec(`
          DELETE FROM record_images;
          DELETE FROM goal_dependencies;
          DELETE FROM links;
          DELETE FROM record_revisions;
          DELETE FROM records;
          DELETE FROM custom_fields;
          DELETE FROM knowledge_connections;
          DELETE FROM knowledge_metadata;
        `);
        const deleteKnowledgeLeaves = this.#db.prepare(`DELETE FROM knowledge_nodes
          WHERE NOT EXISTS (SELECT 1 FROM knowledge_nodes child WHERE child.parent_id = knowledge_nodes.id)`);
        while (this.#db.prepare('SELECT 1 FROM knowledge_nodes LIMIT 1').get()) {
          if (!deleteKnowledgeLeaves.run().changes) fail(500, 'KNOWLEDGE_INTEGRITY_ERROR', 'Stored knowledge hierarchy could not be cleared.');
        }
        this.#db.exec('DELETE FROM metadata;');
      });

      this.#advanceLifecycle(generation);
      this.#lockState();
      return this.status();
    });
  }

  listKnowledgeNodes() {
    this.#requireUnlocked();
    return this.#db.prepare('SELECT * FROM knowledge_nodes').all()
      .map((row) => this.#knowledgeNodeFromRow(row))
      .sort((left, right) => left.name.localeCompare(right.name, 'en-US', { sensitivity: 'base' }) || left.id - right.id);
  }

  getKnowledgeTree() {
    this.#requireUnlocked();
    const byParent = new Map();
    for (const node of this.listKnowledgeNodes()) {
      const key = node.parentId ?? `branch:${node.branch}`;
      const siblings = byParent.get(key) ?? [];
      siblings.push(node);
      byParent.set(key, siblings);
    }
    const build = (node) => ({ ...node, children: (byParent.get(node.id) ?? []).map(build) });
    return KNOWLEDGE_BRANCHES.map((branch) => ({ ...branch, virtual: true,
      children: (byParent.get(`branch:${branch.id}`) ?? []).map(build) }));
  }

  getKnowledgeNode(value) {
    this.#requireUnlocked();
    const id = knowledgeId(value);
    const node = this.#knowledgeNodeFromRow(this.#knowledgeNodeRow(id));
    const connections = this.#db.prepare(`SELECT * FROM knowledge_connections
      WHERE source_id = ? OR target_id = ? ORDER BY created_at, id`).all(id, id).map((connection) => {
      const otherId = connection.source_id === id ? connection.target_id : connection.source_id;
      const other = this.#knowledgeNodeFromRow(this.#knowledgeNodeRow(otherId));
      return { id: connection.id, node: { id: other.id, name: other.name, branch: other.branch, status: other.status } };
    }).sort((left, right) => left.node.name.localeCompare(right.node.name, 'en-US', { sensitivity: 'base' }));
    const childCount = this.#db.prepare('SELECT count(*) AS count FROM knowledge_nodes WHERE parent_id = ?').get(id).count;
    return { ...node, childCount, connections };
  }

  createKnowledgeNode(input) {
    this.#requireUnlocked();
    requireObject(input);
    rejectUnexpectedFields(input, new Set(['name', 'branch', 'parentId', 'status', 'understanding', 'terms']));
    const name = normalizeKnowledgeName(input.name);
    const branch = normalizeKnowledgeBranch(input.branch);
    const parentId = input.parentId == null ? null : knowledgeId(input.parentId, 'parentId');
    const content = normalizeKnowledgeContent(input.status ?? 'unassessed', input.understanding, input.terms ?? []);
    if (parentId !== null) {
      const parent = this.getKnowledgeNode(parentId);
      if (parent.branch !== branch) fail(400, 'BRANCH_MISMATCH', 'A child must belong to the same branch as its parent.');
      if (parent.status !== 'known') fail(409, 'PARENT_NOT_KNOWN', 'Only a known node may be decomposed into children.');
    }
    this.#assertUniqueKnowledgeSibling(name, branch, parentId);
    const timestamp = now();
    let id;
    transaction(this.#db, () => {
      const result = this.#db.prepare(`INSERT INTO knowledge_nodes
        (branch, parent_id, status, revision, created_at, updated_at, payload)
        VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run(branch, parentId, content.status, timestamp, timestamp, '{}');
      id = Number(result.lastInsertRowid);
      this.#db.prepare('UPDATE knowledge_nodes SET payload = ? WHERE id = ?').run(
        this.#encryptKnowledgeNode(id, 1, branch, { name, understanding: content.understanding, terms: content.terms }), id);
      if (parentId !== null) this.#touchKnowledgeNode(parentId, timestamp);
    });
    return this.getKnowledgeNode(id);
  }

  patchKnowledgeNode(value, input) {
    this.#requireUnlocked();
    requireObject(input);
    rejectUnexpectedFields(input, new Set(['name', 'branch', 'parentId', 'status', 'understanding', 'terms']));
    const id = knowledgeId(value);
    const current = this.getKnowledgeNode(id);
    const name = input.name === undefined ? current.name : normalizeKnowledgeName(input.name);
    let parentId = input.parentId === undefined ? current.parentId : input.parentId == null ? null : knowledgeId(input.parentId, 'parentId');
    let branch = input.branch === undefined ? current.branch : normalizeKnowledgeBranch(input.branch);
    const status = input.status === undefined ? current.status : input.status;
    const understanding = input.understanding === undefined ? current.understanding : input.understanding;
    const termsInput = input.terms === undefined ? (status === 'known' ? current.terms : []) : input.terms;
    const content = normalizeKnowledgeContent(status, understanding, termsInput);
    if (current.childCount && content.status !== 'known') {
      fail(409, 'CHILDREN_REQUIRE_KNOWN_PARENT', 'A node with children must remain known.');
    }
    if (parentId !== null) {
      if (parentId === id) fail(400, 'KNOWLEDGE_CYCLE', 'A node cannot be its own parent.');
      const parent = this.getKnowledgeNode(parentId);
      if (parent.status !== 'known') fail(409, 'PARENT_NOT_KNOWN', 'Only a known node may be decomposed into children.');
      if (this.#knowledgeIsDescendant(parentId, id)) fail(400, 'KNOWLEDGE_CYCLE', 'A node cannot be moved beneath one of its descendants.');
      if (input.branch !== undefined && branch !== parent.branch) fail(400, 'BRANCH_MISMATCH', 'A child must belong to the same branch as its parent.');
      branch = parent.branch;
    }
    this.#assertUniqueKnowledgeSibling(name, branch, parentId, id);
    const unchanged = name === current.name && branch === current.branch && parentId === current.parentId &&
      content.status === current.status && content.understanding === current.understanding &&
      canonicalJson(content.terms) === canonicalJson(current.terms);
    if (unchanged) return current;
    const timestamp = now();
    transaction(this.#db, () => {
      const revision = current.revision + 1;
      this.#db.prepare(`UPDATE knowledge_nodes SET branch = ?, parent_id = ?, status = ?, revision = ?, updated_at = ?, payload = ? WHERE id = ?`)
        .run(branch, parentId, content.status, revision, timestamp,
          this.#encryptKnowledgeNode(id, revision, branch, { name, understanding: content.understanding, terms: content.terms }), id);
      if (branch !== current.branch) this.#moveKnowledgeDescendants(id, branch, timestamp);
      const parents = new Set();
      if (current.parentId !== null && (name !== current.name || content.status !== current.status || parentId !== current.parentId)) parents.add(current.parentId);
      if (parentId !== null && parentId !== current.parentId) parents.add(parentId);
      for (const affected of parents) this.#touchKnowledgeNode(affected, timestamp);
    });
    return this.getKnowledgeNode(id);
  }

  deleteKnowledgeNode(value) {
    this.#requireUnlocked();
    const id = knowledgeId(value);
    const node = this.getKnowledgeNode(id);
    if (node.childCount) fail(409, 'NODE_HAS_CHILDREN', "Move or delete this node's children before deleting it.");
    transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(id);
      if (node.parentId !== null) this.#touchKnowledgeNode(node.parentId, now());
    });
    return { deleted: true };
  }

  createKnowledgeConnection(input) {
    this.#requireUnlocked();
    requireObject(input);
    const first = knowledgeId(input.sourceId, 'sourceId');
    const second = knowledgeId(input.targetId, 'targetId');
    if (first === second) fail(400, 'SELF_CONNECTION', 'A node cannot connect to itself.');
    this.#knowledgeNodeRow(first); this.#knowledgeNodeRow(second);
    const [sourceId, targetId] = first < second ? [first, second] : [second, first];
    if (this.#db.prepare('SELECT 1 FROM knowledge_connections WHERE source_id = ? AND target_id = ?').get(sourceId, targetId)) {
      fail(409, 'KNOWLEDGE_CONNECTION_EXISTS', 'These nodes are already connected.');
    }
    const createdAt = now();
    const result = this.#db.prepare('INSERT INTO knowledge_connections(source_id, target_id, created_at) VALUES (?, ?, ?)')
      .run(sourceId, targetId, createdAt);
    return { id: Number(result.lastInsertRowid), sourceId, targetId };
  }

  deleteKnowledgeConnection(value) {
    this.#requireUnlocked();
    const id = knowledgeId(value);
    const result = this.#db.prepare('DELETE FROM knowledge_connections WHERE id = ?').run(id);
    if (!result.changes) fail(404, 'KNOWLEDGE_CONNECTION_NOT_FOUND', `Connection ${id} does not exist.`);
    return { deleted: true };
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
      if (record.category === 'goal' && record.parentId) {
        const parentRow = this.#db.prepare("SELECT * FROM records WHERE id = ? AND category = 'goal'").get(record.parentId);
        record.parentGoal = parentRow ? this.#recordFromRow(parentRow) : null;
      }
    }
    return record;
  }

  getGoalGraph(id) {
    this.#requireUnlocked();
    const goal = this.#goalRecord(id);
    const nodes = this.#db.prepare("SELECT * FROM records WHERE category = 'goal' AND parent_id = ? AND trashed = 0 ORDER BY position")
      .all(id).map((row) => this.#recordFromRow(row));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const dependencies = this.#db.prepare(`SELECT goal_id, prerequisite_id, created_at FROM goal_dependencies
      WHERE goal_id IN (SELECT id FROM records WHERE parent_id = ? AND trashed = 0)
      ORDER BY created_at, goal_id, prerequisite_id`).all(id)
      .filter((edge) => nodeIds.has(edge.prerequisite_id))
      .map((edge) => ({ goalId: edge.goal_id, prerequisiteId: edge.prerequisite_id, createdAt: edge.created_at }));
    return {
      goal: { ...goal, progress: this.#goalProgress(goal.id) },
      nodes: nodes.map((node) => ({ ...node, progress: this.#goalProgress(node.id),
        hasSubgoals: Boolean(this.#db.prepare("SELECT 1 FROM records WHERE category = 'goal' AND parent_id = ? AND trashed = 0 LIMIT 1").get(node.id)) })),
      dependencies,
    };
  }

  createGoalDependency(goalId, prerequisiteId) {
    this.#requireUnlocked();
    if (typeof prerequisiteId !== 'string' || !prerequisiteId) {
      fail(400, 'VALIDATION_ERROR', 'prerequisiteId must identify a goal.');
    }
    const goal = this.#goalRecord(goalId);
    const prerequisite = this.#goalRecord(prerequisiteId);
    if (goal.trashed || prerequisite.trashed) fail(409, 'GOAL_TRASHED', 'Removed goals cannot participate in progression.');
    if (!goal.parentId || goal.parentId !== prerequisite.parentId) {
      fail(400, 'INVALID_GOAL_DEPENDENCY', 'A prerequisite must be a sibling subgoal in the same progression.');
    }
    if (goal.id === prerequisite.id) fail(409, 'GOAL_DEPENDENCY_CYCLE', 'A subgoal cannot depend on itself.');
    const duplicate = this.#db.prepare('SELECT 1 FROM goal_dependencies WHERE goal_id = ? AND prerequisite_id = ?').get(goal.id, prerequisite.id);
    if (duplicate) fail(409, 'GOAL_DEPENDENCY_EXISTS', 'This prerequisite already exists.');
    const reachable = new Set([goal.id]);
    const queue = [goal.id];
    while (queue.length) {
      const current = queue.shift();
      for (const row of this.#db.prepare('SELECT goal_id FROM goal_dependencies WHERE prerequisite_id = ?').all(current)) {
        if (row.goal_id === prerequisite.id) fail(409, 'GOAL_DEPENDENCY_CYCLE', 'The prerequisite would create a cycle.');
        if (!reachable.has(row.goal_id)) { reachable.add(row.goal_id); queue.push(row.goal_id); }
      }
    }
    const createdAt = now();
    this.#db.prepare('INSERT INTO goal_dependencies(goal_id, prerequisite_id, created_at) VALUES (?, ?, ?)')
      .run(goal.id, prerequisite.id, createdAt);
    return { goalId: goal.id, prerequisiteId: prerequisite.id, createdAt };
  }

  createSubgoal(parentId, input) {
    this.#requireUnlocked();
    requireObject(input);
    rejectUnexpectedFields(input, new Set(['requestId', 'title', 'data', 'customFieldValues', 'prerequisiteIds']));
    if (typeof input.requestId !== 'string' || !UPLOAD_ID.test(input.requestId)) {
      fail(400, 'VALIDATION_ERROR', 'requestId must be a UUID.');
    }
    if (!Array.isArray(input.prerequisiteIds) || input.prerequisiteIds.some((id) => typeof id !== 'string' || !id)) {
      fail(400, 'VALIDATION_ERROR', 'prerequisiteIds must be an array of goal identifiers.');
    }
    const prerequisiteIds = [...new Set(input.prerequisiteIds)].sort();
    if (prerequisiteIds.length !== input.prerequisiteIds.length) {
      fail(400, 'VALIDATION_ERROR', 'prerequisiteIds must not contain duplicates.');
    }
    const content = normalizeRecord({
      category: 'goal', title: input.title, data: input.data,
      customFieldValues: input.customFieldValues ?? {},
    });
    const signature = canonicalJson({ parentId, content, prerequisiteIds });
    const existingRequest = this.#db.prepare('SELECT * FROM subgoal_requests WHERE request_id = ?').get(input.requestId);
    if (existingRequest) {
      const stored = decryptJson(this.#key, existingRequest.payload,
        objectAad('subgoal-request', input.requestId, 1, existingRequest.record_id));
      if (stored.signature !== signature) {
        fail(409, 'IDEMPOTENCY_CONFLICT', 'requestId was already used for a different subgoal request.');
      }
      return { record: this.getRecord(existingRequest.record_id), created: false };
    }

    const parent = this.#goalRecord(parentId);
    if (parent.trashed) fail(409, 'GOAL_TRASHED', 'A removed Goal cannot receive subgoals.');
    this.#validateCustomValues('goal', content.customFieldValues);
    const prerequisites = prerequisiteIds.map((id) => this.#goalRecord(id));
    if (prerequisites.some((goal) => goal.trashed || goal.parentId !== parentId)) {
      fail(400, 'INVALID_GOAL_DEPENDENCY', 'Every prerequisite must be an active sibling in this progression.');
    }

    const id = randomUUID();
    const createdAt = now();
    const position = this.#insertPosition(parentId, undefined);
    const snapshot = { ...content, parentId, position, trashed: false };
    transaction(this.#db, () => {
      this.#shiftPositions(parentId, position, 1);
      this.#db.prepare(`INSERT INTO records
        (id, category, revision, trashed, parent_id, position, created_at, updated_at, payload)
        VALUES (?, 'goal', 1, 0, ?, ?, ?, ?, ?)`)
        .run(id, parentId, position, createdAt, createdAt, this.#encryptRecord(id, 1, 'goal', snapshot));
      this.#insertRevision(id, 1, 'goal', createdAt, snapshot);
      const insertDependency = this.#db.prepare(`INSERT INTO goal_dependencies
        (goal_id, prerequisite_id, created_at) VALUES (?, ?, ?)`);
      for (const prerequisiteId of prerequisiteIds) insertDependency.run(id, prerequisiteId, createdAt);
      this.#db.prepare(`INSERT INTO subgoal_requests(request_id, record_id, created_at, payload)
        VALUES (?, ?, ?, ?)`).run(input.requestId, id, createdAt,
        encryptJson(this.#key, { signature }, objectAad('subgoal-request', input.requestId, 1, id)));
    });
    return { record: this.getRecord(id), created: true };
  }

  deleteGoalDependency(goalId, prerequisiteId) {
    this.#requireUnlocked();
    const result = this.#db.prepare('DELETE FROM goal_dependencies WHERE goal_id = ? AND prerequisite_id = ?')
      .run(goalId, prerequisiteId);
    if (!result.changes) fail(404, 'GOAL_DEPENDENCY_NOT_FOUND', 'Goal prerequisite not found.');
    return { deleted: true };
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
        if (parentId !== existing.parentId) {
          this.#db.prepare('DELETE FROM goal_dependencies WHERE goal_id = ? OR prerequisite_id = ?').run(id, id);
        }
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
        if (candidate.parentId !== existing.parentId) {
          this.#db.prepare('DELETE FROM goal_dependencies WHERE goal_id = ? OR prerequisite_id = ?').run(id, id);
        }
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
    const duplicate = this.listCustomFields({ category: field.category }).find((item) => item.id !== id &&
      item.name.normalize('NFKC').toLocaleLowerCase() === field.name.normalize('NFKC').toLocaleLowerCase());
    if (duplicate) fail(409, 'CUSTOM_FIELD_EXISTS', 'A custom field with that name already exists in the category.');
    for (const record of this.listRecords({ category: field.category, trashed: 'all' })) {
      if (Object.hasOwn(record.customFieldValues, id)) validateCustomFieldValue(field, record.customFieldValues[id]);
    }
    for (const revisionRow of this.#db.prepare('SELECT * FROM record_revisions WHERE category = ?').all(field.category)) {
      const snapshot = decryptJson(this.#key, revisionRow.payload,
        objectAad('revision', revisionRow.record_id, revisionRow.revision, revisionRow.category));
      if (Object.hasOwn(snapshot.customFieldValues ?? {}, id)) {
        validateCustomFieldValue(field, snapshot.customFieldValues[id]);
      }
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
    return this.#withLifecycle(async (generation) => {
      this.#requireUnlocked();
      const result = await createBackupEnvelope(passphrase, this.#exportSnapshot());
      this.#assertLifecycle(generation);
      return result;
    });
  }

  async exportV2(passphrase) {
    this.#requireUnlocked();
    const generation = this.#lifecycleGeneration;
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
    const key = this.#copyTransientKey();
    const atlas = this;
    const plaintext = async function* () {
      try {
        atlas.#assertLifecycle(generation);
        yield prefix;
        atlas.#assertLifecycle(generation);
        yield manifest;
        for (let index = 0; index < rows.length; index += 1) {
          atlas.#assertLifecycle(generation);
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
        atlas.#releaseTransientKey(key);
      }
    };
    let result;
    try {
      result = await createBackupV2Stream(passphrase, plaintextLength, plaintext());
      this.#assertLifecycle(generation);
    } catch (error) {
      this.#releaseTransientKey(key);
      throw error;
    }
    return {
      ...result,
      contentType: 'application/vnd.eidolon-atlas-backup',
      filename: `eidolon-atlas-${now().slice(0, 10)}.atlas`,
    };
  }

  async exportV3(passphrase) {
    this.#requireUnlocked();
    const generation = this.#lifecycleGeneration;
    const snapshot = this.#exportSnapshot();
    const rows = this.#db.prepare('SELECT * FROM record_images ORDER BY record_id, position, created_at, id').all();
    const images = rows.map((row) => this.#imageFromRow(row));
    const key = this.#copyTransientKey();
    const atlas = this;
    const emit = async function* (value) {
      atlas.#assertLifecycle(generation);
      const frame = archiveFrame(value);
      try { yield frame; } finally { frame.fill(0); }
    };
    const plaintext = async function* () {
      try {
        atlas.#assertLifecycle(generation);
        yield* emit({ type: 'archive', format: 'eidolon-atlas-archive', version: 3, exportedAt: snapshot.exportedAt });
        for (const value of snapshot.customFields) yield* emit({ type: 'customField', value });
        for (const value of snapshot.records) yield* emit({ type: 'record', value });
        for (const value of snapshot.revisions) yield* emit({ type: 'revision', value });
        for (const value of snapshot.links) yield* emit({ type: 'link', value });
        for (const value of snapshot.goalDependencies) yield* emit({ type: 'goalDependency', value });
        for (const value of snapshot.knowledge.nodes) yield* emit({ type: 'knowledgeNode', value });
        for (const value of snapshot.knowledge.connections) yield* emit({ type: 'knowledgeConnection', value });
        for (const value of snapshot.knowledge.metadata) yield* emit({ type: 'knowledgeMetadata', value });
        for (let index = 0; index < rows.length; index += 1) {
          atlas.#assertLifecycle(generation);
          const metadata = images[index];
          yield* emit({ type: 'image', value: metadata });
          const bytes = decryptBinary(key, rows[index].content,
            objectAad('image-content', rows[index].id, 1, rows[index].record_id));
          try {
            if (bytes.length !== metadata.byteLength || imageType(bytes) !== metadata.mimeType) {
              fail(422, 'DATA_INTEGRITY_ERROR', 'Encrypted image content does not match its authenticated metadata.');
            }
            yield bytes;
          } finally {
            bytes.fill(0);
          }
        }
        yield* emit({ type: 'end', counts: {
          customFields: snapshot.customFields.length, records: snapshot.records.length,
          revisions: snapshot.revisions.length, links: snapshot.links.length,
          goalDependencies: snapshot.goalDependencies.length, knowledgeNodes: snapshot.knowledge.nodes.length,
          knowledgeConnections: snapshot.knowledge.connections.length,
          knowledgeMetadata: snapshot.knowledge.metadata.length, images: images.length,
        } });
        atlas.#assertLifecycle(generation);
      } finally {
        atlas.#releaseTransientKey(key);
      }
    };
    try {
      const result = await createBackupV3Stream(passphrase, plaintext());
      this.#assertLifecycle(generation);
      return {
        ...result,
        contentType: 'application/vnd.eidolon-atlas-backup',
        filename: `eidolon-atlas-${now().slice(0, 10)}.atlas`,
      };
    } catch (error) {
      this.#releaseTransientKey(key);
      throw error;
    }
  }

  async stageImportUpload(source, { maxBytes = BACKUP_UPLOAD_MAX_BYTES } = {}) {
    this.#requireUnlocked();
    const generation = this.#lifecycleGeneration;
    const id = randomUUID();
    const path = this.#uploadPath(id);
    const handle = await open(path, 'wx', 0o600);
    let byteLength = 0;
    try {
      for await (const value of source) {
        this.#assertLifecycle(generation);
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
      this.#assertLifecycle(generation);
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
    return this.#withLifecycle(async (generation) => {
      this.#requireUnlocked();
      this.#requireUpload(id);
      const path = this.#uploadPath(id);
      const stagedImages = [];
      try {
        const { prepared, images } = await this.#openBackupUpload(path, passphrase, stagedImages, generation);
        this.#assertLifecycle(generation);
        this.#replaceSnapshot(prepared, images);
        this.#advanceLifecycle(generation);
        return { imported: true, records: prepared.records.length, images: images.length };
      } finally {
        this.#uploads.delete(id);
        await rm(path, { force: true }).catch(() => {});
        await Promise.all(stagedImages.map((image) => rm(image.path, { force: true }).catch(() => {})));
      }
    });
  }

  async import(passphrase, envelope) {
    return this.#withLifecycle(async (generation) => {
      this.#requireUnlocked();
      const snapshot = await openBackupEnvelope(passphrase, envelope);
      this.#assertLifecycle(generation);
      const prepared = this.#validateSnapshot(snapshot);
      this.#replaceSnapshot(prepared, []);
      this.#advanceLifecycle(generation);
      return { imported: true, records: prepared.records.length };
    });
  }

  #replaceSnapshot(prepared, images) {
    this.#requireUnlocked();
    transaction(this.#db, () => {
      this.#db.exec('DELETE FROM record_images; DELETE FROM goal_dependencies; DELETE FROM links; DELETE FROM record_revisions; DELETE FROM records; DELETE FROM custom_fields; DELETE FROM knowledge_connections; DELETE FROM knowledge_metadata;');
      const deleteKnowledgeLeaves = this.#db.prepare(`DELETE FROM knowledge_nodes
        WHERE NOT EXISTS (SELECT 1 FROM knowledge_nodes child WHERE child.parent_id = knowledge_nodes.id)`);
      while (this.#db.prepare('SELECT 1 FROM knowledge_nodes LIMIT 1').get()) {
        if (!deleteKnowledgeLeaves.run().changes) fail(500, 'KNOWLEDGE_INTEGRITY_ERROR', 'Stored knowledge hierarchy could not be replaced.');
      }
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
      for (const edge of prepared.goalDependencies) {
        this.#db.prepare('INSERT INTO goal_dependencies(goal_id, prerequisite_id, created_at) VALUES (?, ?, ?)')
          .run(edge.goalId, edge.prerequisiteId, edge.createdAt);
      }
      for (const node of prepared.knowledge.nodes) {
        this.#db.prepare(`INSERT INTO knowledge_nodes
          (id, branch, parent_id, status, revision, created_at, updated_at, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(node.id, node.branch, node.parentId, node.status,
          node.revision, node.createdAt, node.updatedAt,
          this.#encryptKnowledgeNode(node.id, node.revision, node.branch, node));
      }
      for (const connection of prepared.knowledge.connections) {
        this.#db.prepare(`INSERT INTO knowledge_connections(id, source_id, target_id, created_at) VALUES (?, ?, ?, ?)`)
          .run(connection.id, connection.sourceId, connection.targetId, connection.createdAt);
      }
      for (const entry of prepared.knowledge.metadata) this.#setKnowledgeMeta(entry.key, entry.value);
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
      goalDependencies: this.#db.prepare('SELECT goal_id, prerequisite_id, created_at FROM goal_dependencies ORDER BY created_at, goal_id, prerequisite_id')
        .all().map((edge) => ({ goalId: edge.goal_id, prerequisiteId: edge.prerequisite_id, createdAt: edge.created_at })),
      knowledge: {
        nodes: this.#db.prepare('SELECT * FROM knowledge_nodes ORDER BY id').all().map((row) => this.#knowledgeNodeFromRow(row)),
        connections: this.#db.prepare('SELECT * FROM knowledge_connections ORDER BY id').all().map((row) => ({
          id: row.id, sourceId: row.source_id, targetId: row.target_id, createdAt: row.created_at,
        })),
        metadata: this.#db.prepare('SELECT * FROM knowledge_metadata ORDER BY key').all().map((row) => ({
          key: row.key, value: this.#knowledgeMeta(row.key, row.payload),
        })),
      },
    };
  }

  async #openBackupUpload(path, passphrase, stagedImages, generation) {
    const handle = await open(path, 'r');
    const magic = Buffer.alloc(BACKUP_V2_MAGIC.length);
    try {
      if ((await handle.read(magic, 0, magic.length, 0)).bytesRead !== magic.length) {
        fail(400, 'INVALID_BACKUP', 'The backup container is truncated.');
      }
    } finally {
      await handle.close();
    }
    if (magic.equals(BACKUP_V3_MAGIC)) return this.#openV3Upload(path, passphrase, stagedImages, generation);
    if (magic.equals(BACKUP_V2_MAGIC)) return this.#openV2Upload(path, passphrase, stagedImages, generation);
    fail(400, 'INVALID_BACKUP', 'The backup is not a supported container.');
  }

  async #openV3Upload(path, passphrase, stagedImages, generation) {
    const handle = await open(path, 'r');
    let size;
    let prefix;
    let tag;
    try {
      size = (await handle.stat()).size;
      const preludeLength = BACKUP_V3_MAGIC.length + 4;
      if (size < preludeLength + 2 + 16) fail(400, 'INVALID_BACKUP', 'The v3 backup is truncated.');
      const prelude = Buffer.alloc(preludeLength);
      if ((await handle.read(prelude, 0, prelude.length, 0)).bytesRead !== prelude.length ||
          !prelude.subarray(0, BACKUP_V3_MAGIC.length).equals(BACKUP_V3_MAGIC)) {
        fail(400, 'INVALID_BACKUP', 'The backup is not a supported v3 container.');
      }
      const headerLength = prelude.readUInt32BE(BACKUP_V3_MAGIC.length);
      if (headerLength < 2 || headerLength > BACKUP_V2_MAX_HEADER_BYTES || size < preludeLength + headerLength + 16 + 6) {
        fail(400, 'INVALID_BACKUP', 'The v3 backup header is invalid or the backup is truncated.');
      }
      prefix = Buffer.alloc(preludeLength + headerLength);
      prelude.copy(prefix);
      if ((await handle.read(prefix, preludeLength, headerLength, preludeLength)).bytesRead !== headerLength) {
        fail(400, 'INVALID_BACKUP', 'The v3 backup header is truncated.');
      }
      tag = Buffer.alloc(16);
      if ((await handle.read(tag, 0, 16, size - 16)).bytesRead !== 16) fail(400, 'INVALID_BACKUP', 'The v3 backup tag is truncated.');
    } finally {
      await handle.close();
    }

    const { decipher, key, tagBytes } = await createBackupV3Decipher(passphrase, prefix);
    decipher.setAuthTag(tag);
    try { this.#assertLifecycle(generation); } catch (error) { key.fill(0); throw error; }
    const localKey = this.#copyTransientKey();
    const snapshot = {
      format: 'eidolon-atlas-snapshot', version: 1, exportedAt: null,
      records: [], revisions: [], customFields: [], links: [], goalDependencies: [],
      knowledge: { nodes: [], connections: [], metadata: [] },
    };
    const images = [];
    let started = false;
    let ended = false;
    let lengthBytes = Buffer.alloc(4);
    let lengthSeen = 0;
    let frameLength;
    let frameSeen = 0;
    let frameChunks = [];
    let rawImage = null;
    let rawSeen = 0;
    let rawChunks = [];
    let parseError;

    const finishImage = async () => {
      const bytes = Buffer.concat(rawChunks, rawSeen);
      rawChunks = [];
      rawSeen = 0;
      try {
        if (bytes.length !== rawImage.byteLength || imageType(bytes) !== rawImage.mimeType) {
          fail(400, 'INVALID_BACKUP', 'Backup image bytes do not match their authenticated metadata.');
        }
        const encrypted = encryptBinary(localKey, bytes,
          objectAad('image-content', rawImage.id, 1, rawImage.recordId));
        const imagePath = join(this.#stagingDir, `image-${randomUUID()}.encrypted`);
        try {
          await writeFile(imagePath, encrypted, { flag: 'wx', mode: 0o600 });
          stagedImages.push({ ...rawImage, path: imagePath });
        } finally {
          encrypted.fill(0);
        }
      } finally {
        bytes.fill(0);
      }
      rawImage = null;
    };

    const acceptFrame = (frame) => {
      if (!frame || typeof frame.type !== 'string') fail(400, 'INVALID_BACKUP', 'A v3 backup frame is invalid.');
      if (!started) {
        if (frame.type !== 'archive' || frame.format !== 'eidolon-atlas-archive' || frame.version !== 3 ||
            typeof frame.exportedAt !== 'string') {
          fail(400, 'INVALID_BACKUP', 'The v3 archive header frame is invalid.');
        }
        started = true;
        snapshot.exportedAt = frame.exportedAt;
        return;
      }
      if (ended) fail(400, 'INVALID_BACKUP', 'The v3 backup contains data after its end frame.');
      const targets = {
        customField: snapshot.customFields, record: snapshot.records, revision: snapshot.revisions,
        link: snapshot.links, goalDependency: snapshot.goalDependencies,
        knowledgeNode: snapshot.knowledge.nodes, knowledgeConnection: snapshot.knowledge.connections,
        knowledgeMetadata: snapshot.knowledge.metadata,
      };
      if (targets[frame.type]) {
        targets[frame.type].push(frame.value);
        return;
      }
      if (frame.type === 'image') {
        const image = frame.value;
        if (!image || typeof image.id !== 'string' || typeof image.recordId !== 'string' ||
            typeof image.createdAt !== 'string' || integerPosition(image.position) === undefined) {
          fail(400, 'INVALID_BACKUP', 'An image has invalid structural metadata.');
        }
        validateImageMetadata(image, { backup: true });
        images.push(image);
        rawImage = image;
        return;
      }
      if (frame.type === 'end') {
        const counts = frame.counts;
        const expected = {
          customFields: snapshot.customFields.length, records: snapshot.records.length,
          revisions: snapshot.revisions.length, links: snapshot.links.length,
          goalDependencies: snapshot.goalDependencies.length, knowledgeNodes: snapshot.knowledge.nodes.length,
          knowledgeConnections: snapshot.knowledge.connections.length,
          knowledgeMetadata: snapshot.knowledge.metadata.length, images: images.length,
        };
        if (canonicalJson(counts) !== canonicalJson(expected)) {
          fail(400, 'INVALID_BACKUP', 'The v3 backup end-frame counts do not match its contents.');
        }
        ended = true;
        return;
      }
      fail(400, 'INVALID_BACKUP', 'The v3 backup contains an unsupported frame type.');
    };

    const consume = async (plaintext) => {
      let offset = 0;
      while (offset < plaintext.length) {
        if (rawImage) {
          const take = Math.min(rawImage.byteLength - rawSeen, plaintext.length - offset);
          rawChunks.push(Buffer.from(plaintext.subarray(offset, offset + take)));
          rawSeen += take;
          offset += take;
          if (rawSeen === rawImage.byteLength) await finishImage();
          continue;
        }
        if (lengthSeen < 4) {
          const take = Math.min(4 - lengthSeen, plaintext.length - offset);
          plaintext.copy(lengthBytes, lengthSeen, offset, offset + take);
          lengthSeen += take;
          offset += take;
          if (lengthSeen === 4) {
            frameLength = lengthBytes.readUInt32BE(0);
            if (frameLength < 2 || frameLength > ARCHIVE_FRAME_MAX_BYTES) {
              fail(400, 'INVALID_BACKUP', 'A v3 backup frame length is invalid.');
            }
          }
          continue;
        }
        const take = Math.min(frameLength - frameSeen, plaintext.length - offset);
        frameChunks.push(Buffer.from(plaintext.subarray(offset, offset + take)));
        frameSeen += take;
        offset += take;
        if (frameSeen === frameLength) {
          const frameBytes = Buffer.concat(frameChunks, frameLength);
          frameChunks = [];
          let frame;
          try {
            frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frameBytes));
          } catch {
            fail(400, 'INVALID_BACKUP', 'A v3 backup frame is not valid JSON.');
          } finally {
            frameBytes.fill(0);
          }
          lengthSeen = 0;
          frameLength = undefined;
          frameSeen = 0;
          acceptFrame(frame);
        }
      }
    };

    try {
      const ciphertextEnd = size - tagBytes - 1;
      for await (const chunk of createReadStream(path, { start: prefix.length, end: ciphertextEnd })) {
        this.#assertLifecycle(generation);
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
      if (!started || !ended || rawImage || lengthSeen !== 0 || frameSeen !== 0) {
        fail(400, 'INVALID_BACKUP', 'The v3 backup archive is truncated.');
      }
      const { prepared } = this.#validateV2Manifest({
        format: 'eidolon-atlas-archive', version: 3, snapshot, images,
      });
      return { prepared, images: stagedImages };
    } finally {
      key.fill(0);
      this.#releaseTransientKey(localKey);
      lengthBytes.fill(0);
      for (const chunk of frameChunks) chunk.fill(0);
      for (const chunk of rawChunks) chunk.fill(0);
    }
  }

  async #openV2Upload(path, passphrase, stagedImages, generation) {
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
    try { this.#assertLifecycle(generation); } catch (error) { key.fill(0); throw error; }
    const localKey = this.#copyTransientKey();
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
        this.#assertLifecycle(generation);
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
      this.#releaseTransientKey(localKey);
      lengthBytes.fill(0);
      for (const chunk of manifestChunks) chunk.fill(0);
      for (const chunk of imageChunks) chunk.fill(0);
    }
  }

  #validateV2Manifest(manifest) {
    if (!manifest || manifest.format !== 'eidolon-atlas-archive' || ![2, 3].includes(manifest.version) || !Array.isArray(manifest.images)) {
      fail(400, 'INVALID_BACKUP', 'The backup archive manifest is invalid or unsupported.');
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
      !Array.isArray(snapshot.customFields) || !Array.isArray(snapshot.links) ||
      (snapshot.goalDependencies !== undefined && !Array.isArray(snapshot.goalDependencies))) {
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
      const migrated = record?.category === 'goal' ? { ...record, data: goalDataWithoutLegacyText(record.data) } : record;
      const content = normalizeRecord(migrated);
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
      const migratedSnapshot = revision.category === 'goal'
        ? { ...revision.snapshot, data: goalDataWithoutLegacyText(revision.snapshot.data) }
        : revision.snapshot;
      const normalized = normalizeRecord(migratedSnapshot);
      if (normalized.category !== revision.category) fail(400, 'INVALID_BACKUP', 'A revision category does not match.');
      if (typeof revision.snapshot.trashed !== 'boolean') fail(400, 'INVALID_BACKUP', 'A revision has invalid trash state.');
      const parentId = revision.snapshot.parentId ?? null;
      if (normalized.category !== 'goal' && parentId !== null) fail(400, 'INVALID_BACKUP', 'Only goal revisions may have parents.');
      if (parentId !== null && (!byId.has(parentId) || byId.get(parentId).category !== 'goal')) {
        fail(400, 'INVALID_BACKUP', 'A goal revision has an invalid parent.');
      }
      for (const [fieldId, value] of Object.entries(normalized.customFieldValues)) {
        const definition = fieldMap.get(fieldId);
        if (!definition) fail(400, 'INVALID_BACKUP', 'A revision references a missing custom field.');
        if (definition.category !== normalized.category) fail(400, 'INVALID_BACKUP', 'A custom field is used by the wrong revision category.');
        validateCustomFieldValue(definition, value);
      }
      return { ...revision, snapshot: { ...normalized, parentId: revision.snapshot.parentId ?? null,
        position: integerPosition(revision.snapshot.position) ?? 0, trashed: Boolean(revision.snapshot.trashed) } };
    });
    const revisionGroups = new Map();
    for (const revision of revisions) {
      const recordRevisions = revisionGroups.get(revision.recordId) ?? new Map();
      if (recordRevisions.has(revision.revision)) fail(400, 'INVALID_BACKUP', 'The backup contains duplicate revisions.');
      recordRevisions.set(revision.revision, revision);
      revisionGroups.set(revision.recordId, recordRevisions);
    }
    for (const record of records) {
      const recordRevisions = revisionGroups.get(record.id);
      const currentRevision = recordRevisions?.get(record.revision);
      if (!currentRevision) fail(400, 'INVALID_BACKUP', 'A current record revision is missing from history.');
      if (canonicalJson(currentRevision.snapshot) !== canonicalJson(this.#snapshotFromRecord(record))) {
        fail(400, 'INVALID_BACKUP', 'A current record does not match its current revision.');
      }
      const revisionNumbers = [...recordRevisions.keys()].sort((left, right) => left - right);
      if (revisionNumbers.length !== record.revision ||
          revisionNumbers.some((value, index) => value !== index + 1)) {
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
    const goalDependencies = (snapshot.goalDependencies ?? []).map((edge) => {
      if (!edge || typeof edge.goalId !== 'string' || typeof edge.prerequisiteId !== 'string' || typeof edge.createdAt !== 'string') {
        fail(400, 'INVALID_BACKUP', 'A goal prerequisite is invalid.');
      }
      const goal = byId.get(edge.goalId);
      const prerequisite = byId.get(edge.prerequisiteId);
      if (!goal || !prerequisite || goal.category !== 'goal' || prerequisite.category !== 'goal' ||
          !goal.parentId || goal.parentId !== prerequisite.parentId || goal.id === prerequisite.id) {
        fail(400, 'INVALID_BACKUP', 'A goal prerequisite must connect sibling subgoals.');
      }
      return { goalId: goal.id, prerequisiteId: prerequisite.id, createdAt: edge.createdAt };
    });
    const dependencyKeys = new Set();
    const dependencyNext = new Map();
    for (const edge of goalDependencies) {
      const key = `${edge.goalId}:${edge.prerequisiteId}`;
      if (dependencyKeys.has(key)) fail(400, 'INVALID_BACKUP', 'The backup contains duplicate goal prerequisites.');
      dependencyKeys.add(key);
      if (!dependencyNext.has(edge.prerequisiteId)) dependencyNext.set(edge.prerequisiteId, []);
      dependencyNext.get(edge.prerequisiteId).push(edge.goalId);
    }
    const visiting = new Set();
    const visited = new Set();
    const visitDependency = (goalId) => {
      if (visiting.has(goalId)) fail(400, 'INVALID_BACKUP', 'The goal progression contains a cycle.');
      if (visited.has(goalId)) return;
      visiting.add(goalId);
      for (const next of dependencyNext.get(goalId) ?? []) visitDependency(next);
      visiting.delete(goalId);
      visited.add(goalId);
    };
    for (const edge of goalDependencies) visitDependency(edge.prerequisiteId);
    const knowledge = validateKnowledgeSnapshot(snapshot.knowledge, { fallbackTimestamp: snapshot.exportedAt ?? now() });
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
    return { records, revisions, customFields, links, goalDependencies, knowledge };
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

  #migrateGoalData() {
    transaction(this.#db, () => {
      for (const row of this.#db.prepare("SELECT * FROM records WHERE category = 'goal'").all()) {
        const value = decryptJson(this.#key, row.payload, objectAad('record', row.id, row.revision, row.category));
        const data = goalDataWithoutLegacyText(value.data);
        if (data === value.data) continue;
        this.#db.prepare('UPDATE records SET payload = ? WHERE id = ?').run(
          encryptJson(this.#key, { ...value, data }, objectAad('record', row.id, row.revision, row.category)), row.id);
      }
      for (const row of this.#db.prepare("SELECT * FROM record_revisions WHERE category = 'goal'").all()) {
        const snapshot = decryptJson(this.#key, row.payload, objectAad('revision', row.record_id, row.revision, row.category));
        const data = goalDataWithoutLegacyText(snapshot.data);
        if (data === snapshot.data) continue;
        this.#db.prepare('UPDATE record_revisions SET payload = ? WHERE record_id = ? AND revision = ?').run(
          encryptJson(this.#key, { ...snapshot, data }, objectAad('revision', row.record_id, row.revision, row.category)),
          row.record_id, row.revision);
      }
    });
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

  #goalRecord(id) {
    const row = this.#recordRow(id);
    if (row.category !== 'goal') fail(400, 'GOAL_REQUIRED', 'Goal progression is only available for goals.');
    return this.#recordFromRow(row);
  }

  #goalProgress(id) {
    const children = this.#db.prepare("SELECT id FROM records WHERE category = 'goal' AND parent_id = ? AND trashed = 0 ORDER BY position").all(id);
    if (!children.length) {
      const goal = this.#goalRecord(id);
      return Number.isInteger(goal.data?.progress) ? goal.data.progress : 0;
    }
    return Math.round(children.reduce((total, child) => total + this.#goalProgress(child.id), 0) / children.length);
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

  #seedKnowledge() {
    if (this.#db.prepare('SELECT 1 FROM knowledge_metadata WHERE key = ?').get(KNOWLEDGE_SEED_KEY)) return false;
    const snapshot = createInitialKnowledgeSnapshot(now());
    transaction(this.#db, () => {
      for (const node of snapshot.nodes) {
        this.#db.prepare(`INSERT INTO knowledge_nodes
          (id, branch, parent_id, status, revision, created_at, updated_at, payload)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(node.id, node.branch, node.status, node.revision,
          node.createdAt, node.updatedAt, this.#encryptKnowledgeNode(node.id, node.revision, node.branch, node));
      }
      for (const entry of snapshot.metadata) this.#setKnowledgeMeta(entry.key, entry.value);
    });
    return true;
  }

  #knowledgeNodeRow(id) {
    const row = this.#db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(id);
    if (!row) fail(404, 'KNOWLEDGE_NODE_NOT_FOUND', `Node ${id} does not exist.`);
    return row;
  }

  #encryptKnowledgeNode(id, revision, branch, value) {
    return encryptJson(this.#key, { name: value.name, understanding: value.understanding, terms: value.terms },
      objectAad('knowledge-node', String(id), revision, branch));
  }

  #knowledgeNodeFromRow(row) {
    const value = decryptJson(this.#key, row.payload,
      objectAad('knowledge-node', String(row.id), row.revision, row.branch));
    return { id: row.id, name: value.name, branch: row.branch, parentId: row.parent_id,
      status: row.status, understanding: value.understanding ?? null, terms: value.terms ?? [],
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #assertUniqueKnowledgeSibling(name, branch, parentId, excludeId = undefined) {
    const key = name.normalize('NFKC').toLocaleLowerCase('en-US');
    const rows = this.#db.prepare(`SELECT * FROM knowledge_nodes
      WHERE branch = ? AND ((parent_id = ?) OR (parent_id IS NULL AND ? IS NULL))`).all(branch, parentId, parentId);
    if (rows.some((row) => row.id !== excludeId &&
      this.#knowledgeNodeFromRow(row).name.normalize('NFKC').toLocaleLowerCase('en-US') === key)) {
      fail(409, 'KNOWLEDGE_NODE_EXISTS', 'A node with this name already exists under that parent.');
    }
  }

  #touchKnowledgeNode(id, timestamp) {
    const row = this.#knowledgeNodeRow(id);
    const value = this.#knowledgeNodeFromRow(row);
    const revision = row.revision + 1;
    this.#db.prepare('UPDATE knowledge_nodes SET revision = ?, updated_at = ?, payload = ? WHERE id = ?')
      .run(revision, timestamp,
        this.#encryptKnowledgeNode(id, revision, row.branch, value), id);
  }

  #knowledgeIsDescendant(candidateId, ancestorId) {
    const result = this.#db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM knowledge_nodes WHERE parent_id = ?
      UNION ALL SELECT node.id FROM knowledge_nodes node JOIN descendants item ON node.parent_id = item.id
    ) SELECT 1 AS found FROM descendants WHERE id = ? LIMIT 1`).get(ancestorId, candidateId);
    return Boolean(result);
  }

  #moveKnowledgeDescendants(id, branch, timestamp) {
    const rows = this.#db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM knowledge_nodes WHERE parent_id = ?
      UNION ALL SELECT node.id FROM knowledge_nodes node JOIN descendants item ON node.parent_id = item.id
    ) SELECT knowledge_nodes.* FROM knowledge_nodes JOIN descendants USING(id)`).all(id);
    for (const row of rows) {
      const value = this.#knowledgeNodeFromRow(row);
      const revision = row.revision + 1;
      this.#db.prepare('UPDATE knowledge_nodes SET branch = ?, revision = ?, updated_at = ?, payload = ? WHERE id = ?')
        .run(branch, revision, timestamp, this.#encryptKnowledgeNode(row.id, revision, branch, value), row.id);
    }
  }

  #knowledgeMeta(key, payload) {
    return decryptJson(this.#key, payload, objectAad('knowledge-metadata', key, 1, 'knowledge')).value;
  }

  #setKnowledgeMeta(key, value) {
    this.#db.prepare(`INSERT INTO knowledge_metadata(key, payload) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload`).run(key,
      encryptJson(this.#key, { value }, objectAad('knowledge-metadata', key, 1, 'knowledge')));
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

  async #withLifecycle(operation) {
    const previous = this.#lifecycleTail;
    let release;
    this.#lifecycleTail = new Promise((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      if (this.#closed) fail(409, 'ATLAS_CLOSED', 'This Atlas instance is closed.');
      return await operation(this.#lifecycleGeneration);
    } finally {
      release();
    }
  }

  #assertLifecycle(generation) {
    if (generation !== this.#lifecycleGeneration) {
      fail(409, 'LIFECYCLE_CHANGED', 'Atlas lifecycle state changed while the operation was running.');
    }
  }

  #advanceLifecycle(generation) {
    this.#assertLifecycle(generation);
    this.#lifecycleGeneration += 1;
  }

  async #deriveConfiguredKey(passphrase, generation) {
    const config = this.#meta(KEY_CONFIG);
    const check = this.#meta(KEY_CHECK);
    if (!config || !check) fail(409, 'NOT_INITIALIZED', 'Atlas must be set up first.');
    const salt = Buffer.from(config.salt ?? '', 'base64');
    if (salt.length !== 16) fail(500, 'INVALID_ENCRYPTION_CONFIG', 'Stored encryption configuration is invalid.');
    const parameters = { ...config };
    delete parameters.salt;
    const key = await deriveKey(passphrase, salt, parameters);
    try {
      this.#assertLifecycle(generation);
      verifyKeyCheck(key, check);
      return key;
    } catch (error) {
      key.fill(0);
      if (error instanceof AtlasError && error.code === 'DATA_INTEGRITY_ERROR') {
        fail(401, 'INVALID_PASSPHRASE', 'The passphrase is incorrect.');
      }
      throw error;
    }
  }

  #copyTransientKey() {
    this.#requireUnlocked();
    const key = Buffer.from(this.#key);
    this.#transientKeys.add(key);
    return key;
  }

  #releaseTransientKey(key) {
    key.fill(0);
    this.#transientKeys.delete(key);
  }

  #lockState() {
    if (this.#key) this.#key.fill(0);
    this.#key = null;
    for (const key of this.#transientKeys) key.fill(0);
    this.#transientKeys.clear();
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
