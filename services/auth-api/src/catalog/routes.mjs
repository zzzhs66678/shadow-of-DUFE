import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { parseCookies } from '../cookies.mjs';
import { clientAddress } from '../request-security.mjs';
import { createSharedTokenBucket } from '../rate-limit.mjs';
import { isOpaqueToken, tokenDigest } from '../tokens.mjs';
import { CATALOG_LIMITS, catalogFailure, isCatalogKind, isCatalogVersion } from './snapshots.mjs';
import { catalogFilePath, receiveCatalogFile } from './uploads.mjs';

function json(response, status, body, { publicResponse = false, head = false } = {}) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', publicResponse ? 'no-store' : 'no-store, private');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!publicResponse) { response.setHeader('Pragma', 'no-cache'); response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive'); }
  response.end(head ? undefined : JSON.stringify(body));
  return true;
}
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const exact = (value, keys, required = keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key));
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, minimum, maximum) => typeof value === 'string' && value.normalize('NFC').trim().length >= minimum &&
  value.normalize('NFC').trim().length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
function readBody(request) {
  if (String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return Promise.reject(catalogFailure('CATALOG_INVALID_BODY'));
  if (Number(request.headers['content-length'] ?? 0) > CATALOG_LIMITS.request) { request.resume(); return Promise.reject(catalogFailure('CATALOG_REQUEST_TOO_LARGE')); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', aborted);
      if (error) { request.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => { size += chunk.length; if (size > CATALOG_LIMITS.request) finish(catalogFailure('CATALOG_REQUEST_TOO_LARGE')); else chunks.push(chunk); };
    const end = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(catalogFailure('CATALOG_INVALID_BODY')); } };
    const failed = () => finish(catalogFailure('CATALOG_INVALID_BODY'));
    const aborted = () => finish(catalogFailure('CATALOG_INVALID_BODY'));
    const timer = setTimeout(() => finish(catalogFailure('CATALOG_REQUEST_TIMEOUT')), 20_000); timer.unref();
    request.on('data', data); request.on('end', end); request.on('error', failed); request.on('aborted', aborted);
  });
}

function sendSnapshot(request, response, snapshot, format) {
  const core = format === 'core';
  const gzip = core ? snapshot.coreGzip : snapshot.fullGzip;
  const full = core ? snapshot.coreText : snapshot.fullText;
  const compressed = String(request.headers['accept-encoding'] ?? '').split(',').some(value => /^gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:\s|$))[0-9.]+)?\s*$/iu.test(value.trim()));
  const etag = `"${snapshot.version}-${format}-${compressed ? 'gzip' : 'identity'}"`;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Vary', 'Accept-Encoding');
  response.setHeader('ETag', etag);
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (request.headers['if-none-match'] === etag) { response.statusCode = 304; response.end(); return true; }
  if (compressed) response.setHeader('Content-Encoding', 'gzip');
  response.setHeader('Content-Length', compressed ? gzip.length : Buffer.byteLength(full));
  response.statusCode = 200;
  response.end(request.method === 'HEAD' ? undefined : compressed ? gzip : full);
  return true;
}

async function sendFile(request, response, file, directory) {
  const handle = await open(catalogFilePath(directory, 'published', file), 'r');
  const details = await handle.stat();
  if (!details.isFile() || details.size !== file.size_bytes) { await handle.close(); throw catalogFailure('CATALOG_UNAVAILABLE'); }
  const etag = `"${file.sha256}"`;
  const types = { pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip' };
  response.setHeader('Content-Type', types[file.extension]);
  response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'self'");
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('ETag', etag);
  response.setHeader('Content-Disposition', `${file.extension === 'pdf' ? 'inline' : 'attachment'}; filename="download.${file.extension}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  if (request.headers['if-none-match'] === etag) { await handle.close(); response.statusCode = 304; response.end(); return true; }
  response.setHeader('Content-Length', details.size);
  response.statusCode = 200;
  if (request.method === 'HEAD') { await handle.close(); response.end(); return true; }
  await pipeline(handle.createReadStream(), response);
  return true;
}

export function createCatalogRequestHandler({ store, config, adminSecurity, limiters }) {
  // Acquire before buffering JSON, not after parsing it. The database lease
  // separately coordinates other instances; this gate bounds this process's
  // large request body and import allocations to one candidate at a time.
  let importBodyBusy = false;
  const bucket = (scope, capacity, refillPerSecond) => createSharedTokenBucket({ store, scope, capacity, refillPerSecond });
  function quotas() {
    return limiters ??= { read: bucket('catalog-admin-read', 120, 2),
      write: bucket('catalog-admin-write', 12, 1 / 60), file: bucket('catalog-admin-files', 5, 1 / 300) };
  }
  return async function handleCatalogRequest(request, response, url) {
    const publicRoot = '/api/catalog', adminRoot = '/api/admin/catalog';
    const admin = url.pathname === adminRoot || url.pathname.startsWith(`${adminRoot}/`);
    const publicRoute = url.pathname === publicRoot || url.pathname.startsWith(`${publicRoot}/`);
    if (!admin && !publicRoute) return false;
    try {
      if (url.search) throw catalogFailure('CATALOG_INVALID_QUERY');
      if (!admin) {
        if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return json(response, 405, { error: 'method_not_allowed' }, { publicResponse: true }); }
        if (url.pathname === `${publicRoot}/current`) return json(response, 200, await store.getCatalogCurrent(), { publicResponse: true, head: request.method === 'HEAD' });
        const fileMatch = url.pathname.match(/^\/api\/catalog\/files\/([a-f0-9-]{36})\.(pdf|pptx|docx|xlsx|zip)$/u);
        if (fileMatch && uuid(fileMatch[1])) return await sendFile(request, response,
          await store.getCatalogPublishedFile(fileMatch[1], fileMatch[2]), config.catalogUploadDir);
        const match = url.pathname.match(/^\/api\/catalog\/releases\/([a-f0-9]{64})\/(core|full|materials)$/u);
        if (!match) throw catalogFailure('CATALOG_NOT_FOUND');
        return sendSnapshot(request, response, await store.getCatalogPublicSnapshot(match[1], match[2]), match[2]);
      }
      if (!config.adminEnabled || !adminSecurity) return json(response, 404, { error: 'not_found' });
      const origin = request.headers.origin;
      if (request.headers['sec-fetch-site'] === 'cross-site' || (origin !== undefined && !config.allowedOrigins.has(origin)) ||
          (request.method !== 'GET' && !config.allowedOrigins.has(origin))) return json(response, 403, { error: 'untrusted_origin' });
      const cookies = parseCookies(request.headers.cookie), token = cookies.get(config.sessionCookie);
      const session = isOpaqueToken(token) ? await store.getDataFeedbackSession(tokenDigest(token, config.tokenPepper)) : null;
      if (!session) return json(response, 401, { error: 'authentication_required' });
      if (session.role !== 'admin') return json(response, 403, { error: 'admin_forbidden' });
      const elevation = cookies.get(config.adminCookie);
      const input = { userId: session.userId, sessionId: session.id,
        elevationTokenHash: isOpaqueToken(elevation) ? tokenDigest(elevation, config.tokenPepper) : null,
        requestId: randomUUID(), ipHash: tokenDigest(`admin-ip:${clientAddress(request, config)}`, config.tokenPepper),
        userAgentHash: tokenDigest(`admin-ua:${String(request.headers['user-agent'] ?? '')}`, config.tokenPepper) };
      response.setHeader('X-Request-ID', input.requestId);
      const access = await store.getAdminAccessState(input);
      if (!access?.elevated) return json(response, 403, { error: 'admin_mfa_required' });
      const suffix = url.pathname.slice(adminRoot.length), detail = suffix.match(/^\/drafts\/([a-f0-9-]{36})(\/publish)?$/iu);
      const get = request.method === 'GET';
      if (!((get && (suffix === '' || (detail && !detail[2]))) || (request.method === 'DELETE' && detail && !detail[2]) || (request.method === 'POST' &&
          (['/drafts', '/rollback', '/files'].includes(suffix) || (detail && detail[2]))))) {
        response.setHeader('Allow', suffix === '' ? 'GET' : detail && !detail[2] ? 'GET, DELETE' : 'POST');
        return json(response, 405, { error: 'method_not_allowed' });
      }
      const limiter = get ? quotas().read : suffix === '/files' ? quotas().file : quotas().write;
      if (!(await limiter.consume(tokenDigest(`catalog-admin:${input.userId}`, config.tokenPepper)))) {
        response.setHeader('Retry-After', get ? '1' : '60'); return json(response, 429, { error: 'catalog_rate_limited' });
      }
      if (get && suffix === '') return json(response, 200, await store.getAdminCatalog(input));
      if (get && detail && uuid(detail[1])) return json(response, 200, { draft: await store.getAdminCatalogDraft({ ...input, draftId: detail[1] }) });
      if (request.method === 'DELETE' && detail && uuid(detail[1])) return json(response, 200, await store.discardCatalogDraft({ ...input, draftId: detail[1] }));
      if (suffix === '/files') {
        if (String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') throw catalogFailure('CATALOG_INVALID_FILE');
        let received;
        try {
          const file = await store.stageCatalogFile(input, async directory => received = await receiveCatalogFile(request, directory, request.headers['x-file-name']));
          return json(response, 201, { file });
        } catch (error) {
          if (received) await store.cleanupFailedCatalogFile(received);
          throw error;
        }
      }
      if (suffix === '/drafts') {
        if (importBodyBusy) { request.resume(); throw catalogFailure('CATALOG_IMPORT_BUSY'); }
        importBodyBusy = true;
        try {
          const body = await readBody(request);
          if (!exact(body, ['kind', 'rows', 'expectedRevision', 'sourceName']) || !isCatalogKind(body.kind) ||
              !validRevision(body.expectedRevision) || !text(body.sourceName, 1, 160) || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > CATALOG_LIMITS.rows) throw catalogFailure('CATALOG_INVALID_BODY');
          const result = await store.createCatalogDraft({ ...input, ...body, sourceName: body.sourceName.normalize('NFC').trim() });
          return json(response, result.created ? 201 : 200, { draft: result.draft });
        } finally { importBodyBusy = false; }
      }
      const body = await readBody(request);
      if (detail?.[2] && uuid(detail[1])) {
        if (!exact(body, ['expectedRevision', 'reason', 'acknowledgeWarnings']) || !validRevision(body.expectedRevision) ||
            !text(body.reason, 8, 500) || typeof body.acknowledgeWarnings !== 'boolean') throw catalogFailure('CATALOG_INVALID_BODY');
        return json(response, 200, await store.publishCatalogDraft({ ...input, ...body, reason: body.reason.normalize('NFC').trim(), draftId: detail[1] }));
      }
      if (suffix === '/rollback') {
        if (!exact(body, ['kind', 'targetVersion', 'expectedRevision', 'reason']) || !isCatalogKind(body.kind) ||
            !isCatalogVersion(body.targetVersion) || !validRevision(body.expectedRevision) || !text(body.reason, 8, 500)) throw catalogFailure('CATALOG_INVALID_BODY');
        return json(response, 200, await store.rollbackCatalog({ ...input, ...body, reason: body.reason.normalize('NFC').trim() }));
      }
      throw catalogFailure('CATALOG_NOT_FOUND');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return true; }
      const errors = {
        AUTH_ADMIN_FORBIDDEN: [403, 'admin_mfa_required'], CATALOG_NOT_FOUND: [404, 'catalog_not_found'],
        CATALOG_INVALID_BODY: [400, 'invalid_catalog_body'], CATALOG_INVALID_QUERY: [400, 'invalid_catalog_query'],
        CATALOG_INVALID_IMPORT: [400, 'invalid_catalog_import'], CATALOG_NO_CHANGES: [400, 'catalog_no_changes'],
        CATALOG_WARNINGS_UNACKNOWLEDGED: [400, 'catalog_warnings_unacknowledged'],
        CATALOG_REVISION_CONFLICT: [409, 'catalog_revision_conflict'], CATALOG_COURSE_REVISION_CONFLICT: [409, 'catalog_course_revision_conflict'],
        CATALOG_DANGLING_MATERIAL_REFERENCE: [409, 'catalog_dangling_material_reference'], CATALOG_INVALID_FILE_REFERENCE: [400, 'catalog_invalid_file_reference'],
        CATALOG_SIZE_LIMIT: [413, 'catalog_size_limit'], CATALOG_REQUEST_TOO_LARGE: [413, 'catalog_request_too_large'],
        CATALOG_REQUEST_TIMEOUT: [408, 'catalog_request_timeout'], CATALOG_IMPORT_BUSY: [429, 'catalog_import_busy'],
        CATALOG_DRAFT_LIMIT: [429, 'catalog_draft_limit'], CATALOG_FILE_QUOTA: [429, 'catalog_file_quota'],
        CATALOG_RETENTION_LIMIT: [409, 'catalog_retention_limit'], CATALOG_UPLOADS_DISABLED: [503, 'catalog_uploads_disabled'],
        CATALOG_INVALID_FILE: [400, 'catalog_invalid_file'], CATALOG_INVALID_FILE_NAME: [400, 'catalog_invalid_file_name'],
      };
      const [status, code] = errors[error?.code] ?? [503, 'service_unavailable'];
      if (error?.code === 'CATALOG_IMPORT_BUSY') response.setHeader('Retry-After', '1');
      return json(response, status, { error: code, ...(error?.code === 'CATALOG_INVALID_IMPORT' ? { errors: error.errors } : {}) }, { publicResponse: !admin, head: request.method === 'HEAD' });
    }
  };
}
