import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createServer, listen } from '../src/server.js';

function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function makeAtlas() {
  let locked = false;
  return {
    status: () => ({ initialized: true, locked }),
    close: () => {},
    getKnowledgeTree: () => [],
    listKnowledgeNodes: () => [],
    getKnowledgeNode: (id) => ({ id, name: 'Node' }),
    createKnowledgeNode: (input) => ({ id: 'new', ...input }),
    patchKnowledgeNode: (id, input) => ({ id, ...input }),
    deleteKnowledgeNode: () => {},
    createKnowledgeConnection: (input) => ({ id: 'connection', ...input }),
    deleteKnowledgeConnection: () => {},
    setLocked(value) { locked = value; },
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-local-http-'));
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Atlas</title>');
  const atlas = makeAtlas();
  const server = createServer({ atlas, publicDir });
  const address = await listen(server, { port: 0 });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { atlas, port: address.port };
}

test('retired Agent and key-management routes are absent', async (t) => {
  const { port } = await fixture(t);
  const routes = [
    ['GET', '/api/openapi.json'],
    ['GET', '/api/agent/guide'],
    ['GET', '/api/agent/tools'],
    ['POST', '/api/agent/get_personal_info'],
    ['POST', '/api/agent/list_experiences'],
    ['POST', '/api/agent/get_goals'],
    ['POST', '/api/agent/list_projects'],
    ['GET', '/api/agent-key'],
    ['POST', '/api/agent-key'],
    ['DELETE', '/api/agent-key'],
  ];
  for (const [method, path] of routes) {
    const result = await rawRequest(port, { method, path });
    assert.equal(result.status, 404, `${method} ${path}`);
    assert.equal(JSON.parse(result.body).error.code, 'NOT_FOUND');
  }
});

test('Settings publishes the complete native and Knowledge contracts', async (t) => {
  const { atlas, port } = await fixture(t);
  const reference = await rawRequest(port, { path: '/api/settings/api-reference' });
  assert.equal(reference.status, 200);
  const referenceBody = JSON.parse(reference.body);
  assert.deepEqual(Object.keys(referenceBody), ['browserOpenapi', 'knowledgeOpenapi']);
  const browserOperations = Object.entries(referenceBody.browserOpenapi.paths)
    .flatMap(([path, pathItem]) => Object.entries(pathItem)
      .filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
      .map(([method, operation]) => ({ route: `${method.toUpperCase()} ${path}`, operation })));
  assert.equal(browserOperations.length, 43);
  assert.ok(browserOperations.every(({ operation }) => operation.description?.trim()));
  assert.ok(browserOperations.every(({ route }) => !route.includes('/api/agent')));
  assert.deepEqual(referenceBody.browserOpenapi.components.schemas.RecordCategory.enum,
    ['person', 'experience', 'goal', 'project', 'resource', 'relationship', 'interest']);
  assert.deepEqual(referenceBody.browserOpenapi.components.schemas.InterestHobbyData.required, ['kind']);
  assert.deepEqual(referenceBody.browserOpenapi.components.schemas.InterestPreferenceData.required, ['kind', 'value']);
  assert.deepEqual(referenceBody.browserOpenapi.components.schemas.InterestHobbyData.properties.engagement.enum,
    ['casual', 'regular', 'serious', 'past']);
  assert.deepEqual(referenceBody.browserOpenapi.components.schemas.InterestHobbyData.properties.skillLevel.enum,
    ['beginner', 'intermediate', 'advanced', 'expert']);
  const imageUpload = referenceBody.browserOpenapi.paths['/api/records/{id}/images'].post;
  assert.deepEqual(imageUpload.parameters, [{
    name: 'X-Atlas-Filename', in: 'header', required: true,
    description: 'URI-encoded original filename.', schema: { type: 'string', minLength: 1 },
  }]);
  const subgoal = referenceBody.browserOpenapi.paths['/api/goals/{id}/subgoals'].post;
  assert.equal(subgoal.operationId, 'create_subgoal');
  assert.deepEqual(subgoal.requestBody.content['application/json'].schema.required,
    ['requestId', 'title', 'data', 'prerequisiteIds']);
  assert.deepEqual(Object.keys(referenceBody.knowledgeOpenapi.paths), [
    '/api/knowledge/tree', '/api/knowledge/nodes', '/api/knowledge/nodes/{id}',
    '/api/knowledge/connections', '/api/knowledge/connections/{id}',
  ]);
  const knowledgeOperations = Object.values(referenceBody.knowledgeOpenapi.paths)
    .flatMap((pathItem) => Object.entries(pathItem))
    .filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
    .map(([, operation]) => operation);
  assert.equal(knowledgeOperations.length, 8);
  assert.ok(knowledgeOperations.every((operation) => operation.description?.trim()));
  assert.equal(new Set(knowledgeOperations.map((operation) => operation.description)).size, 8);

  atlas.setLocked(true);
  assert.equal((await rawRequest(port, { path: '/api/settings/api-reference' })).status, 423);
});

test('browser auth transition centralizes 423 handling, request aborts, and decrypted DOM scrubbing', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const makeNode = () => ({
    hidden: false, open: false, value: 'secret', alt: 'sensitive', textContent: 'sensitive', inert: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute(name) { if (name === 'src') delete this.src; },
    replaceChildren() { this.replaced = true; this.textContent = ''; },
    reset() { this.resetCalled = true; this.value = ''; },
    close(value) { this.open = false; this.closedWith = value; },
    focus() { this.focused = true; }, remove() { this.removed = true; },
  });
  const nodes = Object.fromEntries([
    '#app', '#auth-view', '#setup-form', '#unlock-form', '#auth-title', '#auth-intro',
    '#detail-pane', '.workspace', '#global-search', '#content-stage', '#detail-content',
    '#record-fields', '#notice-region', '#sidebar', '#sidebar-scrim', '#subgoal-dialog',
  ].map((selector) => [selector, makeNode()]));
  nodes['#app'].hidden = false;
  nodes['#auth-view'].hidden = true;
  nodes['#unlock-form'].hidden = true;
  const dialog = { ...makeNode(), open: true };
  const form = makeNode();
  const image = { ...makeNode(), src: '/api/images/private/content' };
  const count = makeNode();
  const focusInput = makeNode();
  const document = {
    querySelector(selector) { return selector === '#unlock-form input' ? focusInput : (nodes[selector] ?? null); },
    querySelectorAll(selector) {
      if (selector === 'dialog[open]') return dialog.open ? [dialog] : [];
      if (selector === '#app form, body > dialog form') return [form];
      if (selector === '#app img, body > dialog img') return [image];
      if (selector === '[data-count]') return [count];
      return [];
    },
  };
  const context = {
    process: { env: { NODE_ENV: 'test' } }, document,
    window: { setTimeout(callback) { callback(); } }, console, URL, Set, Map, Promise, AbortController,
    fetch: async () => ({
      status: 423, ok: false,
      headers: { get() { return 'application/json'; } },
      json: async () => ({ error: { code: 'LOCKED', message: 'Atlas is locked.' } }),
    }),
  };
  context.globalThis = context;
  runInNewContext(source, context, { filename: 'public/app.js' });
  const { api, state } = context.__atlasTest;
  let aborted = false;
  state.pendingRequests.add({ abort() { aborted = true; } });
  state.records = [{ title: 'private' }];
  state.allRecords = [{ data: { value: 'private' } }];
  state.editing = { title: 'private' };
  state.gallery = { recordId: 'private', images: [{ id: 'private' }], loading: true };
  await assert.rejects(api('/records'), (error) => error.status === 423 && error.payload.error.code === 'LOCKED');

  assert.equal(aborted, true);
  assert.equal(state.authGeneration, 1);
  assert.equal(state.records.length, 0);
  assert.equal(state.editing, null);
  assert.equal(state.gallery.recordId, null);
  assert.equal(state.gallery.images.length, 0);
  assert.equal(state.gallery.loading, false);
  assert.equal(dialog.closedWith, 'auth-transition');
  assert.equal(form.resetCalled, true);
  assert.equal(image.src, undefined);
  assert.equal(nodes['#content-stage'].replaced, true);
  assert.equal(nodes['#app'].hidden, true);
  assert.equal(nodes['#auth-view'].hidden, false);
  assert.equal(nodes['#unlock-form'].hidden, false);
});

test('native Knowledge routes retain their unlocked local contracts', async (t) => {
  const { port } = await fixture(t);
  const tree = await rawRequest(port, { path: '/api/knowledge/tree' });
  assert.deepEqual(JSON.parse(tree.body), { branches: [] });
  const created = await rawRequest(port, {
    method: 'POST', path: '/api/knowledge/nodes',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Node' }),
  });
  assert.equal(created.status, 201);
  assert.equal(JSON.parse(created.body).node.name, 'Node');
  const deleted = await rawRequest(port, { method: 'DELETE', path: '/api/knowledge/nodes/node-1' });
  assert.equal(deleted.status, 204);
});
