import { createServer as createNodeServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Atlas, BACKUP_UPLOAD_MAX_BYTES, IMAGE_MAX_BYTES } from './atlas.js';
import { AtlasError, errorBody, fail } from './errors.js';
import { requireObject } from './domain.js';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_IMPORT_LIMIT = 16 * 1024 * 1024;
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.ico', 'image/x-icon'], ['.webp', 'image/webp'],
]);

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request, limit) {
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) fail(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.');
    if (length > limit) fail(413, 'REQUEST_TOO_LARGE', `Request body exceeds the ${limit}-byte limit.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'REQUEST_TOO_LARGE', `Request body exceeds the ${limit}-byte limit.`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const bytes = Buffer.concat(chunks, size);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(400, 'INVALID_UTF8', 'Request body must be valid UTF-8.');
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

async function readBytes(request, limit) {
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) fail(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.');
    if (length > limit) fail(413, 'REQUEST_TOO_LARGE', `Request body exceeds the ${limit}-byte limit.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'REQUEST_TOO_LARGE', `Request body exceeds the ${limit}-byte limit.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function decodeSegment(value) {
  try { return decodeURIComponent(value); } catch { fail(400, 'INVALID_PATH', 'Request path contains invalid encoding.'); }
}

function parseTrashed(value) {
  if (value === null || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (value === 'all') return 'all';
  fail(400, 'VALIDATION_ERROR', 'trashed must be false, true, or all.');
}

function requirePassphraseBody(body, withEnvelope = false) {
  requireObject(body);
  if (typeof body.passphrase !== 'string') fail(400, 'VALIDATION_ERROR', 'passphrase is required.');
  if (withEnvelope && (!body.envelope || typeof body.envelope !== 'object' || Array.isArray(body.envelope))) {
    fail(400, 'VALIDATION_ERROR', 'envelope is required.');
  }
  return body;
}

function validateApiRequest(request) {
  const method = request.method ?? 'GET';
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) return;
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed;
    try { parsed = new URL(origin); } catch { fail(403, 'ORIGIN_FORBIDDEN', 'Request origin is not allowed.'); }
    if (parsed.protocol !== 'http:' || parsed.host !== host ||
        !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      fail(403, 'ORIGIN_FORBIDDEN', 'Request origin is not allowed.');
    }
  }
  const hasBody = request.headers['transfer-encoding'] !== undefined ||
    (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0');
  if (hasBody) {
    const contentType = (request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    const path = (() => { try { return new URL(request.url ?? '/', 'http://localhost').pathname; } catch { return ''; } })();
    const imageUpload = method === 'POST' && /^\/api\/records\/[^/]+\/images$/.test(path);
    const backupUpload = method === 'POST' && path === '/api/import-uploads';
    if (imageUpload && !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Image uploads must use image/jpeg, image/png, or image/webp.');
    }
    if (backupUpload && !['application/vnd.eidolon-atlas-backup', 'application/octet-stream'].includes(contentType)) {
      fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Backup uploads must use application/vnd.eidolon-atlas-backup.');
    }
    if (!imageUpload && !backupUpload && contentType !== 'application/json') {
      fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body must use application/json.');
    }
  }
}

function uploadFilename(request) {
  const encoded = request.headers['x-atlas-filename'];
  if (typeof encoded !== 'string' || encoded === '') fail(400, 'VALIDATION_ERROR', 'X-Atlas-Filename is required.');
  try { return decodeURIComponent(encoded); } catch { fail(400, 'VALIDATION_ERROR', 'X-Atlas-Filename must be URI encoded.'); }
}

async function sendImage(response, image) {
  response.writeHead(200, {
    'Content-Type': image.metadata.mimeType,
    'Content-Length': image.bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.metadata.filename)}`,
  });
  async function* content() {
    try {
      for (let offset = 0; offset < image.bytes.length; offset += 64 * 1024) {
        yield Buffer.from(image.bytes.subarray(offset, Math.min(offset + 64 * 1024, image.bytes.length)));
      }
    } finally {
      image.bytes.fill(0);
    }
  }
  await pipeline(Readable.from(content()), response);
}

async function routeApi(atlas, request, response, url, limits) {
  validateApiRequest(request);
  const { method } = request;
  const path = url.pathname;
  if (method === 'GET' && path === '/api/status') return sendJson(response, 200, atlas.status());
  if (method === 'POST' && path === '/api/setup') {
    const body = requirePassphraseBody(await readJson(request, limits.body));
    return sendJson(response, 201, await atlas.setup(body.passphrase));
  }
  if (method === 'POST' && path === '/api/unlock') {
    const body = requirePassphraseBody(await readJson(request, limits.body));
    return sendJson(response, 200, await atlas.unlock(body.passphrase));
  }
  if (method === 'POST' && path === '/api/lock') {
    await readJson(request, limits.body);
    return sendJson(response, 200, atlas.lock());
  }
  if (method === 'GET' && path === '/api/records') {
    return sendJson(response, 200, atlas.listRecords({
      category: url.searchParams.get('category') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      trashed: parseTrashed(url.searchParams.get('trashed')),
    }));
  }
  if (method === 'POST' && path === '/api/records') {
    return sendJson(response, 201, atlas.createRecord(await readJson(request, limits.body)));
  }
  let match = /^\/api\/records\/([^/]+)\/images$/.exec(path);
  if (match) {
    const recordId = decodeSegment(match[1]);
    if (method === 'GET') return sendJson(response, 200, atlas.listImages(recordId));
    if (method === 'POST') {
      const mimeType = (request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      const filename = uploadFilename(request);
      const bytes = await readBytes(request, IMAGE_MAX_BYTES);
      try {
        return sendJson(response, 201, atlas.createImage(recordId, {
          filename, mimeType, bytes,
        }));
      } finally {
        bytes.fill(0);
      }
    }
  }
  match = /^\/api\/images\/([^/]+)\/content$/.exec(path);
  if (match && method === 'GET') return sendImage(response, atlas.getImageContent(decodeSegment(match[1])));
  match = /^\/api\/images\/([^/]+)$/.exec(path);
  if (match && method === 'DELETE') return sendJson(response, 200, atlas.deleteImage(decodeSegment(match[1])));
  match = /^\/api\/records\/([^/]+)$/.exec(path);
  if (match) {
    const id = decodeSegment(match[1]);
    if (method === 'GET') return sendJson(response, 200, atlas.getRecord(id));
    if (method === 'PATCH') return sendJson(response, 200, atlas.patchRecord(id, await readJson(request, limits.body)));
    if (method === 'DELETE') {
      const body = requireObject(await readJson(request, limits.body));
      return sendJson(response, 200, atlas.trashRecord(id, body.revision));
    }
  }
  match = /^\/api\/records\/([^/]+)\/restore$/.exec(path);
  if (match && method === 'POST') {
    const body = requireObject(await readJson(request, limits.body));
    return sendJson(response, 200, atlas.restoreRecord(decodeSegment(match[1]), body.revision));
  }
  match = /^\/api\/records\/([^/]+)\/revisions$/.exec(path);
  if (match && method === 'GET') return sendJson(response, 200, atlas.listRevisions(decodeSegment(match[1])));
  match = /^\/api\/records\/([^/]+)\/revisions\/(\d+)\/restore$/.exec(path);
  if (match && method === 'POST') {
    const body = requireObject(await readJson(request, limits.body));
    return sendJson(response, 200, atlas.restoreRevision(decodeSegment(match[1]), Number(match[2]), body.revision));
  }
  if (method === 'GET' && path === '/api/custom-fields') {
    return sendJson(response, 200, atlas.listCustomFields({ category: url.searchParams.get('category') ?? undefined }));
  }
  if (method === 'POST' && path === '/api/custom-fields') {
    return sendJson(response, 201, atlas.createCustomField(await readJson(request, limits.body)));
  }
  match = /^\/api\/custom-fields\/([^/]+)$/.exec(path);
  if (match) {
    const id = decodeSegment(match[1]);
    if (method === 'PATCH') return sendJson(response, 200, atlas.patchCustomField(id, await readJson(request, limits.body)));
    if (method === 'DELETE') return sendJson(response, 200, atlas.deleteCustomField(id));
  }
  if (method === 'POST' && path === '/api/links') {
    return sendJson(response, 201, atlas.createLink(await readJson(request, limits.body)));
  }
  match = /^\/api\/links\/([^/]+)$/.exec(path);
  if (match) {
    const id = decodeSegment(match[1]);
    if (method === 'PATCH') return sendJson(response, 200, atlas.patchLink(id, await readJson(request, limits.body)));
    if (method === 'DELETE') return sendJson(response, 200, atlas.deleteLink(id));
  }
  if (method === 'POST' && path === '/api/export') {
    const body = requirePassphraseBody(await readJson(request, limits.body));
    const exported = await atlas.exportV2(body.passphrase);
    response.writeHead(200, {
      'Content-Type': exported.contentType,
      'Content-Length': exported.byteLength,
      'Content-Disposition': `attachment; filename="${exported.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(Readable.from(exported.stream), response);
    return;
  }
  if (method === 'POST' && path === '/api/import') {
    const body = requirePassphraseBody(await readJson(request, limits.import), true);
    return sendJson(response, 200, await atlas.import(body.passphrase, body.envelope));
  }
  if (method === 'POST' && path === '/api/import-uploads') {
    return sendJson(response, 201, await atlas.stageImportUpload(request, { maxBytes: limits.upload }));
  }
  match = /^\/api\/import-uploads\/([^/]+)\/commit$/.exec(path);
  if (match && method === 'POST') {
    const body = requirePassphraseBody(await readJson(request, limits.body));
    return sendJson(response, 200, await atlas.commitImportUpload(decodeSegment(match[1]), body.passphrase));
  }
  match = /^\/api\/import-uploads\/([^/]+)$/.exec(path);
  if (match && method === 'DELETE') return sendJson(response, 200, await atlas.cancelImportUpload(decodeSegment(match[1])));
  fail(404, 'NOT_FOUND', 'API endpoint not found.');
}

async function serveStatic(response, pathname, publicRoot) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { fail(400, 'INVALID_PATH', 'Request path contains invalid encoding.'); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  let file = resolve(publicRoot, relative);
  const rootPrefix = publicRoot.endsWith(sep) ? publicRoot : `${publicRoot}${sep}`;
  if (file !== publicRoot && !file.startsWith(rootPrefix)) fail(404, 'NOT_FOUND', 'File not found.');
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    if (extname(relative)) fail(404, 'NOT_FOUND', 'File not found.');
    file = resolve(publicRoot, 'index.html');
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
    } catch {
      fail(404, 'NOT_FOUND', 'File not found.');
    }
  }
  const body = await readFile(file);
  response.writeHead(200, {
    'Content-Type': MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

export function createServer({
  atlas = new Atlas(),
  publicDir = fileURLToPath(new URL('../public', import.meta.url)),
  bodyLimit = DEFAULT_BODY_LIMIT,
  importLimit = DEFAULT_IMPORT_LIMIT,
  uploadLimit = BACKUP_UPLOAD_MAX_BYTES,
} = {}) {
  const publicRoot = resolve(publicDir);
  const server = createNodeServer(async (request, response) => {
    try {
      const host = request.headers.host ?? '';
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) {
        fail(400, 'INVALID_HOST', 'Host header must identify the local server.');
      }
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        await routeApi(atlas, request, response, url, { body: bodyLimit, import: importLimit, upload: uploadLimit });
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        await serveStatic(response, url.pathname, publicRoot);
      } else {
        fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!request.complete && !request.destroyed) request.resume();
      const result = errorBody(error);
      sendJson(response, result.status, result.body);
    }
  });
  server.on('close', () => atlas.close());
  return server;
}

export async function listen(server, { port = 4817 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', onError);
      resolvePromise(server.address());
    });
  });
}
