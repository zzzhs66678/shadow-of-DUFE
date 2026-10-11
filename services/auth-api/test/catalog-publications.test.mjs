import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createCatalogStore } from '../src/catalog/store.mjs';
import { createCatalogRequestHandler } from '../src/catalog/routes.mjs';
import { exportCatalogRows } from '../src/catalog/import-contract.mjs';
import { makeCatalogSnapshot, createSnapshotCache } from '../src/catalog/snapshots.mjs';
import { catalogFilePath, receiveCatalogFile } from '../src/catalog/uploads.mjs';
import { createAuthStore } from '../src/db.mjs';
import { createAuthServer } from '../src/server.mjs';
import { createTeacherStore } from '../src/teacher-store.mjs';
import { createOpaqueToken, tokenDigest } from '../src/tokens.mjs';

const origin = 'https://catalog.test';
const config = { tokenPepper: 'synthetic-catalog-test-pepper-0123456789', allowedOrigins: new Set([origin]),
  sessionCookie: '__Host-catalog-session', adminCookie: '__Host-catalog-mfa', deviceCookie: '__Host-catalog-device',
  adminEnabled: true, credentialsEnabled: false, wechatMode: 'disabled', passwordResetMode: 'disabled', emailVerificationMode: 'disabled' };
const baselines = {
  courses: { catalogId: `course-v1:${'a'.repeat(64)}`, generatedAt: '2026-01-01T00:00:00.000Z', source: 'synthetic fixture', disclaimer: '',
    periods: [{ block: 1, label: '第一大节', time: '08:00–09:35' }], buildings: ['之远楼'], colleges: [{ name: '测试学院', majorIds: ['major-1'] }],
    majors: [{ id: 'major-1', name: '测试专业', college: '测试学院', aliases: [] }], majorAliases: [], semesters: [], publicElectives: [], majorCourses: [], quality: {},
    courses: [{ id: '21040022', title: '测试课程', college: '测试学院', credits: '2.00', category: '专业', property: '必修', textbook: '', publisher: '', author: '', terms: ['fall'], teachers: ['合成教师'] }],
    schedules: [{ id: 'fall-21040022-01-1', sectionId: 'fall-21040022-01-2', sourceRow: '2', meetingIndex: 1, term: 'fall',
      courseId: '21040022', title: '测试课程', teacher: '合成教师', weekday: 1, block: 1, periods: [1, 2], weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      timeText: '1-9周 星期一 第1-2节', building: '之远楼', room: '101', classNames: '测试2401', linked: false }] },
  materials: { generatedAt: '2026-01-01T00:00:00.000Z', materials: [] },
};
const clone = value => structuredClone(value);
const courseRows = title => exportCatalogRows('courses', baselines.courses).map(row => ({ ...row, 课程名称: title }));

async function fixture(t) {
  const db = new PGlite(); await db.waitReady;
  t.after(() => db.close());
  const directory = new URL('../../../ops/postgres/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(await readFile(new URL('0029_catalog_publications.sql', directory), 'utf8'));
  const query = async (sql, values) => { const result = await db.query(sql, values); return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }; };
  let tail = Promise.resolve();
  const pool = { query, async connect() { const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous; return { query, release }; } };
  const uploadDir = await mkdtemp(join(tmpdir(), 'catalog-synthetic-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const auth = createAuthStore(pool);
  const store = { ...auth, ...createCatalogStore(pool, { baselineLoader: async kind => clone(baselines[kind]), uploadDir }) };
  const users = {};
  for (const kind of ['admin', 'other', 'user']) {
    const userId = randomUUID(), sessionId = randomUUID(), token = createOpaqueToken(), elevation = createOpaqueToken();
    await query('INSERT INTO app_users(id,role) VALUES($1,$2)', [userId, kind === 'user' ? 'user' : 'admin']);
    await query("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [sessionId,userId,tokenDigest(token,config.tokenPepper)]);
    if (kind !== 'user') await query("INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at) VALUES($1,$2,$3,'totp',now()+interval '10 minutes')", [userId,sessionId,tokenDigest(elevation,config.tokenPepper)]);
    users[kind] = { userId, sessionId, elevationTokenHash: tokenDigest(elevation,config.tokenPepper),
      cookie: `${config.sessionCookie}=${token}; ${config.adminCookie}=${elevation}` };
  }
  const input = (actor = 'admin') => ({ ...users[actor], requestId: randomUUID(), ipHash: 'a'.repeat(64), userAgentHash: 'b'.repeat(64) });
  return { db, pool, query, store, users, input, uploadDir };
}

test('catalog SQL publication preserves identities, rejects stale ABA writes and rolls all state back on audit failure', async t => {
  const f = await fixture(t);
  const baseline = await f.store.getCatalogCurrent();
  assert.equal(baseline.courses.revision, 0);
  await assert.rejects(f.store.createCatalogDraft({ ...f.input('user'), kind: 'courses', rows: courseRows('更名'), sourceName: '测试.csv', expectedRevision: 0 }), { code: 'AUTH_ADMIN_FORBIDDEN' });
  await assert.rejects(f.store.createCatalogDraft({ ...f.input(), elevationTokenHash: 'invalid', kind: 'courses', rows: courseRows('更名'), sourceName: '测试.csv', expectedRevision: 0 }), { code: 'AUTH_ADMIN_FORBIDDEN' });
  await assert.rejects(f.store.createCatalogDraft({ ...f.input(), kind: 'courses', rows: courseRows('测试课程'), sourceName: '测试.csv', expectedRevision: 0 }), { code: 'CATALOG_NO_CHANGES' });
  const first = await f.store.createCatalogDraft({ ...f.input(), kind: 'courses', rows: courseRows('新版测试课程'), sourceName: '测试.csv', expectedRevision: 0 });
  const repeated = await f.store.createCatalogDraft({ ...f.input(), kind: 'courses', rows: courseRows('新版测试课程'), sourceName: '测试.csv', expectedRevision: 0 });
  assert.equal(first.draft.id, repeated.draft.id); assert.equal(repeated.created, false);
  await assert.rejects(f.store.getAdminCatalogDraft({ ...f.input('other'), draftId: first.draft.id }), { code: 'CATALOG_NOT_FOUND' });
  await assert.rejects(f.store.getCatalogPublicSnapshot(first.draft.version, 'full'), { code: 'CATALOG_NOT_FOUND' });

  await f.db.exec(`CREATE FUNCTION fail_catalog_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action = 'admin.catalog.publish' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fail_catalog_audit BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION fail_catalog_audit();`);
  await assert.rejects(f.store.publishCatalogDraft({ ...f.input(), draftId: first.draft.id, expectedRevision: 0, reason: '合成测试核对后发布', acknowledgeWarnings: true }));
  assert.equal((await f.query('SELECT count(*) AS total FROM catalog_releases')).rows[0].total, 0);
  assert.equal((await f.query('SELECT revision FROM catalog_heads WHERE kind = $1', ['courses'])).rows[0].revision, 0);
  assert.equal((await f.query('SELECT publication_id FROM catalog_drafts WHERE id=$1', [first.draft.id])).rows[0].publication_id, null);
  await f.db.exec('DROP TRIGGER fail_catalog_audit ON admin_audit_events; DROP FUNCTION fail_catalog_audit();');

  const second = await f.store.createCatalogDraft({ ...f.input('other'), kind: 'courses', rows: courseRows('另一个候选'), sourceName: '另一个.csv', expectedRevision: 0 });
  const concurrent = await Promise.allSettled([
    f.store.publishCatalogDraft({ ...f.input(), draftId: first.draft.id, expectedRevision: 0, reason: '合成测试核对后发布', acknowledgeWarnings: true }),
    f.store.publishCatalogDraft({ ...f.input('other'), draftId: second.draft.id, expectedRevision: 0, reason: '合成测试核对后发布', acknowledgeWarnings: true }),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'CATALOG_REVISION_CONFLICT');
  const published = concurrent.find(result => result.status === 'fulfilled').value;
  assert.equal(published.current.courses.revision, 1);
  const full = await f.store.getCatalogPublicSnapshot(published.current.courses.version, 'full');
  const payload = JSON.parse(full.fullText), core = JSON.parse(full.coreText);
  assert.equal(payload.catalogId, core.catalogId);
  assert.equal(payload.schedules[0].id, baselines.courses.schedules[0].id);
  assert.equal(payload.schedules[0].sectionId, baselines.courses.schedules[0].sectionId);
  assert.deepEqual(payload.schedules[0].weeks, baselines.courses.schedules[0].weeks);
  const replayed = await f.store.publishCatalogDraft({ ...f.input(), draftId: first.draft.id, expectedRevision: 0, reason: '重复提交发布的合成请求', acknowledgeWarnings: true });
  assert.equal(replayed.replayed, true); assert.equal(replayed.current.courses.revision, 1);
  const rolled = await f.store.rollbackCatalog({ ...f.input(), kind: 'courses', targetVersion: baseline.courses.version, expectedRevision: 1, reason: '合成测试确认回退旧版本' });
  assert.equal(rolled.current.courses.version, baseline.courses.version); assert.equal(rolled.current.courses.revision, 2);
  await assert.rejects(f.store.createCatalogDraft({ ...f.input(), kind: 'courses', rows: courseRows('过期的新增'), sourceName: '旧.csv', expectedRevision: 0 }), { code: 'CATALOG_REVISION_CONFLICT' });
  assert.equal(JSON.parse((await f.store.getCatalogPublicSnapshot(published.current.courses.version, 'full')).fullText).courses[0].title, '新版测试课程');
  await assert.rejects(f.query('UPDATE catalog_releases SET source_name=$1', ['tamper']), /immutable/u);
  await assert.rejects(f.query('DELETE FROM catalog_publication_events'), /immutable/u);
  await assert.rejects(f.query("UPDATE catalog_heads SET revision=revision-1 WHERE kind='courses'"), /advance/u);
});

test('material upload ownership, publish reference validation and staged visibility are enforced by SQL and HTTP', async t => {
  const f = await fixture(t);
  const handler = createCatalogRequestHandler({ store: f.store, config: { ...config, catalogUploadDir: f.uploadDir }, adminSecurity: {},
    limiters: { read: { consume: async () => true }, write: { consume: async () => true }, file: { consume: async () => true } } });
  const server = createServer(async (request, response) => { if (!(await handler(request, response, new URL(request.url, origin)))) { response.statusCode=404; response.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const admin = { Cookie: f.users.admin.cookie, Origin: origin };
  const pdf = Buffer.from('%PDF-1.7\nsynthetic PDF bytes\n%%EOF');
  const uploaded = await fetch(`${url}/api/admin/catalog/files`, { method: 'POST', headers: { ...admin, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('合成测试.pdf') }, body: pdf });
  assert.equal(uploaded.status, 201); const file = (await uploaded.json()).file;
  assert.equal(file.sizeBytes, pdf.length);
  const apiFile = `/api/catalog/files/${file.id}.pdf`;
  assert.equal((await fetch(`${url}${apiFile}`)).status, 404);
  const materialRows = [{ 操作:'新增', 资料编号:'a'.repeat(20), 标题:'合成课件.pdf', 课程号:'21040022', 分类:'课件', 链接:file.url, 描述:'合成公开资料' }];
  await assert.rejects(f.store.createCatalogDraft({ ...f.input('other'),kind:'materials',rows:materialRows,sourceName:'资料.csv',expectedRevision:0 }), { code:'CATALOG_INVALID_FILE_REFERENCE' });
  const created = await f.store.createCatalogDraft({ ...f.input(),kind:'materials',rows:materialRows,sourceName:'资料.csv',expectedRevision:0 });
  await f.store.publishCatalogDraft({ ...f.input(),draftId:created.draft.id,expectedRevision:0,reason:'核对合成资料来源后发布',acknowledgeWarnings:true });
  const publicResponse = await fetch(`${url}${apiFile}`);
  assert.equal(publicResponse.status,200); assert.match(publicResponse.headers.get('cache-control'), /immutable/u);
  assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), pdf);
  assert.equal(publicResponse.headers.get('set-cookie'),null);
  const etag = publicResponse.headers.get('etag');
  assert.equal((await fetch(`${url}${apiFile}`, { headers: { 'If-None-Match':etag } })).status,304);
  const head = await fetch(`${url}${apiFile}`, { method:'HEAD' }); assert.equal(head.status,200); assert.equal((await head.arrayBuffer()).byteLength,0);
  await assert.rejects(f.query('DELETE FROM catalog_files WHERE id=$1',[file.id]), /cannot be deleted/u);
  assert.ok((await stat(catalogFilePath(f.uploadDir,'published',{id:file.id,extension:'pdf'}))).isFile());

  assert.equal((await fetch(`${url}/api/admin/catalog`)).status,401);
  assert.equal((await fetch(`${url}/api/admin/catalog`,{headers:{Cookie:f.users.user.cookie}})).status,403);
  assert.equal((await fetch(`${url}/api/admin/catalog/drafts`,{method:'POST',headers:{...admin,Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(`${url}/api/catalog/current?limit=1`)).status,400);
  assert.equal((await fetch(`${url}/api/catalog/current`,{method:'POST'})).status,405);
  const current = await (await fetch(`${url}/api/catalog/current`)).json();
  const bytes = await fetch(`${url}${current.courses.fullUrl}`,{headers:{'Accept-Encoding':'identity'}});
  assert.equal(bytes.status,200); assert.equal(bytes.headers.get('set-cookie'),null); assert.match(bytes.headers.get('cache-control'),/immutable/u);
  const gzip = await fetch(`${url}${current.courses.coreUrl}`,{headers:{'Accept-Encoding':'gzip'}});
  assert.equal(gzip.headers.get('content-encoding'),'gzip'); assert.ok((await gzip.json()).catalogId);
});

test('catalog public dispatch bypasses device creation and per-reader database rate writes and fails closed', async t => {
  let publicCalls=0;
  const store={ async getCatalogCurrent(){ publicCalls++; if(publicCalls>1) throw Error('synthetic database failure'); return {courses:{revision:0},materials:{revision:0}}; },
    async getOrCreateAnonymousDevice(){throw Error('must not resolve device');} };
  const forbidden={consume:async()=>{throw Error('must not write public rate bucket');}};
  const server=createAuthServer({store,config,passwordService:null,wechatProvider:{},adminSecurity:{},rateLimiters:{read:forbidden,write:forbidden}});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/api/catalog/current`;
  const first=await fetch(url); assert.equal(first.status,200); assert.equal(first.headers.get('set-cookie'),null);
  const second=await fetch(url); assert.equal(second.status,503); assert.deepEqual(await second.json(),{error:'service_unavailable'});
});

test('draft JSON buffering and generation has one process slot and releases it after completion',async t=>{
  let entered, finish, calls=0;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{finish=resolve;});
  const token=createOpaqueToken(),elevation=createOpaqueToken();
  const store={async getDataFeedbackSession(){return{id:randomUUID(),userId:randomUUID(),role:'admin'};},
    async getAdminAccessState(){return{elevated:true};},async createCatalogDraft(){calls++;entered();if(calls===1)await gate;return{created:true,draft:{id:randomUUID()}};}};
  const unlimited={consume:async()=>true};
  const handler=createCatalogRequestHandler({store,config,adminSecurity:{},limiters:{read:unlimited,write:unlimited,file:unlimited}});
  const server=createServer(async(request,response)=>{await handler(request,response,new URL(request.url,origin));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{finish();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/api/admin/catalog/drafts`;
  const headers={Origin:origin,Cookie:`${config.sessionCookie}=${token}; ${config.adminCookie}=${elevation}`,'Content-Type':'application/json'};
  const body=JSON.stringify({kind:'courses',rows:[{课程号:'21040022'}],sourceName:'合成.csv',expectedRevision:0});
  const first=fetch(url,{method:'POST',headers,body});await started;
  // Even malformed concurrent JSON is rejected before it is parsed or reaches
  // the database; a release of the first slot allows a later valid request.
  const concurrent=await fetch(url,{method:'POST',headers,body:'not JSON'});
  assert.equal(concurrent.status,429);assert.equal(concurrent.headers.get('retry-after'),'1');
  assert.deepEqual(await concurrent.json(),{error:'catalog_import_busy'});assert.equal(calls,1);
  finish();assert.equal((await first).status,201);
  assert.equal((await fetch(url,{method:'POST',headers,body})).status,201);assert.equal(calls,2);
});

test('snapshot cache has strict byte and record bounds, and metadata changes affect course identity',async()=>{
  const old=await makeCatalogSnapshot('courses',clone(baselines.courses));
  const changed=clone(baselines.courses); changed.courses[0].credits='3.00';
  const next=await makeCatalogSnapshot('courses',changed);
  assert.notEqual(old.version,next.version); assert.notEqual(old.catalogId,next.catalogId);
  const cache=createSnapshotCache({maximum:3,maxBytes:100000});
  for(let index=0;index<5;index++)cache.put(String(index),old);
  assert.equal(cache.stats().entries,3); assert.ok(cache.stats().bytes<=100000);
});

test('verified teacher origins follow unchanged identities, never names, survive rollback and honor source withdrawal',async t=>{
  const f=await fixture(t), teacherId=randomUUID(), sameNameOther=randomUUID(), batch=randomUUID(), row=randomUUID();
  for(const [id,college] of [[teacherId,'学院甲'],[sameNameOther,'学院乙']])await f.query(`INSERT INTO teachers
    (id,display_name,normalized_name,college_name,normalized_college,identity_status) VALUES($1,'合成教师','合成教师',$2,$2,'active')`,[id,college]);
  await f.query(`INSERT INTO data_import_batches(id,import_type,source_filename,source_sha256,mapping_version,row_count,accepted_count)
    VALUES($1,'course_schedule_teachers','synthetic.xlsx',$2,'synthetic-v1',1,1)`,[batch,'b'.repeat(64)]);
  await f.query(`INSERT INTO data_import_rows(id,batch_id,source_sheet,source_row,source_locator,content_sha256,disposition)
    VALUES($1,$2,'合成教学班',2,'合成教学班!A2',$3,'accepted')`,[row,batch,'c'.repeat(64)]);
  await f.query(`INSERT INTO course_schedule_teachers(catalog_id,schedule_id,teacher_id,source_batch_id,source_row_id)
    VALUES($1,$2,$3,$4,$5)`,[baselines.courses.catalogId,baselines.courses.schedules[0].id,teacherId,batch,row]);
  const teachers=createTeacherStore(f.pool);
  const first=await f.store.createCatalogDraft({...f.input(),kind:'courses',rows:courseRows('目录名称变更'),sourceName:'教师测试.csv',expectedRevision:0});
  const published=await f.store.publishCatalogDraft({...f.input(),draftId:first.draft.id,expectedRevision:0,reason:'核对稳定教师来源后发布',acknowledgeWarnings:true});
  const data=JSON.parse((await f.store.getCatalogPublicSnapshot(published.current.courses.version,'full')).fullText);
  const teacherLookup=async payload=>teachers.listPublicTeachersBySchedule({catalogId:payload.catalogId,scheduleId:payload.schedules[0].id});
  assert.deepEqual((await teacherLookup(data)).map(item=>item.id),[teacherId]);
  assert.ok(!(await teacherLookup(data)).some(item=>item.id===sameNameOther));
  const changed=exportCatalogRows('courses',data).map(item=>({...item,教师:'另一合成教师'}));
  const next=await f.store.createCatalogDraft({...f.input(),kind:'courses',rows:changed,sourceName:'改教师.csv',expectedRevision:1});
  assert.ok(next.draft.warnings.length);
  await assert.rejects(f.store.publishCatalogDraft({...f.input(),draftId:next.draft.id,expectedRevision:1,reason:'核对身份变更后发布',acknowledgeWarnings:false}),{code:'CATALOG_WARNINGS_UNACKNOWLEDGED'});
  const nextPublished=await f.store.publishCatalogDraft({...f.input(),draftId:next.draft.id,expectedRevision:1,reason:'核对身份变更后发布',acknowledgeWarnings:true});
  const nextData=JSON.parse((await f.store.getCatalogPublicSnapshot(nextPublished.current.courses.version,'full')).fullText);
  assert.deepEqual(await teacherLookup(nextData),[]);
  await f.store.rollbackCatalog({...f.input(),kind:'courses',targetVersion:published.current.courses.version,expectedRevision:2,reason:'核对恢复之前的教学班'});
  assert.deepEqual((await teacherLookup(data)).map(item=>item.id),[teacherId]);
  await f.query("UPDATE course_schedule_teachers SET record_status='withdrawn' WHERE teacher_id=$1",[teacherId]);
  assert.deepEqual(await teacherLookup(data),[]);
  await assert.rejects(f.query('DELETE FROM catalog_schedule_origins'),/immutable/u);
});

test('materials drafts become stale after course publication; owner discard frees the bounded draft quota',async t=>{
  const f=await fixture(t);
  const material=[{操作:'新增',资料编号:'d'.repeat(20),标题:'合成链接资料',课程号:'21040022',分类:'文档',链接:'https://example.test/notes.pdf',描述:''}];
  const created=await f.store.createCatalogDraft({...f.input(),kind:'materials',rows:material,sourceName:'链接.csv',expectedRevision:0});
  const course=await f.store.createCatalogDraft({...f.input(),kind:'courses',rows:courseRows('新的课程名称'),sourceName:'课程.csv',expectedRevision:0});
  await f.store.publishCatalogDraft({...f.input(),draftId:course.draft.id,expectedRevision:0,reason:'核对课程名称后发布',acknowledgeWarnings:true});
  await assert.rejects(f.store.publishCatalogDraft({...f.input(),draftId:created.draft.id,expectedRevision:0,reason:'核对资料课程关联后发布',acknowledgeWarnings:true}),{code:'CATALOG_COURSE_REVISION_CONFLICT'});
  await assert.rejects(f.store.discardCatalogDraft({...f.input('other'),draftId:created.draft.id}),{code:'CATALOG_NOT_FOUND'});
  assert.deepEqual(await f.store.discardCatalogDraft({...f.input(),draftId:created.draft.id}),{discarded:true});
  await assert.rejects(f.store.getAdminCatalogDraft({...f.input(),draftId:created.draft.id}),{code:'CATALOG_NOT_FOUND'});
  assert.equal((await f.query("SELECT count(*) AS total FROM admin_audit_events WHERE action='admin.catalog.draft_discarded'")).rows[0].total,1);
});

test('file promotion rolls back on failed audit but a lost COMMIT acknowledgement never removes committed public bytes',async t=>{
  const f=await fixture(t);
  const request=new PassThrough();request.headers={};request.end('%PDF-1.7\nsynthetic durable file\n%%EOF');
  const file=await f.store.stageCatalogFile(f.input(),directory=>receiveCatalogFile(request,directory,encodeURIComponent('提交故障测试.pdf')));
  const rows=[{操作:'新增',资料编号:'e'.repeat(20),标题:'提交故障测试.pdf',课程号:'21040022',分类:'课件',链接:file.url,描述:''}];
  const created=await f.store.createCatalogDraft({...f.input(),kind:'materials',rows,sourceName:'文件测试.csv',expectedRevision:0});
  await f.db.exec(`CREATE FUNCTION catalog_file_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='admin.catalog.publish' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER catalog_file_audit_failure BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION catalog_file_audit_failure();`);
  const publish=()=>({...f.input(),draftId:created.draft.id,expectedRevision:0,reason:'核对资料后提交合成发布',acknowledgeWarnings:true});
  await assert.rejects(f.store.publishCatalogDraft(publish()),/synthetic audit failure/u);
  await assert.rejects(stat(catalogFilePath(f.uploadDir,'published',{id:file.id,extension:'pdf'})),{code:'ENOENT'});
  assert.ok((await stat(catalogFilePath(f.uploadDir,'staged',{id:file.id,extension:'pdf'}))).isFile());
  assert.equal((await f.query('SELECT published_at FROM catalog_files WHERE id=$1',[file.id])).rows[0].published_at,null);
  await f.db.exec('DROP TRIGGER catalog_file_audit_failure ON admin_audit_events; DROP FUNCTION catalog_file_audit_failure();');
  let loseCommit=true;
  const lossyPool={query:f.pool.query,async connect(){const client=await f.pool.connect();return{
    release:client.release,async query(sql,values){const result=await client.query(sql,values);
      if(sql==='COMMIT'&&loseCommit){loseCommit=false;throw Error('synthetic lost COMMIT acknowledgement');}return result;},
  };}};
  const store=createCatalogStore(lossyPool,{baselineLoader:async kind=>clone(baselines[kind]),uploadDir:f.uploadDir});
  await assert.rejects(store.publishCatalogDraft(publish()),/lost COMMIT acknowledgement/u);
  assert.notEqual((await f.query('SELECT published_at FROM catalog_files WHERE id=$1',[file.id])).rows[0].published_at,null);
  assert.equal((await store.getCatalogCurrent()).materials.revision,1);
  assert.ok((await stat(catalogFilePath(f.uploadDir,'published',{id:file.id,extension:'pdf'}))).isFile());
  assert.equal((await store.getCatalogPublishedFile(file.id,'pdf')).id,file.id);
  const repeated=await store.publishCatalogDraft(publish());assert.equal(repeated.replayed,true);
});
