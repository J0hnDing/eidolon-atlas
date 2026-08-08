import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Atlas, IMAGE_MAX_BYTES, IMAGE_MAX_PER_EXPERIENCE } from '../src/atlas.js';
import { createBackupEnvelope, deriveKey, encryptJson, objectAad, openBackupEnvelope } from '../src/crypto.js';
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
    .map((row) => row.version), [1, 2, 3, 4]);
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
