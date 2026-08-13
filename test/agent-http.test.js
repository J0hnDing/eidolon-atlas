import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
    verifyAgentKey: (key) => key === 'atlas_test-key',
    getAgentKeyStatus: () => ({ configured: true, prefix: 'atlas_test', createdAt: '2026-08-10T00:00:00.000Z' }),
    generateAgentKey: () => ({ key: 'atlas_rotated-key', prefix: 'atlas_rotat', createdAt: '2026-08-10T00:01:00.000Z' }),
    revokeAgentKey: () => ({ revoked: true }),
    getAgentPersonalInfo: () => ({ personal_info: { preferred_name: 'Atlas user' } }),
    listAgentExperiences: () => ({ experiences: [] }),
    getAgentGoals: () => ({ goals: [], progressions: [] }),
    listAgentProjects: () => ({ projects: [] }),
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
  const directory = await mkdtemp(join(tmpdir(), 'atlas-agent-http-'));
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

test('agent discovery and read projections require a bearer key and empty input', async (t) => {
  const { atlas, port } = await fixture(t);
  const missing = await rawRequest(port, { path: '/api/agent/tools' });
  assert.equal(missing.status, 401);
  assert.equal(JSON.parse(missing.body).error.code, 'UNAUTHORIZED');

  const headers = { authorization: 'Bearer atlas_test-key' };
  const catalog = await rawRequest(port, { path: '/api/agent/tools', headers });
  assert.equal(catalog.status, 200);
  assert.deepEqual(JSON.parse(catalog.body).tools.map((tool) => tool.name), [
    'get_personal_info', 'list_experiences', 'get_goals', 'list_projects',
  ]);
  assert.equal((await rawRequest(port, { path: '/api/agent/guide', headers })).status, 200);
  const spec = JSON.parse((await rawRequest(port, { path: '/api/openapi.json', headers })).body);
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');

  const badBody = await rawRequest(port, {
    method: 'POST', path: '/api/agent/get_goals', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ unexpected: true }),
  });
  assert.equal(badBody.status, 400);
  const goals = await rawRequest(port, {
    method: 'POST', path: '/api/agent/get_goals', headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(goals.status, 200);
  assert.deepEqual(JSON.parse(goals.body), { goals: [], progressions: [] });

  atlas.setLocked(true);
  const locked = await rawRequest(port, { path: '/api/agent/tools', headers });
  assert.equal(locked.status, 423);
  const stillUnauthorized = await rawRequest(port, { path: '/api/agent/tools' });
  assert.equal(stillUnauthorized.status, 401);
});

test('agent-key management and browser Knowledge routes keep their separate contracts', async (t) => {
  const { atlas, port } = await fixture(t);
  const status = await rawRequest(port, { path: '/api/agent-key' });
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body).prefix, 'atlas_test');

  const reference = await rawRequest(port, { path: '/api/settings/api-reference' });
  assert.equal(reference.status, 200);
  const referenceBody = JSON.parse(reference.body);
  assert.equal(referenceBody.agentOpenapi.openapi, '3.1.0');
  assert.equal(referenceBody.browserOpenapi.openapi, '3.1.0');
  assert.equal(referenceBody.knowledgeOpenapi.openapi, '3.1.0');
  const browserOperations = Object.entries(referenceBody.browserOpenapi.paths)
    .flatMap(([path, pathItem]) => Object.entries(pathItem)
      .filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
      .map(([method, operation]) => ({ route: `${method.toUpperCase()} ${path}`, operation })));
  assert.equal(browserOperations.length, 45);
  assert.ok(browserOperations.every(({ operation }) => operation.description?.trim()));
  assert.deepEqual(browserOperations.map(({ route }) => route), [
    'GET /api/status', 'POST /api/setup', 'POST /api/unlock', 'POST /api/lock', 'POST /api/reset',
    'GET /api/settings/api-reference', 'GET /api/agent-key', 'POST /api/agent-key', 'DELETE /api/agent-key',
    'GET /api/records', 'POST /api/records', 'GET /api/records/{id}', 'PATCH /api/records/{id}',
    'DELETE /api/records/{id}', 'POST /api/records/{id}/restore', 'GET /api/records/{id}/revisions',
    'POST /api/records/{id}/revisions/{revision}/restore', 'DELETE /api/trash',
    'GET /api/goals/{id}/progression', 'POST /api/goals/{id}/prerequisites',
    'DELETE /api/goals/{id}/prerequisites/{prerequisiteId}', 'GET /api/records/{id}/images',
    'POST /api/records/{id}/images', 'GET /api/images/{id}/content', 'DELETE /api/images/{id}',
    'GET /api/custom-fields', 'POST /api/custom-fields', 'PATCH /api/custom-fields/{id}',
    'DELETE /api/custom-fields/{id}', 'POST /api/links', 'PATCH /api/links/{id}', 'DELETE /api/links/{id}',
    'GET /api/knowledge/tree', 'GET /api/knowledge/nodes', 'POST /api/knowledge/nodes',
    'GET /api/knowledge/nodes/{id}', 'PATCH /api/knowledge/nodes/{id}', 'DELETE /api/knowledge/nodes/{id}',
    'POST /api/knowledge/connections', 'DELETE /api/knowledge/connections/{id}', 'POST /api/export',
    'POST /api/import', 'POST /api/import-uploads', 'POST /api/import-uploads/{id}/commit',
    'DELETE /api/import-uploads/{id}',
  ]);
  assert.deepEqual(Object.keys(referenceBody.knowledgeOpenapi.paths), [
    '/api/knowledge/tree', '/api/knowledge/nodes', '/api/knowledge/nodes/{id}',
    '/api/knowledge/connections', '/api/knowledge/connections/{id}',
  ]);
  assert.deepEqual(Object.keys(referenceBody.knowledgeOpenapi.paths['/api/knowledge/nodes/{id}']), [
    'parameters', 'get', 'patch', 'delete',
  ]);
  const knowledgeOperations = Object.values(referenceBody.knowledgeOpenapi.paths)
    .flatMap((pathItem) => Object.entries(pathItem))
    .filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
    .map(([, operation]) => operation);
  assert.equal(knowledgeOperations.length, 8);
  assert.ok(knowledgeOperations.every((operation) => operation.description?.trim()));
  assert.equal(new Set(knowledgeOperations.map((operation) => operation.description)).size, knowledgeOperations.length);
  const agentOperations = Object.values(referenceBody.agentOpenapi.paths)
    .flatMap((pathItem) => Object.entries(pathItem))
    .filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
    .map(([, operation]) => operation);
  assert.equal(agentOperations.length, 7);
  assert.ok(agentOperations.every((operation) => operation.description?.trim()));
  assert.deepEqual(
    Object.keys(referenceBody.knowledgeOpenapi.paths['/api/knowledge/nodes/{id}'].get.responses),
    ['200', '400', '404', '423'],
  );
  assert.equal(referenceBody.knowledgeOpenapi.components.schemas.KnowledgeTermInput.properties.id.maxLength, 64);
  atlas.setLocked(true);
  assert.equal((await rawRequest(port, { path: '/api/settings/api-reference' })).status, 423);
  atlas.setLocked(false);

  const generated = await rawRequest(port, {
    method: 'POST', path: '/api/agent-key', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(generated.status, 201);
  assert.equal(JSON.parse(generated.body).key, 'atlas_rotated-key');

  const tree = await rawRequest(port, { path: '/api/knowledge/tree' });
  assert.deepEqual(JSON.parse(tree.body), { branches: [] });
  const created = await rawRequest(port, {
    method: 'POST', path: '/api/knowledge/nodes', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Node' }),
  });
  assert.equal(created.status, 201);
  assert.equal(JSON.parse(created.body).node.name, 'Node');
  const deleted = await rawRequest(port, { method: 'DELETE', path: '/api/knowledge/nodes/node-1' });
  assert.equal(deleted.status, 204);
});
