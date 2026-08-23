import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Atlas, IMAGE_MAX_BYTES, IMAGE_MAX_PER_EXPERIENCE } from '../src/atlas.js';
import { BACKUP_V2_MAX_MANIFEST_BYTES, BACKUP_V3_MAGIC, createBackupEnvelope, deriveKey, encryptJson, objectAad, openBackupEnvelope } from '../src/crypto.js';
import { createServer, listen } from '../src/server.js';

const APP_PASSPHRASE = 'correct horse battery staple';
const BACKUP_PASSPHRASE = 'portable backup passphrase';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-test-'));
  const databasePath = join(directory, 'atlas.sqlite');
  const atlas = new Atlas({ databasePath });
  await atlas.setup(APP_PASSPHRASE);
  t.after(async () => {
    try { atlas.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  return { atlas, directory, databasePath };
}

function create(atlas, category, title, data, extra = {}) {
  return atlas.createRecord({ category, title, data, customFieldValues: {}, ...extra });
}

test('category contracts and person singleton are enforced', async (t) => {
  const { atlas } = await fixture(t);
  create(atlas, 'person', 'Me', {});
  assert.throws(() => create(atlas, 'person', 'Duplicate', {}), { code: 'PERSON_EXISTS' });
  assert.throws(() => create(atlas, 'experience', 'Bad period', { kind: 'period', startDate: '2026-13' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'experience', 'Bad ongoing', { kind: 'period', startDate: '2026', endDate: '2026-02', ongoing: true }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'goal', 'Bad goal', { horizon: 'someday' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'goal', 'Goal with status', { horizon: 'short', status: 'active' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'goal', 'Bad importance', { horizon: 'short', importance: 'urgent' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'goal', 'Legacy goal text', { horizon: 'short', progressNote: 'old' }), { code: 'VALIDATION_ERROR' });
  assert.equal(create(atlas, 'goal', 'Described goal', { horizon: 'short', description: 'Clear context', progress: 0 }).data.description, 'Clear context');
  assert.equal(create(atlas, 'goal', 'Default importance', { horizon: 'short' }).data.importance, 'medium');
  assert.throws(() => create(atlas, 'project', 'Old state field', { context: '', status: 'active', githubLink: '', currentState: '' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'project', 'Bad status', { context: '', status: 'in_progress', githubLink: '' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'project', 'Bad link', { context: '', status: 'active', githubLink: 'github.com/example/repo' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'resource', 'Cash', { quantity: 1, value: 10 }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'relationship', 'Unknown', { kind: 'place' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'relationship', 'Old person kind', { kind: 'person' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'preference', 'Theme', {}), { code: 'VALIDATION_ERROR' });
  assert.equal(create(atlas, 'experience', 'Launch', { kind: 'event', startDate: '2026-08-04' }).revision, 1);
  const project = create(atlas, 'project', 'Atlas', { context: '', status: 'active', githubLink: 'https://github.com/example/atlas' });
  assert.equal(project.category, 'project');
  assert.deepEqual(project.data, { context: '', status: 'active', githubLink: 'https://github.com/example/atlas' });
  for (const status of ['planned', 'paused', 'completed', 'abandoned']) {
    assert.equal(create(atlas, 'project', status, { context: '', status, githubLink: '' }).data.status, status);
  }
  assert.equal(create(atlas, 'resource', 'Workshop', { kind: 'capital', availability: 'available' }).category, 'resource');
  assert.equal(create(atlas, 'relationship', 'Studio', { kind: 'org' }).category, 'relationship');
  for (const kind of ['family', 'partner', 'friend', 'acquaintance', 'coworker', 'mentor']) {
    assert.equal(create(atlas, 'relationship', kind, { kind }).data.kind, kind);
  }
});

test('numbered migrations are idempotent across reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-migration-test-'));
  const databasePath = join(directory, 'atlas.sqlite');
  const first = new Atlas({ databasePath });
  await first.setup(APP_PASSPHRASE);
  assert.deepEqual(first.database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    .map((row) => row.version), [1, 2, 3, 4, 5, 6, 7]);
  first.close();
  const reopened = new Atlas({ databasePath });
  assert.deepEqual(reopened.status(), { initialized: true, locked: true });
  reopened.close();
  await rm(directory, { recursive: true, force: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test('unlock migrates the removed person relationship kind to family once', async (t) => {
  const { atlas } = await fixture(t);
  const relationship = create(atlas, 'relationship', 'Parent', { kind: 'family', relationshipType: 'Mother' });
  const config = JSON.parse(atlas.database.prepare("SELECT value FROM metadata WHERE key = 'encryption-config'").get().value);
  const salt = Buffer.from(config.salt, 'base64');
  delete config.salt;
  const key = await deriveKey(APP_PASSPHRASE, salt, config);
  const legacyContent = {
    title: relationship.title,
    data: { ...relationship.data, kind: 'person' },
    customFieldValues: relationship.customFieldValues,
  };
  atlas.database.prepare('UPDATE records SET payload = ? WHERE id = ?').run(
    encryptJson(key, legacyContent, objectAad('record', relationship.id, relationship.revision, relationship.category)),
    relationship.id,
  );
  key.fill(0);

  atlas.lock();
  await atlas.unlock(APP_PASSPHRASE);
  const migrated = atlas.getRecord(relationship.id);
  assert.equal(migrated.data.kind, 'family');
  assert.equal(migrated.revision, 2);
  atlas.lock();
  await atlas.unlock(APP_PASSPHRASE);
  assert.equal(atlas.getRecord(relationship.id).revision, 2);
});

test('unlock purges legacy goal text fields into description across current data and history', async (t) => {
  const { atlas } = await fixture(t);
  const goal = create(atlas, 'goal', 'Legacy text', { horizon: 'short', description: '', progress: 0 });
  const config = JSON.parse(atlas.database.prepare("SELECT value FROM metadata WHERE key = 'encryption-config'").get().value);
  const salt = Buffer.from(config.salt, 'base64');
  delete config.salt;
  const key = await deriveKey(APP_PASSPHRASE, salt, config);
  const legacyData = { horizon: 'short', progress: 0, motivation: 'Why it matters', progressNote: 'Halfway there' };
  atlas.database.prepare('UPDATE records SET payload = ? WHERE id = ?').run(
    encryptJson(key, { title: goal.title, data: legacyData, customFieldValues: {} },
      objectAad('record', goal.id, 1, 'goal')),
    goal.id,
  );
  atlas.database.prepare('UPDATE record_revisions SET payload = ? WHERE record_id = ? AND revision = 1').run(
    encryptJson(key, { category: 'goal', title: goal.title, data: legacyData, customFieldValues: {},
      parentId: null, position: 0, trashed: false }, objectAad('revision', goal.id, 1, 'goal')),
    goal.id,
  );
  key.fill(0);

  atlas.lock();
  await atlas.unlock(APP_PASSPHRASE);
  assert.deepEqual(atlas.getRecord(goal.id).data, {
    horizon: 'short', progress: 0, description: 'Why it matters\n\nHalfway there', importance: 'medium',
  });
  assert.deepEqual(atlas.listRevisions(goal.id)[0].data, {
    horizon: 'short', progress: 0, description: 'Why it matters\n\nHalfway there', importance: 'medium',
  });
});

test('knowledge is seeded once, encrypted at rest, and preserves hierarchy invariants', async (t) => {
  const { atlas, databasePath } = await fixture(t);
  assert.equal(atlas.listKnowledgeNodes().length, 50);
  const root = atlas.createKnowledgeNode({ name: 'Private sentinel topic', branch: 'subjects',
    status: 'known', understanding: 'Private sentinel explanation', terms: [] });
  assert.throws(() => atlas.createKnowledgeNode({ name: 'Typo', branch: 'subjects', statuz: 'known' }),
    { code: 'UNEXPECTED_FIELD' });
  assert.throws(() => atlas.patchKnowledgeNode(root.id, { understandng: 'Typo' }),
    { code: 'UNEXPECTED_FIELD' });
  const child = atlas.createKnowledgeNode({ name: 'Nested topic', branch: 'subjects', parentId: root.id });
  assert.equal(child.parentId, root.id);
  assert.throws(() => atlas.createKnowledgeNode({ name: 'nested TOPIC', branch: 'subjects', parentId: root.id }),
    { code: 'KNOWLEDGE_NODE_EXISTS' });
  assert.throws(() => atlas.patchKnowledgeNode(root.id, { status: 'unknown' }),
    { code: 'CHILDREN_REQUIRE_KNOWN_PARENT' });
  atlas.patchKnowledgeNode(child.id, { status: 'known', understanding: 'Known child' });
  assert.throws(() => atlas.patchKnowledgeNode(root.id, { parentId: child.id }), { code: 'KNOWLEDGE_CYCLE' });
  assert.throws(() => atlas.deleteKnowledgeNode(root.id), { code: 'NODE_HAS_CHILDREN' });
  const connection = atlas.createKnowledgeConnection({ sourceId: root.id, targetId: child.id });
  assert.equal(atlas.getKnowledgeNode(root.id).connections[0].id, connection.id);
  atlas.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = await readFile(databasePath);
  assert.equal(bytes.includes(Buffer.from('Private sentinel topic')), false);
  assert.equal(bytes.includes(Buffer.from('Private sentinel explanation')), false);
  atlas.lock();
  await atlas.unlock(APP_PASSPHRASE);
  assert.equal(atlas.listKnowledgeNodes().length, 52);
});

test('knowledge round-trips in backups and legacy backups receive the standard taxonomy', async (t) => {
  const { atlas, directory } = await fixture(t);
  const root = atlas.createKnowledgeNode({ name: 'Portable knowledge', branch: 'ideologies',
    status: 'known', understanding: 'Portable explanation', terms: [{ id: 'portable', label: 'Portable', definition: 'Moves safely.' }] });
  const portable = await atlas.export(BACKUP_PASSPHRASE);
  const destination = new Atlas({ databasePath: join(directory, 'knowledge-destination.sqlite') });
  await destination.setup(APP_PASSPHRASE);
  const replacedParent = destination.createKnowledgeNode({ name: 'Replaced parent', branch: 'subjects',
    status: 'known', understanding: 'Will be replaced', terms: [] });
  destination.createKnowledgeNode({ name: 'Replaced child', branch: 'subjects', parentId: replacedParent.id });
  await destination.import(BACKUP_PASSPHRASE, portable);
  assert.equal(destination.getKnowledgeNode(root.id).understanding, 'Portable explanation');

  const legacySnapshot = await openBackupEnvelope(BACKUP_PASSPHRASE, portable);
  const invalidSnapshot = structuredClone(legacySnapshot);
  invalidSnapshot.knowledge.nodes.find((node) => node.id === root.id).parentId = 999999;
  await assert.rejects(destination.import(BACKUP_PASSPHRASE,
    await createBackupEnvelope(BACKUP_PASSPHRASE, invalidSnapshot)), { code: 'INVALID_BACKUP' });
  assert.equal(destination.getKnowledgeNode(root.id).understanding, 'Portable explanation');
  delete legacySnapshot.knowledge;
  const legacyEnvelope = await createBackupEnvelope(BACKUP_PASSPHRASE, legacySnapshot);
  await destination.import(BACKUP_PASSPHRASE, legacyEnvelope);
  assert.equal(destination.listKnowledgeNodes().length, 50);
  destination.close();
});

test('opening Atlas purges the retired agent-key verifier metadata', async (t) => {
  const { atlas, databasePath } = await fixture(t);
  atlas.database.prepare("INSERT INTO metadata(key, value) VALUES ('agent-key', ?)")
    .run(JSON.stringify({ verifier: 'legacy', prefix: 'atlas_legacy', createdAt: '2026-08-10T00:00:00.000Z' }));
  atlas.close();
  const reopened = new Atlas({ databasePath });
  assert.equal(reopened.database.prepare("SELECT 1 FROM metadata WHERE key = 'agent-key'").get(), undefined);
  reopened.close();
});

test('user content is encrypted and tampering and wrong passphrases fail closed', async (t) => {
  const { atlas, databasePath } = await fixture(t);
  const sentinel = 'PLAINTEXT_SENTINEL_9dca8f';
  const record = create(atlas, 'preference', sentinel, { value: `value-${sentinel}` });
  atlas.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = await readFile(databasePath);
  assert.equal(bytes.includes(Buffer.from(sentinel)), false);
  atlas.lock();
  await assert.rejects(atlas.unlock('this is the wrong passphrase'), { code: 'INVALID_PASSPHRASE' });
  await atlas.unlock(APP_PASSPHRASE);
  const row = atlas.database.prepare('SELECT payload FROM records WHERE id = ?').get(record.id);
  const envelope = JSON.parse(row.payload);
  envelope.tag = `${envelope.tag.slice(0, -2)}AA`;
  atlas.database.prepare('UPDATE records SET payload = ? WHERE id = ?').run(JSON.stringify(envelope), record.id);
  assert.throws(() => atlas.getRecord(record.id), { code: 'DATA_INTEGRITY_ERROR' });
});

test('locking removes access to protected operations', async (t) => {
  const { atlas } = await fixture(t);
  create(atlas, 'preference', 'Theme', { value: 'dark' });
  atlas.lock();
  assert.throws(() => atlas.listRecords(), { status: 423, code: 'LOCKED' });
  assert.deepEqual(atlas.status(), { initialized: true, locked: true });
});

test('lifecycle transitions serialize setup and invalidate an unlock overtaken by lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-lifecycle-test-'));
  const atlas = new Atlas({ databasePath: join(directory, 'atlas.sqlite') });
  t.after(async () => {
    try { atlas.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  const alternatePassphrase = 'alternate concurrent setup passphrase';
  const results = await Promise.allSettled([atlas.setup(APP_PASSPHRASE), atlas.setup(alternatePassphrase)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'ALREADY_INITIALIZED');
  const winningPassphrase = results[0].status === 'fulfilled' ? APP_PASSPHRASE : alternatePassphrase;
  const record = create(atlas, 'preference', 'Still decryptable', { value: 'after concurrent setup' });
  atlas.lock();
  const pendingUnlock = atlas.unlock(winningPassphrase);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  atlas.lock();
  await assert.rejects(pendingUnlock, { code: 'LIFECYCLE_CHANGED' });
  assert.deepEqual(atlas.status(), { initialized: true, locked: true });
  await atlas.unlock(winningPassphrase);
  assert.equal(atlas.getRecord(record.id).title, 'Still decryptable');
  const pendingClear = atlas.clearAll(winningPassphrase);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  atlas.lock();
  await assert.rejects(pendingClear, { code: 'LIFECYCLE_CHANGED' });
  await atlas.unlock(winningPassphrase);
  assert.equal(atlas.getRecord(record.id).title, 'Still decryptable');
});

test('database lease prevents a second instance from deleting active staging', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-lease-test-'));
  const databasePath = join(directory, 'atlas.sqlite');
  const atlas = new Atlas({ databasePath });
  await atlas.setup(APP_PASSPHRASE);
  t.after(async () => {
    try { atlas.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  const staged = await atlas.stageImportUpload([Buffer.from('active staged upload')]);
  assert.throws(() => new Atlas({ databasePath }), { code: 'ATLAS_INSTANCE_ACTIVE' });
  assert.deepEqual(await readFile(join(`${databasePath}.imports`, `${staged.uploadId}.upload`)), Buffer.from('active staged upload'));
  await atlas.cancelImportUpload(staged.uploadId);
  atlas.close();
  const reopened = new Atlas({ databasePath });
  reopened.close();
});

test('database lease is exclusive across Atlas processes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-process-lease-test-'));
  const databasePath = join(directory, 'atlas.sqlite');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { Atlas } from './src/atlas.js';
    const atlas = new Atlas({ databasePath: process.argv[1] });
    process.send('ready');
    process.on('message', () => { atlas.close(); process.exit(0); });
  `, databasePath], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await new Promise((resolvePromise, reject) => {
    const onMessage = (message) => { cleanup(); resolvePromise(message); };
    const onExit = (code) => { cleanup(); reject(new Error(`Lease child exited early with ${code}.`)); };
    const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit); };
    child.once('message', onMessage);
    child.once('exit', onExit);
  });
  assert.equal(ready, 'ready');
  assert.throws(() => new Atlas({ databasePath }), { code: 'ATLAS_INSTANCE_ACTIVE' });
  child.send('close');
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0);
  const reopened = new Atlas({ databasePath });
  reopened.close();
});

test('clear all verifies the current passphrase and returns Atlas to first-time setup', async (t) => {
  const { atlas } = await fixture(t);
  const record = create(atlas, 'preference', 'Keep until authenticated', { value: 'private' });
  atlas.createCustomField({ category: 'preference', name: 'Private note', type: 'text' });
  const staged = await atlas.stageImportUpload([Buffer.from('staged encrypted backup')]);

  await assert.rejects(atlas.clearAll('this is the wrong passphrase'), { code: 'INVALID_PASSPHRASE' });
  assert.equal(atlas.getRecord(record.id).title, 'Keep until authenticated');

  assert.deepEqual(await atlas.clearAll(APP_PASSPHRASE), { initialized: false, locked: true });
  const clearedTables = [
    'metadata', 'records', 'record_revisions', 'custom_fields', 'links', 'record_images',
    'goal_dependencies', 'subgoal_requests', 'knowledge_nodes', 'knowledge_connections', 'knowledge_metadata',
  ];
  for (const table of clearedTables) {
    assert.equal(atlas.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.equal(atlas.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 7);
  await assert.rejects(atlas.unlock(APP_PASSPHRASE), { code: 'NOT_INITIALIZED' });

  const newPassphrase = 'a completely new atlas passphrase';
  assert.deepEqual(await atlas.setup(newPassphrase), { initialized: true, locked: false });
  await assert.rejects(atlas.cancelImportUpload(staged.uploadId), { code: 'IMPORT_UPLOAD_NOT_FOUND' });
  assert.deepEqual(atlas.listRecords(), []);
  assert.equal(atlas.listKnowledgeNodes().length, 50);
  atlas.lock();
  await assert.rejects(atlas.unlock(APP_PASSPHRASE), { code: 'INVALID_PASSPHRASE' });
  await atlas.unlock(newPassphrase);
});

test('goal sibling order, moves, cycle rejection, and conservative trash remain coherent', async (t) => {
  const { atlas } = await fixture(t);
  const first = create(atlas, 'goal', 'First', { horizon: 'short' });
  const second = create(atlas, 'goal', 'Second', { horizon: 'short' }, { position: 0 });
  assert.deepEqual(atlas.listRecords({ category: 'goal' }).map((goal) => [goal.title, goal.position]), [
    ['Second', 0], ['First', 1],
  ]);
  const moved = atlas.patchRecord(first.id, { revision: first.revision, position: 0 });
  assert.equal(moved.position, 0);
  assert.deepEqual(atlas.listRecords({ category: 'goal' }).map((goal) => goal.title), ['First', 'Second']);
  const child = create(atlas, 'goal', 'Child', { horizon: 'short' }, { parentId: first.id });
  assert.throws(() => atlas.patchRecord(first.id, { revision: moved.revision, parentId: child.id }), { code: 'GOAL_CYCLE' });
  assert.throws(() => atlas.trashRecord(first.id, moved.revision), { code: 'GOAL_HAS_ACTIVE_CHILDREN' });
  const trashedChild = atlas.trashRecord(child.id, child.revision);
  assert.equal(trashedChild.trashed, true);
  const trashedParent = atlas.trashRecord(first.id, moved.revision);
  assert.equal(trashedParent.trashed, true);
});

test('goal progression is a sibling DAG with recursive progress roll-up and portable edges', async (t) => {
  const { atlas, directory } = await fixture(t);
  const root = create(atlas, 'goal', 'Final outcome', { horizon: 'long', progress: 3 });
  const first = create(atlas, 'goal', 'Foundation', { horizon: 'short', progress: 20 }, { parentId: root.id });
  const second = create(atlas, 'goal', 'Build', { horizon: 'middle', progress: 60 }, { parentId: root.id });
  const third = create(atlas, 'goal', 'Launch', { horizon: 'middle', progress: 100 }, { parentId: root.id });
  const nested = create(atlas, 'goal', 'Foundation checkpoint', { horizon: 'short', progress: 80 }, { parentId: first.id });
  assert.equal(atlas.getRecord(nested.id).parentGoal.title, 'Foundation');
  assert.equal(atlas.getRecord(root.id).parentGoal, undefined);
  atlas.createGoalDependency(second.id, first.id);
  atlas.createGoalDependency(third.id, second.id);

  const graph = atlas.getGoalGraph(root.id);
  assert.equal(graph.goal.progress, 80);
  assert.deepEqual(graph.nodes.map((goal) => [goal.title, goal.progress]), [
    ['Foundation', 80], ['Build', 60], ['Launch', 100],
  ]);
  assert.deepEqual(graph.dependencies.map((edge) => [edge.goalId, edge.prerequisiteId]), [
    [second.id, first.id], [third.id, second.id],
  ]);
  assert.throws(() => atlas.createGoalDependency(first.id, third.id), { code: 'GOAL_DEPENDENCY_CYCLE' });
  assert.throws(() => atlas.createGoalDependency(nested.id, second.id), { code: 'INVALID_GOAL_DEPENDENCY' });

  const portable = await atlas.export(BACKUP_PASSPHRASE);
  const destinationPath = join(directory, 'destination.sqlite');
  const destination = new Atlas({ databasePath: destinationPath });
  await destination.setup(APP_PASSPHRASE);
  await destination.import(BACKUP_PASSPHRASE, portable);
  assert.deepEqual(destination.getGoalGraph(root.id).nodes.map((goal) => goal.title), ['Foundation', 'Build', 'Launch']);
  assert.deepEqual(destination.getGoalGraph(root.id).dependencies.map((edge) => [edge.goalId, edge.prerequisiteId]), [
    [second.id, first.id], [third.id, second.id],
  ]);
  destination.close();

  const moved = atlas.patchRecord(second.id, { revision: second.revision, parentId: first.id });
  assert.equal(moved.parentId, first.id);
  assert.equal(atlas.getGoalGraph(root.id).dependencies.length, 0);
});

test('subgoal creation is transactional and idempotent with prerequisite edges', async (t) => {
  const { atlas } = await fixture(t);
  const root = create(atlas, 'goal', 'Atomic progression', { horizon: 'long' });
  const prerequisite = create(atlas, 'goal', 'First step', { horizon: 'short', progress: 100 }, { parentId: root.id });
  const request = {
    requestId: '11111111-1111-4111-8111-111111111111',
    title: 'Second step',
    data: { horizon: 'short', importance: 'medium', targetDate: '', description: '', progress: 0 },
    customFieldValues: {}, prerequisiteIds: [prerequisite.id],
  };
  const created = atlas.createSubgoal(root.id, request);
  assert.equal(created.created, true);
  assert.deepEqual(atlas.getGoalGraph(root.id).dependencies.map((edge) => [edge.goalId, edge.prerequisiteId]), [
    [created.record.id, prerequisite.id],
  ]);
  const replayed = atlas.createSubgoal(root.id, request);
  assert.equal(replayed.created, false);
  assert.equal(replayed.record.id, created.record.id);
  assert.equal(atlas.getGoalGraph(root.id).nodes.filter((node) => node.title === 'Second step').length, 1);
  assert.throws(() => atlas.createSubgoal(root.id, { ...request, title: 'Different request' }),
    { code: 'IDEMPOTENCY_CONFLICT' });

  atlas.database.exec(`CREATE TRIGGER reject_test_subgoal_dependency BEFORE INSERT ON goal_dependencies
    BEGIN SELECT RAISE(ABORT, 'forced dependency failure'); END;`);
  const before = atlas.getGoalGraph(root.id).nodes.length;
  assert.throws(() => atlas.createSubgoal(root.id, {
    ...request, requestId: '22222222-2222-4222-8222-222222222222', title: 'Must roll back',
  }));
  atlas.database.exec('DROP TRIGGER reject_test_subgoal_dependency;');
  assert.equal(atlas.getGoalGraph(root.id).nodes.length, before);
  assert.equal(atlas.database.prepare('SELECT COUNT(*) AS count FROM subgoal_requests').get().count, 1);
});

test('optimistic edits, no-ops, revisions, and historical restore work', async (t) => {
  const { atlas } = await fixture(t);
  const original = create(atlas, 'preference', 'Theme', { value: 'dark' });
  const noOp = atlas.patchRecord(original.id, { revision: 1 });
  assert.equal(noOp.revision, 1);
  const edited = atlas.patchRecord(original.id, { revision: 1, title: 'Color theme' });
  assert.equal(edited.revision, 2);
  assert.throws(() => atlas.patchRecord(original.id, { revision: 1, title: 'stale' }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(atlas.listRevisions(original.id).map((revision) => revision.revision), [2, 1]);
  const restored = atlas.restoreRevision(original.id, 1, 2);
  assert.equal(restored.title, 'Theme');
  assert.equal(restored.revision, 3);
});

test('typed custom fields and encrypted links are included in record detail', async (t) => {
  const { atlas, databasePath } = await fixture(t);
  const field = atlas.createCustomField({ category: 'person', name: 'Favorite color', type: 'singleChoice', options: ['blue', 'green'] });
  const person = atlas.createRecord({ category: 'person', title: 'Me', data: {}, customFieldValues: { [field.id]: 'blue' } });
  const deletedField = atlas.deleteCustomField(field.id);
  assert.equal(deletedField.deleted, true);
  assert.equal(deletedField.recordsUpdated, 1);
  assert.equal(deletedField.revisionsUpdated, 1);
  assert.equal(atlas.listCustomFields({ category: 'person' }).length, 0);
  assert.deepEqual(atlas.getRecord(person.id).customFieldValues, {});
  assert.deepEqual(atlas.listRevisions(person.id)[0].customFieldValues, {});
  assert.equal(atlas.listCustomFields({ category: 'goal' }).length, 0);
  assert.throws(() => atlas.patchRecord(person.id, {
    revision: person.revision, customFieldValues: { [field.id]: 'green' },
  }), { code: 'VALIDATION_ERROR' });
  const renamed = atlas.patchRecord(person.id, { revision: person.revision, title: 'Me again' });
  assert.equal(renamed.title, 'Me again');
  assert.throws(() => atlas.patchRecord(person.id, { revision: renamed.revision,
    customFieldValues: { [field.id]: 'green' } }), { code: 'VALIDATION_ERROR' });
  const preference = create(atlas, 'preference', 'Color', { value: 'blue' });
  const link = atlas.createLink({ sourceId: person.id, targetId: preference.id, type: 'supports', label: 'explains', notes: 'private note' });
  assert.equal(atlas.getRecord(person.id).links[0].label, 'explains');
  assert.equal(atlas.getRecord(preference.id).backlinks[0].id, link.id);
  assert.deepEqual(atlas.deleteLink(link.id), { deleted: true });
  assert.equal(atlas.getRecord(person.id).links.length, 0);
  assert.equal(atlas.getRecord(preference.id).backlinks.length, 0);
  assert.throws(() => atlas.createLink({ sourceId: person.id, targetId: person.id }), { code: 'VALIDATION_ERROR' });
  atlas.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = await readFile(databasePath);
  for (const privateText of ['Favorite color', 'explains', 'private note']) {
    assert.equal(bytes.includes(Buffer.from(privateText)), false);
  }
});

test('custom field edits preserve unique names and restorable revision values', async (t) => {
  const { atlas } = await fixture(t);
  const choice = atlas.createCustomField({ category: 'preference', name: 'Choice', type: 'singleChoice', options: ['old', 'new'] });
  const other = atlas.createCustomField({ category: 'preference', name: 'Other', type: 'text' });
  assert.throws(() => atlas.patchCustomField(other.id, { name: 'cHoIcE' }), { code: 'CUSTOM_FIELD_EXISTS' });

  const original = atlas.createRecord({ category: 'preference', title: 'Setting', data: { value: 'example' },
    customFieldValues: { [choice.id]: 'old' } });
  atlas.patchRecord(original.id, { revision: original.revision, customFieldValues: { [choice.id]: 'new' } });
  assert.throws(() => atlas.patchCustomField(choice.id, { options: ['new'] }), { code: 'VALIDATION_ERROR' });
  assert.equal(atlas.restoreRevision(original.id, 1).customFieldValues[choice.id], 'old');
});

test('legacy backups reject unsupported KDF cost before deriving a key', async () => {
  const envelope = await createBackupEnvelope(BACKUP_PASSPHRASE, { format: 'test' });
  const expensive = structuredClone(envelope);
  expensive.kdf.N *= 2;
  await assert.rejects(openBackupEnvelope(BACKUP_PASSPHRASE, expensive), { code: 'INVALID_BACKUP' });
});

test('unused custom fields are deleted rather than archived', async (t) => {
  const { atlas } = await fixture(t);
  const field = atlas.createCustomField({ category: 'goal', name: 'Theme', type: 'text' });
  const result = atlas.deleteCustomField(field.id);
  assert.equal(result.deleted, true);
  assert.equal(result.recordsUpdated, 0);
  assert.equal(result.revisionsUpdated, 0);
  assert.equal(atlas.listCustomFields({ category: 'goal' }).length, 0);
  assert.throws(() => atlas.deleteCustomField(field.id), { code: 'CUSTOM_FIELD_NOT_FOUND' });
});

test('empty trash permanently deletes records and cascades their related data', async (t) => {
  const { atlas } = await fixture(t);
  const removed = create(atlas, 'preference', 'Temporary', { value: 'remove me' });
  const retained = create(atlas, 'preference', 'Keep', { value: 'stay' });
  const parent = create(atlas, 'goal', 'Removed parent', { horizon: 'short' });
  const child = create(atlas, 'goal', 'Removed child', { horizon: 'short' }, { parentId: parent.id });
  atlas.createLink({ sourceId: retained.id, targetId: removed.id, label: 'temporary link' });
  atlas.trashRecord(removed.id, removed.revision);
  atlas.trashRecord(child.id, child.revision);
  atlas.trashRecord(parent.id, parent.revision);

  assert.deepEqual(atlas.emptyTrash(), { deleted: 3 });
  assert.deepEqual(atlas.emptyTrash(), { deleted: 0 });
  assert.deepEqual(atlas.listRecords({ trashed: 'all' }).map((record) => record.id), [retained.id]);
  assert.equal(atlas.getRecord(retained.id).links.length, 0);
  assert.throws(() => atlas.getRecord(removed.id), { code: 'RECORD_NOT_FOUND' });
  assert.equal(atlas.database.prepare('SELECT COUNT(*) AS count FROM record_revisions WHERE record_id = ?').get(removed.id).count, 0);
});

test('person predefined fields validate without rejecting legacy-compatible data', async (t) => {
  const { atlas } = await fixture(t);
  const data = {
    preferredName: 'Jo', gender: 'non-binary', birthDate: '1990-04', birthPlace: 'Toronto',
    nationalities: ['Canadian', 'Irish'], languages: ['English', 'French'], maritalStatus: 'partnered',
    emails: ['jo@example.test', 'work@example.test'], phoneNumbers: ['+1 555 0100'],
    address: 'Private address', summary: 'A private portrait', notes: 'Profile note',
    passportNumber: 'P-001', nationalIdNumber: 'N-002', driversLicenseNumber: 'D-003', taxIdNumber: 'T-004',
    contact: '', status: '', futureCompatibleField: { retained: true },
  };
  const person = create(atlas, 'person', 'Jo Example', data);
  assert.deepEqual(person.data.nationalities, ['Canadian', 'Irish']);
  assert.equal(person.data.futureCompatibleField.retained, true);
  assert.throws(() => atlas.patchRecord(person.id, { revision: person.revision, data: { ...data, birthDate: '1990-13' } }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => atlas.patchRecord(person.id, { revision: person.revision, data: { ...data, emails: ['valid@example.test', ''] } }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => atlas.patchRecord(person.id, { revision: person.revision, data: { ...data, languages: 'English' } }), { code: 'VALIDATION_ERROR' });
});

const PNG_PREFIX = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngBytes(value = 'image') { return Buffer.concat([PNG_PREFIX, Buffer.from(value)]); }

test('experience images are encrypted, bounded, trash-safe, and revision-independent', async (t) => {
  const { atlas, databasePath } = await fixture(t);
  const experience = create(atlas, 'experience', 'Gallery', { kind: 'event', startDate: '2026-08-05', narrative: 'Memory' });
  const sentinel = 'IMAGE_PLAINTEXT_SENTINEL_43db';
  const bytes = pngBytes(sentinel);
  const image = atlas.createImage(experience.id, { filename: 'private-sentinel.png', mimeType: 'image/png', bytes });
  assert.deepEqual(atlas.listImages(experience.id), [image]);
  const content = atlas.getImageContent(image.id);
  assert.deepEqual(content.bytes, bytes);
  content.bytes.fill(0);
  assert.equal(atlas.getRecord(experience.id).revision, experience.revision);
  assert.throws(() => atlas.createImage(experience.id, { filename: 'wrong.png', mimeType: 'image/jpeg', bytes }), { code: 'IMAGE_TYPE_MISMATCH' });
  assert.throws(() => atlas.createImage(experience.id, { filename: 'large.png', mimeType: 'image/png', bytes: Buffer.alloc(IMAGE_MAX_BYTES + 1) }), { code: 'VALIDATION_ERROR' });
  const person = create(atlas, 'person', 'No gallery', {});
  assert.throws(() => atlas.createImage(person.id, { filename: 'no.png', mimeType: 'image/png', bytes }), { code: 'IMAGES_REQUIRE_EXPERIENCE' });
  atlas.trashRecord(experience.id, experience.revision);
  assert.equal(atlas.listImages(experience.id).length, 1);
  atlas.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const databaseBytes = await readFile(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from(sentinel)), false);
  assert.equal(databaseBytes.includes(Buffer.from('private-sentinel.png')), false);
  assert.deepEqual(atlas.deleteImage(image.id), { deleted: true });
  assert.equal(atlas.listImages(experience.id).length, 0);
});

test('experience image count limit is enforced with contiguous upload order', async (t) => {
  const { atlas } = await fixture(t);
  const experience = create(atlas, 'experience', 'Many images', { kind: 'event', startDate: '2026' });
  for (let index = 0; index < IMAGE_MAX_PER_EXPERIENCE; index += 1) {
    const image = atlas.createImage(experience.id, { filename: `${index}.png`, mimeType: 'image/png', bytes: pngBytes(String(index)) });
    assert.equal(image.position, index);
  }
  assert.throws(() => atlas.createImage(experience.id, { filename: 'overflow.png', mimeType: 'image/png', bytes: pngBytes('overflow') }), { code: 'IMAGE_LIMIT_REACHED' });
  const middle = atlas.listImages(experience.id)[20];
  atlas.deleteImage(middle.id);
  assert.deepEqual(atlas.listImages(experience.id).map((image) => image.position), Array.from({ length: IMAGE_MAX_PER_EXPERIENCE - 1 }, (_, index) => index));
});

test('experience image byte limit accepts the exact boundary', async (t) => {
  const { atlas } = await fixture(t);
  const experience = create(atlas, 'experience', 'Large original', { kind: 'event', startDate: '2026' });
  const bytes = Buffer.alloc(IMAGE_MAX_BYTES);
  PNG_PREFIX.copy(bytes);
  const image = atlas.createImage(experience.id, { filename: 'large-original.png', mimeType: 'image/png', bytes });
  assert.equal(image.byteLength, IMAGE_MAX_BYTES);
  const content = atlas.getImageContent(image.id);
  assert.equal(content.bytes.length, IMAGE_MAX_BYTES);
  assert.deepEqual(content.bytes.subarray(0, PNG_PREFIX.length), PNG_PREFIX);
  content.bytes.fill(0);
});

async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('framed v3 backups exceed the legacy manifest ceiling and import incrementally', async (t) => {
  const source = await fixture(t);
  const value = 'x'.repeat(512 * 1024);
  for (let index = 0; index < 17; index += 1) {
    create(source.atlas, 'preference', `Large preference ${index}`, { value });
  }
  const exported = await source.atlas.exportV3(BACKUP_PASSPHRASE);
  const backup = await collect(exported.stream);
  assert.equal(backup.subarray(0, BACKUP_V3_MAGIC.length).equals(BACKUP_V3_MAGIC), true);
  assert.ok(backup.length > BACKUP_V2_MAX_MANIFEST_BYTES);

  const destination = await fixture(t);
  const staged = await destination.atlas.stageImportUpload([backup]);
  assert.deepEqual(await destination.atlas.commitImportUpload(staged.uploadId, BACKUP_PASSPHRASE), {
    imported: true, records: 17, images: 0,
  });
  assert.equal(destination.atlas.listRecords({ category: 'preference' }).length, 17);
  assert.equal(destination.atlas.listRecords({ category: 'preference' })[0].data.value.length, value.length);

  const retained = create(destination.atlas, 'preference', 'Retained after tamper', { value: true });
  const tampered = Buffer.from(backup);
  tampered[tampered.length - 32] ^= 0xff;
  const badStage = await destination.atlas.stageImportUpload([tampered]);
  await assert.rejects(destination.atlas.commitImportUpload(badStage.uploadId, BACKUP_PASSPHRASE),
    { code: 'INVALID_BACKUP_PASSPHRASE' });
  assert.equal(destination.atlas.getRecord(retained.id).title, 'Retained after tamper');

  const interruptedStage = await destination.atlas.stageImportUpload([backup]);
  const interruptedCommit = destination.atlas.commitImportUpload(interruptedStage.uploadId, BACKUP_PASSPHRASE);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  destination.atlas.lock();
  await assert.rejects(interruptedCommit, { code: 'LIFECYCLE_CHANGED' });
  await destination.atlas.unlock(APP_PASSPHRASE);
  assert.equal(destination.atlas.getRecord(retained.id).title, 'Retained after tamper');
});

test('streamed v2 backup round-trips images and rejects tampering atomically', async (t) => {
  const source = await fixture(t);
  const experience = create(source.atlas, 'experience', 'Portable gallery', { kind: 'event', startDate: '2026-08-05' });
  const originalBytes = pngBytes('portable-image-content');
  source.atlas.createImage(experience.id, { filename: 'portable.png', mimeType: 'image/png', bytes: originalBytes });
  const exported = await source.atlas.exportV2(BACKUP_PASSPHRASE);
  assert.equal(exported.contentType, 'application/vnd.eidolon-atlas-backup');
  const backup = await collect(exported.stream);
  assert.equal(backup.length, exported.byteLength);

  const destination = await fixture(t);
  const preserved = create(destination.atlas, 'preference', 'Preserved before import', { value: true });
  const staged = await destination.atlas.stageImportUpload([backup]);
  const result = await destination.atlas.commitImportUpload(staged.uploadId, BACKUP_PASSPHRASE);
  assert.deepEqual(result, { imported: true, records: 1, images: 1 });
  const imported = destination.atlas.listRecords({ category: 'experience' })[0];
  const importedImage = destination.atlas.listImages(imported.id)[0];
  const importedContent = destination.atlas.getImageContent(importedImage.id);
  assert.deepEqual(importedContent.bytes, originalBytes);
  importedContent.bytes.fill(0);
  assert.throws(() => destination.atlas.listImages(preserved.id), { code: 'RECORD_NOT_FOUND' });

  const keep = create(destination.atlas, 'preference', 'Keep after tamper', { value: 'unchanged' });
  const tampered = Buffer.from(backup);
  tampered[tampered.length - 20] ^= 0xff;
  const badStage = await destination.atlas.stageImportUpload([tampered]);
  await assert.rejects(destination.atlas.commitImportUpload(badStage.uploadId, BACKUP_PASSPHRASE), { code: 'INVALID_BACKUP_PASSPHRASE' });
  assert.equal(destination.atlas.getRecord(keep.id).title, 'Keep after tamper');
  await assert.rejects(destination.atlas.cancelImportUpload(badStage.uploadId), { code: 'IMPORT_UPLOAD_NOT_FOUND' });

  const wrongStage = await destination.atlas.stageImportUpload([backup]);
  await assert.rejects(destination.atlas.commitImportUpload(wrongStage.uploadId, 'incorrect backup passphrase'), { code: 'INVALID_BACKUP_PASSPHRASE' });
  assert.equal(destination.atlas.getRecord(keep.id).title, 'Keep after tamper');

  const truncatedStage = await destination.atlas.stageImportUpload([backup.subarray(0, -1)]);
  await assert.rejects(destination.atlas.commitImportUpload(truncatedStage.uploadId, BACKUP_PASSPHRASE), { code: 'INVALID_BACKUP_PASSPHRASE' });
  assert.equal(destination.atlas.getRecord(keep.id).title, 'Keep after tamper');
});

test('global search covers encrypted nested content without exposing trashed records by default', async (t) => {
  const { atlas } = await fixture(t);
  const first = create(atlas, 'preference', 'Editor', { value: { theme: 'Solarized Dark' } });
  const second = create(atlas, 'preference', 'Other', { value: 'plain' });
  atlas.trashRecord(second.id, second.revision);
  assert.deepEqual(atlas.listRecords({ q: 'SOLARIZED' }).map((record) => record.id), [first.id]);
  assert.equal(atlas.listRecords().length, 1);
  assert.equal(atlas.listRecords({ trashed: 'all' }).length, 2);
});

test('portable encrypted import validates before atomic replacement', async (t) => {
  const source = await fixture(t);
  create(source.atlas, 'preference', 'Source', { value: 'portable' });
  const envelope = await source.atlas.export(BACKUP_PASSPHRASE);
  const destination = await fixture(t);
  const preserved = create(destination.atlas, 'preference', 'Preserved', { value: true });
  await destination.atlas.import(BACKUP_PASSPHRASE, envelope);
  assert.equal(destination.atlas.listRecords()[0].title, 'Source');
  const snapshot = await openBackupEnvelope(BACKUP_PASSPHRASE, envelope);
  snapshot.records[0].revision = 999;
  const invalid = await createBackupEnvelope(BACKUP_PASSPHRASE, snapshot);
  await assert.rejects(destination.atlas.import(BACKUP_PASSPHRASE, invalid), { code: 'INVALID_BACKUP' });
  assert.equal(destination.atlas.listRecords()[0].title, 'Source');
  await assert.rejects(destination.atlas.import('incorrect backup passphrase', envelope), { code: 'INVALID_BACKUP_PASSPHRASE' });
  assert.notEqual(preserved.id, destination.atlas.listRecords()[0].id);
});

function rawRequest(port, { method = 'GET', path = '/', headers = {}, chunks = [] } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const body = [];
      res.on('data', (chunk) => body.push(chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(body) }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('HTTP reset requires the current passphrase and supports clean setup afterward', async (t) => {
  const { atlas, directory } = await fixture(t);
  const publicDir = join(directory, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Atlas</title>');
  create(atlas, 'preference', 'Server-side reset sentinel', { value: true });
  const server = createServer({ atlas, publicDir });
  const address = await listen(server, { port: 0 });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  const port = address.port;

  const wrong = await rawRequest(port, {
    method: 'POST', path: '/api/reset', headers: { 'content-type': 'application/json' },
    chunks: [Buffer.from(JSON.stringify({ passphrase: 'this is the wrong passphrase' }))],
  });
  assert.equal(wrong.status, 401);
  assert.equal(JSON.parse(wrong.body).error.code, 'INVALID_PASSPHRASE');
  assert.equal(JSON.parse((await rawRequest(port, { path: '/api/records' })).body).length, 1);

  const cleared = await rawRequest(port, {
    method: 'POST', path: '/api/reset', headers: { 'content-type': 'application/json' },
    chunks: [Buffer.from(JSON.stringify({ passphrase: APP_PASSPHRASE }))],
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(JSON.parse(cleared.body), { initialized: false, locked: true });
  assert.deepEqual(JSON.parse((await rawRequest(port, { path: '/api/status' })).body), { initialized: false, locked: true });

  const newPassphrase = 'new passphrase after HTTP reset';
  const setup = await rawRequest(port, {
    method: 'POST', path: '/api/setup', headers: { 'content-type': 'application/json' },
    chunks: [Buffer.from(JSON.stringify({ passphrase: newPassphrase }))],
  });
  assert.equal(setup.status, 201);
  assert.deepEqual(JSON.parse((await rawRequest(port, { path: '/api/records' })).body), []);
});

test('HTTP subgoal endpoint commits the record and prerequisite edges together', async (t) => {
  const { atlas, directory } = await fixture(t);
  const publicDir = join(directory, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Atlas</title>');
  const root = create(atlas, 'goal', 'HTTP progression', { horizon: 'long' });
  const prerequisite = create(atlas, 'goal', 'HTTP prerequisite', { horizon: 'short' }, { parentId: root.id });
  const server = createServer({ atlas, publicDir });
  const address = await listen(server, { port: 0 });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  const response = await rawRequest(address.port, {
    method: 'POST', path: `/api/goals/${root.id}/subgoals`, headers: { 'content-type': 'application/json' },
    chunks: [Buffer.from(JSON.stringify({
      requestId: '33333333-3333-4333-8333-333333333333', title: 'HTTP atomic subgoal',
      data: { horizon: 'short', importance: 'medium', targetDate: '', description: '', progress: 0 },
      customFieldValues: {}, prerequisiteIds: [prerequisite.id],
    }))],
  });
  assert.equal(response.status, 201);
  const created = JSON.parse(response.body);
  assert.equal(created.created, true);
  assert.equal(created.record.parentId, root.id);
  assert.deepEqual(atlas.getGoalGraph(root.id).dependencies.map((edge) => edge.goalId), [created.record.id]);
});

test('HTTP image and streamed backup endpoints preserve binary contracts', async (t) => {
  const { atlas, directory } = await fixture(t);
  const publicDir = join(directory, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Atlas</title>');
  const experience = create(atlas, 'experience', 'HTTP gallery', { kind: 'event', startDate: '2026-08-05' });
  const server = createServer({ atlas, publicDir, uploadLimit: 4 * 1024 * 1024 });
  const address = await listen(server, { port: 0 });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  const port = address.port;
  const bytes = pngBytes('http-image');
  const uploaded = await rawRequest(port, {
    method: 'POST', path: `/api/records/${experience.id}/images`,
    headers: { 'content-type': 'image/png', 'x-atlas-filename': encodeURIComponent('HTTP image.png') }, chunks: [bytes],
  });
  assert.equal(uploaded.status, 201);
  const image = JSON.parse(uploaded.body);
  assert.equal(image.filename, 'HTTP image.png');
  const listed = await rawRequest(port, { path: `/api/records/${experience.id}/images` });
  assert.deepEqual(JSON.parse(listed.body).map((item) => item.id), [image.id]);
  const content = await rawRequest(port, { path: `/api/images/${image.id}/content` });
  assert.equal(content.status, 200);
  assert.equal(content.headers['content-type'], 'image/png');
  assert.equal(content.headers['cache-control'], 'no-store');
  assert.equal(content.headers['cross-origin-resource-policy'], 'same-origin');
  assert.deepEqual(content.body, bytes);

  const exported = await rawRequest(port, {
    method: 'POST', path: '/api/export', headers: { 'content-type': 'application/json' },
    chunks: [Buffer.from(JSON.stringify({ passphrase: BACKUP_PASSPHRASE }))],
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers['content-type'], 'application/vnd.eidolon-atlas-backup');
  assert.match(exported.headers['content-disposition'], /\.atlas"$/);

  const staged = await rawRequest(port, {
    method: 'POST', path: '/api/import-uploads', headers: { 'content-type': 'application/vnd.eidolon-atlas-backup' }, chunks: [exported.body],
  });
  assert.equal(staged.status, 201);
  const uploadId = JSON.parse(staged.body).uploadId;
  const committed = await rawRequest(port, {
    method: 'POST', path: `/api/import-uploads/${uploadId}/commit`, headers: { 'content-type': 'application/json' },
    chunks: [Buffer.from(JSON.stringify({ passphrase: BACKUP_PASSPHRASE }))],
  });
  assert.equal(committed.status, 200);
  assert.deepEqual(JSON.parse(committed.body), { imported: true, records: 1, images: 1 });
  const deepLink = await rawRequest(port, { path: `/experiences/${experience.id}` });
  assert.equal(deepLink.status, 200);

  const deleted = await rawRequest(port, { method: 'DELETE', path: `/api/images/${image.id}` });
  assert.equal(deleted.status, 200);
  assert.deepEqual(JSON.parse(deleted.body), { deleted: true });
});

test('HTTP buffers split UTF-8, applies limits, stable errors, lock status, and SPA serving', async (t) => {
  const { atlas, directory } = await fixture(t);
  const publicDir = join(directory, 'public');
  await writeFile(join(directory, 'placeholder'), 'x');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Atlas</title>');
  const server = createServer({ atlas, publicDir, bodyLimit: 256 });
  const address = await listen(server, { port: 0 });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  const port = address.port;
  const encoded = Buffer.from(JSON.stringify({ category: 'preference', title: 'Café', data: { value: 'é' }, customFieldValues: {} }));
  const split = encoded.indexOf(Buffer.from('é')) + 1;
  const created = await rawRequest(port, { method: 'POST', path: '/api/records', headers: { 'content-type': 'application/json' }, chunks: [encoded.subarray(0, split), encoded.subarray(split)] });
  assert.equal(created.status, 201);
  assert.equal(JSON.parse(created.body).title, 'Café');
  const tooLarge = await rawRequest(port, { method: 'POST', path: '/api/records', headers: { 'content-type': 'application/json' }, chunks: [Buffer.alloc(300, 0x20)] });
  assert.equal(tooLarge.status, 413);
  assert.equal(JSON.parse(tooLarge.body).error.code, 'REQUEST_TOO_LARGE');
  const wrongOrigin = await rawRequest(port, { method: 'POST', path: '/api/lock', headers: { origin: 'http://evil.example' } });
  assert.equal(wrongOrigin.status, 403);
  const wrongType = await rawRequest(port, { method: 'POST', path: '/api/lock', headers: { 'content-type': 'text/plain' }, chunks: [Buffer.from('{}')] });
  assert.equal(wrongType.status, 415);
  await rawRequest(port, { method: 'POST', path: '/api/lock' });
  const locked = await rawRequest(port, { path: '/api/records' });
  assert.equal(locked.status, 423);
  assert.deepEqual(Object.keys(JSON.parse(locked.body)), ['error']);
  const spa = await rawRequest(port, { path: '/preferences' });
  assert.equal(spa.status, 200);
  assert.match(spa.body.toString(), /Atlas/);
});
