import { randomUUID } from 'node:crypto';
import { applyCatalogImport } from './import-contract.mjs';
import { reconcileCatalogTeacherOrigins } from './teacher-origins.mjs';
import { CATALOG_RETENTION, catalogFailure, createSnapshotCache, decodeCatalogSnapshot, isCatalogKind, isCatalogVersion,
  loadBundledCatalogBaseline, makeCatalogSnapshot, sha256 } from './snapshots.mjs';
import { promoteCatalogFiles, removeCatalogFiles } from './uploads.mjs';

const fail = (code, details) => { throw catalogFailure(code, details); };
const iso = value => new Date(value).toISOString();
const revision = value => Number(value);
const fileUrl = row => `/resources/files/uploads/${row.id}.${row.extension}`;
const uploadPattern = /^\/resources\/files\/uploads\/([a-f0-9-]{36})\.(pdf|pptx|docx|xlsx|zip)$/u;
const publication = row => ({ id: row.id, kind: row.kind, revision: revision(row.revision), version: row.version,
  previousVersion: row.previous_version, action: row.action, reason: row.reason, sourceName: row.source_name, createdAt: iso(row.created_at) });
const draft = row => ({ id: row.id, kind: row.kind, baseRevision: revision(row.base_revision), baseVersion: row.base_version,
  version: row.version, sourceName: row.source_name, summary: row.summary, changes: row.changes, warnings: row.warnings,
  createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), published: row.publication_id !== null });

export function createCatalogStore(pool, { baselineLoader = loadBundledCatalogBaseline, uploadDir = null, now = Date.now } = {}) {
  const cache = createSnapshotCache();
  const baselineMetadata = new Map(), baselineRequests = new Map();
  const snapshotRequests = new Map();
  const publicFiles = new Map();
  let pointerCache = null;

  async function baseline(kind) {
    const meta = baselineMetadata.get(kind);
    const cached = meta && cache.get(`${kind}:${meta.version}`);
    if (cached) return cached;
    if (baselineRequests.has(kind)) return baselineRequests.get(kind);
    const promise = (async () => {
      const snapshot = await makeCatalogSnapshot(kind, await baselineLoader(kind), { baseline: true });
      baselineMetadata.set(kind, { version: snapshot.version, catalogId: snapshot.catalogId });
      return cache.put(`${kind}:${snapshot.version}`, snapshot);
    })();
    baselineRequests.set(kind, promise);
    try { return await promise; } finally { baselineRequests.delete(kind); }
  }

  async function baselineVersion(kind) {
    if (!baselineMetadata.has(kind)) await baseline(kind);
    return baselineMetadata.get(kind).version;
  }

  async function snapshot(client, kind, version) {
    if (!version || version === await baselineVersion(kind)) return baseline(kind);
    const key = `${kind}:${version}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (snapshotRequests.has(key)) return snapshotRequests.get(key);
    if (snapshotRequests.size >= 3) fail('CATALOG_READ_BUSY');
    const promise = (async () => {
      const result = await client.query('SELECT * FROM catalog_releases WHERE kind = $1 AND version = $2', [kind, version]);
      if (!result.rowCount) fail('CATALOG_NOT_FOUND');
      return cache.put(key, await decodeCatalogSnapshot(result.rows[0]));
    })();
    snapshotRequests.set(key, promise);
    try { return await promise; } finally { snapshotRequests.delete(key); }
  }

  async function heads(client, lock = '') {
    const result = await client.query(`SELECT kind, version, revision FROM catalog_heads ORDER BY kind ${lock}`);
    if (result.rowCount !== 2) fail('CATALOG_UNAVAILABLE');
    return Object.fromEntries(result.rows.map(row => [row.kind, { version: row.version, revision: revision(row.revision) }]));
  }

  async function current(client, state) {
    state ??= await heads(client);
    const output = {};
    for (const kind of ['courses', 'materials']) {
      const version = state[kind].version ?? await baselineVersion(kind);
      const prefix = `/api/catalog/releases/${version}`;
      output[kind] = { revision: state[kind].revision, version,
        ...(kind === 'courses' ? { coreUrl: `${prefix}/core`, fullUrl: `${prefix}/full` } : { url: `${prefix}/materials` }) };
    }
    return output;
  }

  async function transaction(input, work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const actor = await client.query(`SELECT users.id FROM app_users AS users
        JOIN user_sessions AS sessions ON sessions.user_id = users.id AND sessions.id = $2
          AND sessions.revoked_at IS NULL AND sessions.expires_at > now()
        JOIN admin_elevated_sessions AS elevation ON elevation.user_id = users.id
          AND elevation.base_session_id = sessions.id AND elevation.token_hash = $3
          AND elevation.revoked_at IS NULL AND elevation.expires_at > now()
        WHERE users.id = $1 AND users.role = 'admin' AND users.status = 'active'
        FOR SHARE OF users, sessions, elevation`, [input.userId, input.sessionId, input.elevationTokenHash]);
      if (!actor.rowCount) fail('AUTH_ADMIN_FORBIDDEN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function audit(client, input, action, id, metadata = {}) {
    await client.query(`INSERT INTO admin_audit_events
      (actor_user_id, actor_role, session_id, action, target_type, target_id, request_id, ip_hash, user_agent_hash, metadata)
      VALUES ($1, 'admin', $2, $3, 'catalog', $4, $5, $6, $7, $8::jsonb)`,
    [input.userId, input.sessionId, action, id, input.requestId, input.ipHash, input.userAgentHash, JSON.stringify(metadata)]);
  }

  async function lockImport(client) {
    const result = await client.query('SELECT pg_try_advisory_xact_lock(6979, 1) AS locked');
    if (!result.rows[0]?.locked) fail('CATALOG_IMPORT_BUSY');
  }

  async function assertReferences(client, materials, courses, input) {
    const courseIds = new Set(courses.courses.map(item => item.id));
    const base = JSON.parse((await baseline('materials')).fullText);
    const baselineUrls = new Set(base.materials.flatMap(item => [item.downloadUrl, item.previewUrl].filter(Boolean)));
    const files = new Map();
    for (const item of materials.materials) {
      if (!Array.isArray(item.courseIds) || item.courseIds.some(id => !courseIds.has(id))) fail('CATALOG_DANGLING_MATERIAL_REFERENCE');
      for (const url of [item.downloadUrl, item.previewUrl].filter(Boolean)) {
        const match = url.match(uploadPattern);
        if (url.startsWith('/resources/files/uploads/') && !match) fail('CATALOG_INVALID_FILE_REFERENCE');
        if (match) {
          let row = files.get(match[1]);
          if (!row) {
            const result = await client.query(`SELECT * FROM catalog_files WHERE id = $1
              AND (published_at IS NOT NULL OR (actor_user_id = $2 AND expires_at > now())) FOR SHARE`, [match[1], input.userId]);
            if (!result.rowCount) fail('CATALOG_INVALID_FILE_REFERENCE');
            row = result.rows[0]; files.set(row.id, row);
          }
          if (row.extension !== match[2]) fail('CATALOG_INVALID_FILE_REFERENCE');
          item.sizeBytes = row.size_bytes;
          if (!item.catalogedAt) item.catalogedAt = iso(row.created_at);
          if (row.extension === 'pdf' && item.downloadUrl === url) { item.previewable = true; item.previewUrl = url; }
        } else if (url.startsWith('/resources/files/') && !baselineUrls.has(url)) fail('CATALOG_INVALID_FILE_REFERENCE');
      }
    }
    return [...files.values()].filter(row => row.published_at === null);
  }

  function checkRevision(state, kind, expected) {
    if (!Number.isSafeInteger(expected) || expected < 0 || state[kind].revision !== expected) fail('CATALOG_REVISION_CONFLICT');
  }

  async function appendPublication(client, input, { kind, version, state, action, sourceName, reason }) {
    const previous = state[kind].version ?? (await baseline(kind)).version;
    const nextRevision = state[kind].revision + 1;
    if (!Number.isSafeInteger(nextRevision)) fail('CATALOG_REVISION_CONFLICT');
    const result = await client.query(`INSERT INTO catalog_publication_events
      (id, kind, revision, version, previous_version, action, actor_user_id, reason, source_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(), kind, nextRevision, version, previous, action, input.userId, reason, sourceName]);
    const base = await baseline(kind);
    await client.query('UPDATE catalog_heads SET version = $2, revision = $3 WHERE kind = $1', [kind, version === base.version ? null : version, nextRevision]);
    state[kind] = { version: version === base.version ? null : version, revision: nextRevision };
    await audit(client, input, `admin.catalog.${action}`, result.rows[0].id, { kind, version, previousVersion: previous, revision: nextRevision });
    return publication(result.rows[0]);
  }

  const methods = {
    async getCatalogCurrent() {
      if (pointerCache && pointerCache.expires > now()) return pointerCache.value;
      const value = await current(pool);
      pointerCache = { value, expires: now() + 10_000 };
      return value;
    },
    async getCatalogPublicSnapshot(version, format) {
      const kind = format === 'materials' ? 'materials' : 'courses';
      if (!isCatalogVersion(version) || !['core', 'full', 'materials'].includes(format)) fail('CATALOG_NOT_FOUND');
      // A cache entry may come from an active read only; drafts are never cached.
      return snapshot(pool, kind, version);
    },
    async getCatalogPublishedFile(id, extension) {
      const key = `${id}.${extension}`;
      if (publicFiles.has(key)) return publicFiles.get(key);
      const found = await pool.query(`SELECT id, name, extension, sha256, size_bytes FROM catalog_files
        WHERE id = $1 AND extension = $2 AND published_at IS NOT NULL`, [id, extension]);
      if (!found.rowCount) fail('CATALOG_NOT_FOUND');
      const row = found.rows[0];
      publicFiles.set(key, row);
      if (publicFiles.size > 128) publicFiles.delete(publicFiles.keys().next().value);
      return row;
    },
    async getAdminCatalog(input) {
      return transaction(input, async client => {
        const state = await heads(client);
        const history = (await client.query('SELECT * FROM catalog_publication_events ORDER BY created_at DESC, id DESC LIMIT 40')).rows.map(publication);
        const drafts = (await client.query(`SELECT * FROM catalog_drafts WHERE actor_user_id = $1 AND expires_at > now()
          AND publication_id IS NULL ORDER BY created_at DESC LIMIT 3`, [input.userId])).rows.map(draft);
        await audit(client, input, 'admin.catalog.viewed', null);
        return { current: await current(client, state), history, drafts, uploadsEnabled: Boolean(uploadDir),
          baselineVersions: Object.fromEntries(await Promise.all(['courses', 'materials'].map(async kind => [kind, await baselineVersion(kind)]))) };
      });
    },
    async getAdminCatalogDraft(input) {
      return transaction(input, async client => {
        const result = await client.query(`SELECT * FROM catalog_drafts WHERE id = $1 AND actor_user_id = $2 AND expires_at > now()`, [input.draftId, input.userId]);
        if (!result.rowCount) fail('CATALOG_NOT_FOUND');
        return draft(result.rows[0]);
      });
    },
    async discardCatalogDraft(input) {
      return transaction(input, async client => {
        const result = await client.query(`DELETE FROM catalog_drafts WHERE id = $1 AND actor_user_id = $2
          AND publication_id IS NULL RETURNING id, kind`, [input.draftId, input.userId]);
        if (!result.rowCount) fail('CATALOG_NOT_FOUND');
        await audit(client, input, 'admin.catalog.draft_discarded', result.rows[0].id, { kind: result.rows[0].kind });
        return { discarded: true };
      });
    },
    async createCatalogDraft(input) {
      return transaction(input, async client => {
        await lockImport(client);
        const state = await heads(client, 'FOR SHARE');
        const { kind, rows, expectedRevision, sourceName } = input;
        if (!isCatalogKind(kind) || !Array.isArray(rows) || !rows.length || rows.length > 10_000) fail('CATALOG_INVALID_BODY');
        checkRevision(state, kind, expectedRevision);
        await client.query('DELETE FROM catalog_drafts WHERE expires_at <= now()');
        const requestHash = sha256(JSON.stringify({ rows, sourceName }));
        const repeat = await client.query(`SELECT * FROM catalog_drafts WHERE actor_user_id = $1 AND kind = $2 AND base_revision = $3
          AND request_hash = $4 AND expires_at > now() AND publication_id IS NULL`, [input.userId, kind, expectedRevision, requestHash]);
        if (repeat.rowCount) return { draft: draft(repeat.rows[0]), created: false };
        const quota = await client.query('SELECT count(*) AS total FROM catalog_drafts WHERE actor_user_id = $1 AND publication_id IS NULL', [input.userId]);
        if (Number(quota.rows[0].total) >= 3) fail('CATALOG_DRAFT_LIMIT');
        const base = await snapshot(client, kind, state[kind].version);
        const basePayload = JSON.parse(base.fullText);
        const courses = kind === 'courses' ? basePayload : JSON.parse((await snapshot(client, 'courses', state.courses.version)).fullText);
        const result = applyCatalogImport(kind, rows, basePayload, courses);
        if (result.errors?.length) fail('CATALOG_INVALID_IMPORT', { errors: result.errors.slice(0, 100) });
        if (!result.changes?.length) fail('CATALOG_NO_CHANGES');
        if (kind === 'materials') {
          await assertReferences(client, result.payload, courses, input);
          for (const item of result.payload.materials) if (!item.catalogedAt) item.catalogedAt = new Date(now()).toISOString();
        }
        const release = await makeCatalogSnapshot(kind, result.payload);
        if (release.version === base.version) fail('CATALOG_NO_CHANGES');
        const warnings = (result.warnings ?? []).slice(0, 100);
        const changes = result.changes.slice(0, 50);
        if (Buffer.byteLength(JSON.stringify(changes)) > 100_000 || Buffer.byteLength(JSON.stringify(warnings)) > 20_000) fail('CATALOG_SIZE_LIMIT');
        const saved = await client.query(`INSERT INTO catalog_drafts
          (id,kind,actor_user_id,base_revision,base_version,course_revision,request_hash,version,full_gzip,full_size,core_gzip,core_size,catalog_id,summary,changes,warnings,source_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17) RETURNING *`,
        [randomUUID(), kind, input.userId, expectedRevision, base.version, state.courses.revision, requestHash, release.version,
          release.fullGzip, release.fullSize, release.coreGzip, release.coreSize, release.catalogId, JSON.stringify(result.summary), JSON.stringify(changes), JSON.stringify(warnings), sourceName]);
        await audit(client, input, 'admin.catalog.draft_created', saved.rows[0].id, { kind, baseRevision: expectedRevision, version: release.version, changes: result.changes.length });
        return { draft: draft(saved.rows[0]), created: true };
      });
    },
    async publishCatalogDraft(input) {
      const promoted = [];
      try {
        const result = await transaction(input, async client => {
          const state = await heads(client, 'FOR UPDATE');
          const found = await client.query(`SELECT * FROM catalog_drafts WHERE id = $1 AND actor_user_id = $2 AND expires_at > now() FOR UPDATE`, [input.draftId, input.userId]);
          if (!found.rowCount) fail('CATALOG_NOT_FOUND');
          const row = found.rows[0], kind = row.kind;
          if (row.publication_id) {
            const event = (await client.query('SELECT * FROM catalog_publication_events WHERE id = $1', [row.publication_id])).rows[0];
            return { current: await current(client, state), publication: publication(event), replayed: true };
          }
          checkRevision(state, kind, input.expectedRevision);
          if (revision(row.base_revision) !== state[kind].revision || row.base_version !== (state[kind].version ?? (await baseline(kind)).version)) fail('CATALOG_REVISION_CONFLICT');
          if (row.warnings.length && input.acknowledgeWarnings !== true) fail('CATALOG_WARNINGS_UNACKNOWLEDGED');
          const reviewed = await decodeCatalogSnapshot(row);
          const payload = JSON.parse(reviewed.fullText);
          const release = await makeCatalogSnapshot(kind, payload);
          if (release.version !== row.version) fail('CATALOG_CORRUPT_SNAPSHOT');
          const otherKind = kind === 'courses' ? 'materials' : 'courses';
          const other = JSON.parse((await snapshot(client, otherKind, state[otherKind].version)).fullText);
          if (kind === 'materials' && revision(row.course_revision) !== state.courses.revision) fail('CATALOG_COURSE_REVISION_CONFLICT');
          const staged = await assertReferences(client, kind === 'materials' ? payload : other, kind === 'courses' ? payload : other, input);
          const exists = await client.query('SELECT 1 FROM catalog_releases WHERE kind = $1 AND version = $2', [kind, row.version]);
          if (!exists.rowCount) {
            const capacity = await client.query(`SELECT count(*) AS total,
              coalesce(sum(octet_length(full_gzip) + coalesce(octet_length(core_gzip), 0)), 0) AS bytes FROM catalog_releases`);
            if (Number(capacity.rows[0].total) >= CATALOG_RETENTION.releases ||
                Number(capacity.rows[0].bytes) + release.fullGzip.length + (release.coreGzip?.length ?? 0) > CATALOG_RETENTION.compressedBytes) fail('CATALOG_RETENTION_LIMIT');
            await client.query(`INSERT INTO catalog_releases(kind,version,full_gzip,full_size,core_gzip,core_size,catalog_id,summary,source_name,created_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [kind,row.version,release.fullGzip,release.fullSize,release.coreGzip,release.coreSize,release.catalogId,JSON.stringify(row.summary),row.source_name,input.userId]);
          }
          if (staged.length) {
            if (!uploadDir) fail('CATALOG_UPLOADS_DISABLED');
            await promoteCatalogFiles(uploadDir, staged, promoted);
            for (const file of staged) await client.query('UPDATE catalog_files SET published_at = now() WHERE id = $1 AND published_at IS NULL', [file.id]);
          }
          if (kind === 'courses') await reconcileCatalogTeacherOrigins(client, {
            before: JSON.parse((await snapshot(client, 'courses', state.courses.version)).fullText), after: payload,
          });
          const event = await appendPublication(client, input, { kind, version: row.version, state, action: 'publish', sourceName: row.source_name, reason: input.reason });
          await client.query('UPDATE catalog_drafts SET publication_id = $2 WHERE id = $1', [row.id, event.id]);
          return { current: await current(client, state), publication: event };
        });
        pointerCache = null;
        try { await removeCatalogFiles(uploadDir, promoted, 'staged'); }
        catch { console.error('Catalog file staging cleanup failed'); }
        return result;
      } catch (error) {
        // A COMMIT can succeed while its response is lost. Delete promoted
        // bytes only after a fresh connection proves they were not published;
        // when the database is unavailable, the public DB guard hides orphans.
        if (promoted.length) {
          try {
            const confirmed = await pool.query('SELECT id, published_at FROM catalog_files WHERE id = ANY($1::uuid[])', [promoted.map(file => file.id)]);
            const published = new Set(confirmed.rows.filter(row => row.published_at !== null).map(row => row.id));
            await removeCatalogFiles(uploadDir, promoted.filter(file => !published.has(file.id)), 'published');
          } catch { console.error('Catalog promotion cleanup deferred'); }
        }
        throw error;
      }
    },
    async rollbackCatalog(input) {
      const result = await transaction(input, async client => {
        const state = await heads(client, 'FOR UPDATE');
        const { kind, targetVersion } = input;
        checkRevision(state, kind, input.expectedRevision);
        const base = await baseline(kind);
        if (targetVersion === (state[kind].version ?? base.version)) fail('CATALOG_NO_CHANGES');
        const target = await snapshot(client, kind, targetVersion);
        const payload = JSON.parse(target.fullText);
        const otherKind = kind === 'courses' ? 'materials' : 'courses';
        const other = JSON.parse((await snapshot(client, otherKind, state[otherKind].version)).fullText);
        const pending = await assertReferences(client, kind === 'materials' ? payload : other, kind === 'courses' ? payload : other, input);
        if (pending.length) fail('CATALOG_INVALID_FILE_REFERENCE');
        if (kind === 'courses') await reconcileCatalogTeacherOrigins(client, {
          before: JSON.parse((await snapshot(client, 'courses', state.courses.version)).fullText), after: payload,
        });
        const event = await appendPublication(client, input, { kind, version: targetVersion, state, action: 'rollback', sourceName: '历史版本回退', reason: input.reason });
        return { current: await current(client, state), publication: event };
      });
      pointerCache = null;
      return result;
    },
    async stageCatalogFile(input, receive) {
      return transaction(input, async client => {
        if (!uploadDir) fail('CATALOG_UPLOADS_DISABLED');
        await lockImport(client);
        const expired = (await client.query('DELETE FROM catalog_files WHERE published_at IS NULL AND expires_at <= now() RETURNING id, extension')).rows;
        await removeCatalogFiles(uploadDir, expired, 'staged');
        const quota = (await client.query(`SELECT count(*) FILTER (WHERE actor_user_id = $1 AND published_at IS NULL) AS own,
          count(*) FILTER (WHERE published_at IS NULL) AS total,
          coalesce(sum(size_bytes) FILTER (WHERE published_at IS NULL), 0) AS staged_bytes,
          coalesce(sum(size_bytes), 0) AS all_bytes FROM catalog_files`, [input.userId])).rows[0];
        if (Number(quota.own) >= 5 || Number(quota.total) >= 50 || Number(quota.staged_bytes) + 25 * 1024 * 1024 > 250 * 1024 * 1024 ||
            Number(quota.all_bytes) + 25 * 1024 * 1024 > 1024 * 1024 * 1024) fail('CATALOG_FILE_QUOTA');
        const file = await receive(uploadDir);
        await client.query(`INSERT INTO catalog_files(id,actor_user_id,name,extension,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6)`,
          [file.id,input.userId,file.name,file.extension,file.sha256,file.sizeBytes]);
        await audit(client, input, 'admin.catalog.file_staged', file.id, { extension: file.extension, sizeBytes: file.sizeBytes });
        return { id: file.id, url: fileUrl({ id: file.id, extension: file.extension }), name: file.name, sizeBytes: file.sizeBytes };
      });
    },
    async cleanupFailedCatalogFile(file) {
      try {
        const found = await pool.query('SELECT id FROM catalog_files WHERE id = $1', [file.id]);
        if (!found.rowCount) await removeCatalogFiles(uploadDir, [file]);
      } catch { console.error('Catalog staging cleanup deferred'); }
    },
    catalogCacheStats() { return cache.stats(); },
  };
  return methods;
}
