// Synthetic loopback PostgreSQL only; does not accept a production DATABASE_URL.
// Start the disposable PG fixture on 127.0.0.1:54955 first, then:
// node --max-old-space-size=64 --max-semi-space-size=4 scripts/catalog-native-store-load-check.mjs
// CATALOG_LOAD_FULL_ROWS=1 (the default): export every row and edit one course consistently.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import pg from 'pg';
import { exportCatalogRows } from '../src/catalog/import-contract.mjs';
import { createAuthStore } from '../src/db.mjs';
import { createPasswordService } from '../src/passwords.mjs';

assert.ok(getHeapStatistics().heap_size_limit <= 128 * 1024 * 1024, 'Use the documented bounded Node flags.');
const database = `catalog_load_synthetic_${randomUUID().replaceAll('-', '')}`;
const wholeTable = process.env.CATALOG_LOAD_FULL_ROWS !== '0';
const withArgon = !process.argv.includes('--without-argon');
assert.match(database, /^catalog_load_synthetic_[a-f0-9]{32}$/u);
const connection = { host: '127.0.0.1', port: 54955, user: 'catalog_fixture_owner', database: 'postgres',
  max: 3, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 };
const control = new pg.Pool(connection);
let pool, created = false;
const phases = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const rounded = value => Number(value.toFixed(2));
let sampledPeakRss = 0;
const delay = monitorEventLoopDelay({ resolution: 1 });
let sample;

async function phase(name, work) {
  const started = performance.now();
  delay.reset();
  const result = await work();
  await pause();
  const memory = process.memoryUsage();
  sampledPeakRss = Math.max(sampledPeakRss, memory.rss);
  phases.push({ phase: name, ms: rounded(performance.now() - started - 25), rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed, eventLoopDelayMaxMs: rounded(delay.max / 1e6),
    eventLoopDelayP99Ms: rounded(delay.percentile(99) / 1e6) });
  return result;
}

try {
  await control.query(`CREATE DATABASE ${database}`);
  created = true;
  pool = new pg.Pool({ ...connection, database });
  const directory = new URL('../../../ops/postgres/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, directory), 'utf8'));
  }
  const userId = randomUUID(), sessionId = randomUUID();
  const elevationTokenHash = 'c'.repeat(64);
  await pool.query("INSERT INTO app_users(id,role) VALUES($1,'admin')", [userId]);
  await pool.query("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [sessionId, userId, 'd'.repeat(64)]);
  await pool.query("INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at) VALUES($1,$2,$3,'totp',now()+interval '10 minutes')", [userId, sessionId, elevationTokenHash]);
  const actor = () => ({ userId, sessionId, elevationTokenHash, requestId: randomUUID(), ipHash: 'a'.repeat(64), userAgentHash: 'b'.repeat(64) });
  const store = createAuthStore(pool);
  const passwords = createPasswordService();
  delay.enable();
  sample = setInterval(() => { sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss); }, 5);
  sample.unref();
  await pause();

  const baseline = await phase('real_store_full_baseline_current', () => store.getCatalogCurrent());
  let rows, facts;
  await phase('real_store_baseline_full_core_and_export_input', async () => {
    const full = await store.getCatalogPublicSnapshot(baseline.courses.version, 'full');
    const core = await store.getCatalogPublicSnapshot(baseline.courses.version, 'core');
    const payload = JSON.parse(full.fullText);
    assert.equal(payload.catalogId, JSON.parse(core.coreText).catalogId);
    const exported = exportCatalogRows('courses', payload);
    let editedRows = 1;
    if (wholeTable) {
      const target = exported[0].课程号;
      editedRows = 0;
      for (const row of exported) {
        if (row.课程号 === target) { row.课程名称 += '（本地负载验证）'; editedRows++; }
      }
      rows = exported;
    } else {
      rows = [exported[0]];
      rows[0].教材 += '（本地隔离真实数据库负载验证）';
    }
    facts = { courses: payload.courses.length, meetings: payload.schedules.length,
      fullBytes: full.fullSize, coreBytes: core.coreSize, meetingId: payload.schedules[0].id,
      sectionId: payload.schedules[0].sectionId, weeks: payload.schedules[0].weeks,
      inputRows: rows.length, editedRows, inputJsonBytes: Buffer.byteLength(JSON.stringify(rows)) };
  });
  const draft = await phase(`real_store_${wholeTable ? 'whole_table' : 'one_row'}_draft${withArgon ? '_with_two_argon_hashes' : ''}`, async () => {
    const hashes = withArgon ? Promise.all([passwords.hash('synthetic-load-password-A-20261012'), passwords.hash('synthetic-load-password-B-20261012')]) : Promise.resolve([]);
    const result = await store.createCatalogDraft({ ...actor(), kind: 'courses', rows, sourceName: 'synthetic-native-load.csv', expectedRevision: 0 });
    const values = await hashes;
    assert.equal(values.length, withArgon ? 2 : 0);
    return { ...result, hashes: values };
  });
  rows = null;
  const published = await phase(`real_store_publish${withArgon ? '_with_two_argon_verifications' : ''}`, async () => {
    const verified = withArgon ? Promise.all([passwords.verify(draft.hashes[0], 'synthetic-load-password-A-20261012'),
      passwords.verify(draft.hashes[1], 'synthetic-load-password-B-20261012')]) : Promise.resolve([]);
    const result = await store.publishCatalogDraft({ ...actor(), draftId: draft.draft.id, expectedRevision: 0,
      reason: '本机合成基线单行变更负载验证', acknowledgeWarnings: true });
    assert.deepEqual(await verified, withArgon ? [true, true] : []);
    return result;
  });
  const version = published.current.courses.version;
  assert.equal(published.current.courses.revision, 1);
  assert.notEqual(version, baseline.courses.version);
  await phase('real_store_public_published_full_core', async () => {
    const full = await store.getCatalogPublicSnapshot(version, 'full');
    const core = await store.getCatalogPublicSnapshot(version, 'core');
    const payload = JSON.parse(full.fullText), compact = JSON.parse(core.coreText);
    assert.equal(payload.catalogId, compact.catalogId);
    assert.equal(payload.courses.length, facts.courses);
    assert.equal(payload.schedules.length, facts.meetings);
    assert.equal(payload.schedules[0].id, facts.meetingId);
    assert.equal(payload.schedules[0].sectionId, facts.sectionId);
    assert.deepEqual(payload.schedules[0].weeks, facts.weeks);
  });
  const rollback = await phase('real_store_rollback_to_baseline', () => store.rollbackCatalog({ ...actor(), kind: 'courses',
    targetVersion: baseline.courses.version, expectedRevision: 1, reason: '本机合成负载验证恢复初始基线' }));
  assert.equal(rollback.current.courses.revision, 2);
  assert.equal(rollback.current.courses.version, baseline.courses.version);
  await phase('real_store_public_historical_pinned_read_after_rollback', async () => {
    assert.equal((await store.getCatalogPublicSnapshot(version, 'full')).version, version);
    assert.equal((await store.getCatalogCurrent()).courses.revision, 2);
  });
  delay.disable(); clearInterval(sample);
  console.log(JSON.stringify({ scope: 'Windows isolated native PostgreSQL plus actual auth store; no HTTP/server/container/Linux measurement.',
    wholeTable, withArgon,
    node: process.version, platform: process.platform, boundedHeapBytes: getHeapStatistics().heap_size_limit,
    phases, baseline: facts, sampledPeakRssBytes: sampledPeakRss,
    resourcePeakRssBytes: process.resourceUsage().maxRSS * 1024, finalMemory: process.memoryUsage(),
    publicationCount: Number((await pool.query('SELECT count(*) AS total FROM catalog_publication_events')).rows[0].total),
    auditCount: Number((await pool.query("SELECT count(*) AS total FROM admin_audit_events WHERE action LIKE 'admin.catalog.%'")).rows[0].total),
  }, null, 2));
} finally {
  delay.disable(); clearInterval(sample);
  await pool?.end();
  if (created) await control.query(`DROP DATABASE ${database}`);
  await control.end();
}
