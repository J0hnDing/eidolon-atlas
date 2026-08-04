import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Atlas } from '../src/atlas.js';
import { createBackupEnvelope, openBackupEnvelope } from '../src/crypto.js';
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
  assert.throws(() => create(atlas, 'goal', 'Bad goal', { horizon: 'someday', status: 'active' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'project', 'Bad project', { context: '', currentState: '', budget: 1 }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'resource', 'Cash', { quantity: 1, value: 10 }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'relationship', 'Unknown', { kind: 'place' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => create(atlas, 'preference', 'Theme', {}), { code: 'VALIDATION_ERROR' });
  assert.equal(create(atlas, 'experience', 'Launch', { kind: 'event', startDate: '2026-08-04' }).revision, 1);
  assert.equal(create(atlas, 'project', 'Atlas', { context: '', currentState: 'active' }).category, 'project');
  assert.equal(create(atlas, 'resource', 'Workshop', { kind: 'capital', availability: 'available' }).category, 'resource');
  assert.equal(create(atlas, 'relationship', 'Studio', { kind: 'org' }).category, 'relationship');
});

test('numbered migrations are idempotent across reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-migration-test-'));
  const databasePath = join(directory, 'atlas.sqlite');
  const first = new Atlas({ databasePath });
  await first.setup(APP_PASSPHRASE);
  assert.deepEqual(first.database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    .map((row) => row.version), [1, 2, 3]);
  first.close();
  const reopened = new Atlas({ databasePath });
  assert.deepEqual(reopened.status(), { initialized: true, locked: true });
  reopened.close();
  await rm(directory, { recursive: true, force: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
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

test('goal sibling order, moves, cycle rejection, and conservative trash remain coherent', async (t) => {
  const { atlas } = await fixture(t);
  const first = create(atlas, 'goal', 'First', { horizon: 'short', status: 'active' });
  const second = create(atlas, 'goal', 'Second', { horizon: 'short', status: 'active' }, { position: 0 });
  assert.deepEqual(atlas.listRecords({ category: 'goal' }).map((goal) => [goal.title, goal.position]), [
    ['Second', 0], ['First', 1],
  ]);
  const moved = atlas.patchRecord(first.id, { revision: first.revision, position: 0 });
  assert.equal(moved.position, 0);
  assert.deepEqual(atlas.listRecords({ category: 'goal' }).map((goal) => goal.title), ['First', 'Second']);
  const child = create(atlas, 'goal', 'Child', { horizon: 'short', status: 'active' }, { parentId: first.id });
  assert.throws(() => atlas.patchRecord(first.id, { revision: moved.revision, parentId: child.id }), { code: 'GOAL_CYCLE' });
  assert.throws(() => atlas.trashRecord(first.id, moved.revision), { code: 'GOAL_HAS_ACTIVE_CHILDREN' });
  const trashedChild = atlas.trashRecord(child.id, child.revision);
  assert.equal(trashedChild.trashed, true);
  const trashedParent = atlas.trashRecord(first.id, moved.revision);
  assert.equal(trashedParent.trashed, true);
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
  const archived = atlas.deleteCustomField(field.id);
  assert.equal(archived.archived, true);
  assert.equal(atlas.listCustomFields({ category: 'person' })[0].archived, true);
  assert.equal(atlas.listCustomFields({ category: 'goal' }).length, 0);
  assert.throws(() => atlas.patchRecord(person.id, {
    revision: person.revision, customFieldValues: { [field.id]: 'green' },
  }), { code: 'CUSTOM_FIELD_ARCHIVED' });
  const renamed = atlas.patchRecord(person.id, { revision: person.revision, title: 'Me again' });
  assert.equal(renamed.title, 'Me again');
  assert.throws(() => atlas.patchRecord(person.id, { revision: renamed.revision,
    customFieldValues: { [field.id]: 'green' } }), { code: 'CUSTOM_FIELD_ARCHIVED' });
  const preference = create(atlas, 'preference', 'Color', { value: 'blue' });
  const link = atlas.createLink({ sourceId: person.id, targetId: preference.id, type: 'supports', label: 'explains', notes: 'private note' });
  assert.equal(atlas.getRecord(person.id).links[0].label, 'explains');
  assert.equal(atlas.getRecord(preference.id).backlinks[0].id, link.id);
  assert.throws(() => atlas.createLink({ sourceId: person.id, targetId: person.id }), { code: 'VALIDATION_ERROR' });
  atlas.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = await readFile(databasePath);
  for (const privateText of ['Favorite color', 'explains', 'private note']) {
    assert.equal(bytes.includes(Buffer.from(privateText)), false);
  }
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
