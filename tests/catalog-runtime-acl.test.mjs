import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createCatalogStore } from '../services/auth-api/src/catalog/store.mjs';
import { exportCatalogRows } from '../services/auth-api/src/catalog/import-contract.mjs';
import { createTeacherStore } from '../services/auth-api/src/teacher-store.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const nativeUrl = process.env.CATALOG_NATIVE_DATABASE_URL;
const roles = {
  schema_owner: 'catalog_acl_schema', migration_user: 'catalog_acl_migrator', migration_password: 'synthetic-migrator',
  runtime_user: 'catalog_acl_runtime', runtime_password: 'synthetic-runtime',
  import_user: 'catalog_acl_import', import_password: 'synthetic-import',
  backup_user: 'catalog_acl_backup', backup_password: 'synthetic-backup',
};

// Execute the checked-in runner's generated SQL, rather than reproducing its
// GRANT policy in a fixture. Only database CONNECT ACLs are unsupported by PGlite.
async function psqlRoleBlock(db, block) {
  const pieces = block.replace(/:'([a-z_]+)'/gu, (_, key) => {
    assert.ok(Object.hasOwn(roles, key), `unknown runner variable ${key}`);
    return `'${roles[key].replaceAll("'", "''")}'`;
  }).split('\\gexec');
  for (let index = 0; index < pieces.length; index++) {
    const sql = pieces[index].trim();
    if (!sql) continue;
    const results = await db.exec(sql);
    if (index === pieces.length - 1) continue;
    for (const result of results) for (const row of result.rows) {
      assert.deepEqual(Object.keys(row), ['format']);
      if (!nativeUrl && /^(?:GRANT|REVOKE) .+ ON DATABASE /u.test(row.format)) continue;
      await db.exec(row.format);
    }
  }
}

const baseline = {
  courses: {
    catalogId: `course-v1:${'a'.repeat(64)}`, generatedAt: '2026-01-01T00:00:00Z', source: 'synthetic ACL fixture', disclaimer: '',
    periods: [{ block: 1, label: '第一大节', time: '08:00–09:35' }], buildings: ['之远楼'],
    colleges: [{ name: '合成学院', majorIds: ['major-1'] }], majors: [{ id: 'major-1', name: '合成专业', college: '合成学院', aliases: [] }], majorAliases: [], semesters: [], publicElectives: [], majorCourses: [], quality: {},
    courses: [{ id: '21040022', title: '合成课程', college: '合成学院', credits: '2.00', category: '专业', property: '必修', textbook: '', publisher: '', author: '', terms: ['fall'], teachers: ['合成教师'] }],
    schedules: [{ id: 'fall-21040022-01-1', sectionId: 'fall-21040022-01-2', sourceRow: '2', meetingIndex: 1, term: 'fall', courseId: '21040022', title: '合成课程', teacher: '合成教师', weekday: 1, block: 1, periods: [1, 2], weeks: [1, 2, 3], timeText: '1-3周 星期一 第1-2节', building: '之远楼', room: '101', classNames: '合成2401', linked: false }],
  },
  materials: { schemaVersion: 2, generatedAt: '2026-01-01T00:00:00Z', materials: [] },
};

async function fixture(t) {
  let db;
  if (nativeUrl) {
    // Only an explicitly configured disposable, loopback-only test database.
    const url = new URL(nativeUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'native catalog ACL tests require a local isolated database');
    assert.match(url.pathname, /^\/catalog_acl_ci_[a-z0-9_]+$/u, 'native catalog ACL tests require a generated CI database name');
    const client = new pg.Client({ connectionString: nativeUrl, connectionTimeoutMillis: 3000, query_timeout: 15000 });
    await client.connect();
    db = {
      waitReady: Promise.resolve(),
      async exec(sql) { const result = await client.query(sql); return Array.isArray(result) ? result : [result]; },
      query: (sql, values) => client.query(sql, values),
      close: () => client.end(),
    };
    const version = (await db.query('SHOW server_version_num')).rows[0].server_version_num;
    assert.ok(Number(version) >= 170000, 'native catalog ACL tests require PostgreSQL 17+');
  } else db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  const runner = await read('ops/postgres/run-migrations.sh');
  const blocks = [...runner.matchAll(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/gu)].map(match => match[1]);
  const setup = blocks.find(block => block.includes('CREATE ROLE %I NOLOGIN'));
  const grants = blocks.find(block => block.includes("CREATE ROLE %I LOGIN', :'runtime_user'"));
  assert.ok(setup && grants, 'the checked-in runner must expose role and ACL blocks');
  await psqlRoleBlock(db, setup);
  await db.exec(`SET ROLE ${roles.schema_owner}`);
  await db.exec('CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const names = (await readdir(new URL('../ops/postgres/migrations/', import.meta.url))).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
  assert.ok(names.includes('0029_catalog_publications.sql'));
  for (const name of names) {
    const sql = await read(`ops/postgres/migrations/${name}`);
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
  }
  await db.exec('RESET ROLE');
  await psqlRoleBlock(db, grants);
  let nativeRuntime;
  if (nativeUrl) {
    const url = new URL(nativeUrl);
    nativeRuntime = new pg.Pool({ host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)), user: roles.runtime_user, password: roles.runtime_password, max: 4, connectionTimeoutMillis: 3000, query_timeout: 15000 });
    t.after(() => nativeRuntime.end());
  }
  let tail = Promise.resolve();
  async function lease(role) {
    const previous = tail;
    let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    if (nativeRuntime && role === roles.runtime_user) {
      let client;
      try { client = await nativeRuntime.connect(); } catch (error) { unlock(); throw error; }
      return { query: (sql, values) => client.query(sql, values), release() { client.release(); unlock(); } };
    }
    try { await db.exec(`SET ROLE ${role}`); } catch (error) { unlock(); throw error; }
    return {
      async query(sql, values) { const result = await db.query(sql, values); return { ...result, rowCount: result.rowCount ?? (result.rows.length || result.affectedRows || 0) }; },
      async release() { try { await db.exec('RESET ROLE'); } finally { unlock(); } },
    };
  }
  async function queryAs(role, sql, values) {
    const client = await lease(role);
    try { return await client.query(sql, values); } finally { await client.release(); }
  }
  const ownerQuery = (sql, values) => queryAs(roles.schema_owner, sql, values);
  const pool = { query: (sql, values) => queryAs(roles.runtime_user, sql, values), connect: () => lease(roles.runtime_user) };
  const userId = randomUUID(), sessionId = randomUUID(), elevationTokenHash = 'd'.repeat(64);
  await ownerQuery("INSERT INTO app_users(id,role) VALUES($1,'admin')", [userId]);
  await ownerQuery("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [sessionId, userId, 'e'.repeat(64)]);
  await ownerQuery("INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at) VALUES($1,$2,$3,'totp',now()+interval '10 minutes')", [userId, sessionId, elevationTokenHash]);
  const teacherId = randomUUID(), batchId = randomUUID(), rowId = randomUUID();
  await ownerQuery("INSERT INTO teachers(id,display_name,normalized_name,college_name,normalized_college,identity_status) VALUES($1,'合成教师','合成教师','合成学院','合成学院','active')", [teacherId]);
  await ownerQuery("INSERT INTO data_import_batches(id,import_type,source_filename,source_sha256,mapping_version,row_count,accepted_count) VALUES($1,'course_schedule_teachers','synthetic.xlsx',$2,'synthetic-v1',1,1)", [batchId, 'b'.repeat(64)]);
  await ownerQuery("INSERT INTO data_import_rows(id,batch_id,source_sheet,source_row,source_locator,content_sha256,disposition) VALUES($1,$2,'合成教学班',2,'合成教学班!A2',$3,'accepted')", [rowId, batchId, 'c'.repeat(64)]);
  await ownerQuery('INSERT INTO course_schedule_teachers(catalog_id,schedule_id,teacher_id,source_batch_id,source_row_id) VALUES($1,$2,$3,$4,$5)', [baseline.courses.catalogId, baseline.courses.schedules[0].id, teacherId, batchId, rowId]);
  const store = createCatalogStore(pool, { baselineLoader: async kind => structuredClone(baseline[kind]) });
  const input = () => ({ userId, sessionId, elevationTokenHash, requestId: randomUUID(), ipHash: 'a'.repeat(64), userAgentHash: 'b'.repeat(64) });
  const privilege = async (table, operation) => (await pool.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [table, operation])).rows[0].allowed;
  return { db, pool, ownerQuery, store, input, privilege, teacherId };
}

test(`catalog publication succeeds as the actual non-owner runtime while immutable evidence and teacher identities stay protected (${nativeUrl ? 'native PostgreSQL' : 'PGlite'})`, async t => {
  const f = await fixture(t);
  await t.test('the runtime has neither ownership nor role escalation privileges', async () => {
    const flags = (await f.pool.query('SELECT current_user, rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.deepEqual(flags, { current_user: roles.runtime_user, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    if (nativeUrl) assert.equal((await f.pool.query('SELECT session_user AS login')).rows[0].login, roles.runtime_user, 'native requests must authenticate as runtime, not SET ROLE from a superuser connection');
    const owners = (await f.pool.query("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='public' AND tablename IN ('catalog_releases','catalog_heads','catalog_drafts','catalog_schedule_origins')")).rows;
    assert.deepEqual(owners, [{ tableowner: roles.schema_owner }]);
    assert.equal((await f.pool.query('SELECT pg_has_role(current_user,$1,\'MEMBER\') AS allowed', [roles.schema_owner])).rows[0].allowed, false);
  });

  let publication, published;
  await t.test('runtime creates a draft, publishes, reads both projections and carries verified teacher origins', async () => {
    const before = await f.store.getCatalogCurrent();
    const rows = exportCatalogRows('courses', baseline.courses).map(row => ({ ...row, 课程名称: '已发布合成课程' }));
    const created = await f.store.createCatalogDraft({ ...f.input(), kind: 'courses', rows, expectedRevision: 0, sourceName: '合成课表.csv' });
    await assert.rejects(f.store.getCatalogPublicSnapshot(created.draft.version, 'full'), { code: 'CATALOG_NOT_FOUND' });
    publication = await f.store.publishCatalogDraft({ ...f.input(), draftId: created.draft.id, expectedRevision: 0, reason: '已核对合成数据后发布', acknowledgeWarnings: true });
    assert.equal(publication.current.courses.revision, 1);
    assert.notEqual(publication.current.courses.version, before.courses.version);
    const snapshot = await f.store.getCatalogPublicSnapshot(publication.current.courses.version, 'full');
    published = JSON.parse(snapshot.fullText);
    assert.equal(published.courses[0].title, '已发布合成课程');
    assert.equal(JSON.parse(snapshot.coreText).catalogId, published.catalogId);
    const teachers = await createTeacherStore(f.pool).listPublicTeachersBySchedule({ catalogId: published.catalogId, scheduleId: published.schedules[0].id });
    assert.deepEqual(teachers.map(teacher => teacher.id), [f.teacherId]);
    assert.equal((await f.pool.query('SELECT count(*)::integer AS total FROM catalog_schedule_origins WHERE catalog_id=$1', [published.catalogId])).rows[0].total, 1);
    const events = (await f.pool.query("SELECT action FROM admin_audit_events WHERE action LIKE 'admin.catalog.%' ORDER BY created_at,id")).rows;
    assert.deepEqual(new Set(events.map(event => event.action)), new Set(['admin.catalog.draft_created', 'admin.catalog.publish']));
  });

  await t.test('runtime can publish explicit material associations and read the resulting release', async () => {
    const rows = [{ 操作: '新增', 资料编号: '1'.repeat(20), 标题: '合成资料', 课程号: '21040022', 分类: '课件', 链接: 'https://example.test/synthetic.pdf', 描述: '合成外部资料' }];
    const created = await f.store.createCatalogDraft({ ...f.input(), kind: 'materials', rows, expectedRevision: 0, sourceName: '合成资料.csv' });
    const result = await f.store.publishCatalogDraft({ ...f.input(), draftId: created.draft.id, expectedRevision: 0, reason: '已核对合成资料后发布', acknowledgeWarnings: true });
    const snapshot = await f.store.getCatalogPublicSnapshot(result.current.materials.version, 'materials');
    const material = JSON.parse(snapshot.fullText).materials[0];
    assert.deepEqual(material.courseIds, ['21040022']);
    assert.equal(material.downloadUrl, rows[0].链接);
    assert.equal(material.courseTitle, '已发布合成课程');
  });

  await t.test('runtime cannot update, delete or truncate releases, publication events, audit events or teacher origins', async () => {
    for (const table of ['catalog_releases', 'catalog_publication_events', 'catalog_schedule_origins', 'admin_audit_events']) {
      for (const operation of ['UPDATE', 'DELETE', 'TRUNCATE']) assert.equal(await f.privilege(table, operation), false, `${table} ${operation}`);
      const updateColumn = table === 'catalog_schedule_origins' ? 'catalog_id' : table === 'admin_audit_events' ? 'action' : 'source_name';
      for (const sql of [`UPDATE ${table} SET ${updateColumn}=${updateColumn}`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) await assert.rejects(f.pool.query(sql), { code: '42501' });
    }
    assert.equal((await f.pool.query('SELECT count(*)::integer AS total FROM catalog_releases')).rows[0].total, 2);
    assert.equal((await f.pool.query('SELECT count(*)::integer AS total FROM catalog_schedule_origins')).rows[0].total, 1);
  });

  await t.test('runtime cannot write raw teacher identity, aliases, source links, sections or textbook facts', async () => {
    for (const table of ['teachers', 'teacher_source_identities', 'teacher_aliases', 'teacher_course_sections', 'teaching_section_textbooks', 'course_schedule_teachers']) {
      assert.equal(await f.privilege(table, 'SELECT'), true, `${table} SELECT remains necessary for public reads`);
      for (const operation of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal(await f.privilege(table, operation), false, `${table} ${operation}`);
      await assert.rejects(f.pool.query(`INSERT INTO ${table} DEFAULT VALUES`), { code: '42501' });
      const column = table === 'teachers' ? 'display_name' : 'id';
      await assert.rejects(f.pool.query(`UPDATE ${table} SET ${column}=${column}`), { code: '42501' });
      await assert.rejects(f.pool.query(`DELETE FROM ${table}`), { code: '42501' });
      await assert.rejects(f.pool.query(`TRUNCATE ${table}`), { code: '42501' });
    }
    assert.equal((await f.pool.query('SELECT display_name FROM teachers WHERE id=$1', [f.teacherId])).rows[0].display_name, '合成教师');
  });

  await t.test('head insertion/deletion is denied; rollback advances the pointer and preserves immutable prior evidence', async () => {
    for (const operation of ['INSERT', 'DELETE', 'TRUNCATE']) assert.equal(await f.privilege('catalog_heads', operation), false);
    for (const sql of ["INSERT INTO catalog_heads(kind) VALUES('courses')", 'DELETE FROM catalog_heads', 'TRUNCATE catalog_heads']) await assert.rejects(f.pool.query(sql), { code: '42501' });
    await assert.rejects(f.pool.query("UPDATE catalog_heads SET revision=revision-1 WHERE kind='courses'"), /advance exactly once/u);
    const original = await f.store.getCatalogPublicSnapshot((await f.store.getAdminCatalog(f.input())).baselineVersions.courses, 'full');
    const result = await f.store.rollbackCatalog({ ...f.input(), kind: 'courses', targetVersion: original.version, expectedRevision: 1, reason: '核对合成旧版后回退目录' });
    assert.equal(result.current.courses.revision, 2);
    assert.equal(result.current.courses.version, original.version);
    assert.equal(JSON.parse((await f.store.getCatalogPublicSnapshot(publication.current.courses.version, 'full')).fullText).courses[0].title, published.courses[0].title);
    assert.equal((await f.pool.query('SELECT count(*)::integer AS total FROM catalog_publication_events')).rows[0].total, 3);
  });
});
