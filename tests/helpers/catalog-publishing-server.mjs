// Disposable native PostgreSQL + real auth API + built app, all on loopback.
// No application endpoint is mocked; fixture endpoints expose synthetic seeds only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAdminSecurity } from '../../services/auth-api/src/admin-security.mjs';
import { loadConfig } from '../../services/auth-api/src/config.mjs';
import { createAuthStore } from '../../services/auth-api/src/db.mjs';
import { createAuthServer } from '../../services/auth-api/src/server.mjs';
import { createPasswordService } from '../../services/auth-api/src/passwords.mjs';
import { createApiRateLimiters } from '../../services/auth-api/src/rate-limit.mjs';
import { createOpaqueToken, tokenDigest } from '../../services/auth-api/src/tokens.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:3141';
const database = `catalog_publishing_ci_${randomUUID().replaceAll('-', '')}`;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const password = randomBytes(24).toString('hex');
const roles = { schema_owner: `catalog_browser_schema_${suffix}`, migration_user: `catalog_browser_migrator_${suffix}`,
  migration_password: password, runtime_user: `catalog_browser_runtime_${suffix}`, runtime_password: password,
  import_user: `catalog_browser_import_${suffix}`, import_password: password,
  backup_user: `catalog_browser_backup_${suffix}`, backup_password: password };
const temporary = await mkdtemp(join(tmpdir(), 'dufesh-catalog-browser-'));
assert.ok(resolve(temporary).startsWith(join(resolve(tmpdir()), 'dufesh-catalog-browser-')));
const dataDir = join(temporary, 'postgres');
const uploadDir = join(temporary, 'files');
let clusterStarted = false, created = false, owner, bootstrap, migrator, runtime, app, auth, gateway;
let pgConnection, pgBin;
let closing = false;
const setupOnly = process.env.CATALOG_PUBLISHING_SETUP_ONLY === '1';
let appReady = setupOnly;

async function command(binary, args) {
  const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 20_000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-12_000); });
  // pg_ctl on Windows can leave inherited pipe handles open in the detached
  // postmaster after it exits; process exit is the command completion signal.
  let code;
  try { [code] = await once(child, 'exit'); }
  finally { clearTimeout(timeout); child.stdout.destroy(); child.stderr.destroy(); }
  if (timedOut) throw new Error('Synthetic fixture command exceeded its 20 second deadline.');
  if (code !== 0) throw new Error(`Synthetic fixture command failed (${code}): ${output}`);
}

async function roleBlock(client, block) {
  const pieces = block.replace(/:'([a-z_]+)'/gu, (_, key) => {
    assert.ok(Object.hasOwn(roles, key), `Unexpected migration variable ${key}`);
    return `'${roles[key].replaceAll("'", "''")}'`;
  }).split('\\gexec');
  for (let index = 0; index < pieces.length; index++) {
    if (!pieces[index].trim()) continue;
    const queried = await client.query(pieces[index]);
    if (index === pieces.length - 1) continue;
    for (const result of Array.isArray(queried) ? queried : [queried]) {
      for (const row of result.rows) { assert.deepEqual(Object.keys(row), ['format']); await client.query(row.format); }
    }
  }
}

async function listen(server, port) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
}

async function shutdown() {
  if (closing) return;
  closing = true;
  await closeServer(auth);
  if (app && app.exitCode === null) {
    app.kill();
    await Promise.race([once(app, 'close'), new Promise(done => setTimeout(done, 5_000))]);
  }
  await runtime?.end();
  await migrator?.end();
  await bootstrap?.end();
  if (owner) {
    try {
      if (created) await owner.query(`DROP DATABASE ${database} WITH (FORCE)`);
      for (const key of ['migration_user', 'runtime_user', 'import_user', 'backup_user', 'schema_owner']) {
        assert.match(roles[key], /^catalog_browser_[a-z]+_[a-f0-9]{12}$/u);
        await owner.query(`DROP ROLE IF EXISTS ${roles[key]}`);
      }
    }
    finally { await owner.end(); }
  }
  if (clusterStarted) {
    try {
      await access(join(dataDir, 'postmaster.pid'));
      await command(join(pgBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Only this process's newly created, checked temporary directory is removed.
  await rm(temporary, { recursive: true, force: true });
  // Keep the fixture alive until native cleanup completes, so the Playwright
  // teardown cannot terminate Windows early after observing a closed gateway.
  await closeServer(gateway);
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void shutdown().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
});

try {
  await access(join(root, 'dist/server'));
  await mkdir(uploadDir);
  const supplied = process.env.CATALOG_PUBLISHING_NATIVE_CONTROL_URL;
  if (supplied) {
    assert.ok(process.env.CI, 'External native fixture connection is accepted only in CI.');
    const url = new URL(supplied);
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Use a PostgreSQL connection URL.');
    assert.equal(url.search, '', 'Connection URL query overrides are not accepted.');
    assert.equal(url.hash, '', 'Connection URL fragments are not accepted.');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable PostgreSQL must be loopback only.');
    assert.equal(url.pathname, '/postgres', 'Use the dedicated CI control database.');
    assert.ok(url.username, 'Set an explicit synthetic CI control user.');
    pgConnection = { host: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(url.port || 5432),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: 'postgres' };
  } else {
    pgBin = process.env.CATALOG_PUBLISHING_PG_BIN || (process.platform === 'win32'
      ? 'C:/Users/zzz/AppData/Local/Temp/dufesh-security-pg-20261011/node_modules/@embedded-postgres/windows-x64/native/bin' : null);
    assert.ok(pgBin, 'Set CATALOG_PUBLISHING_PG_BIN to a local PostgreSQL 17+ binary directory.');
    const extension = process.platform === 'win32' ? '.exe' : '';
    const passwordFile = join(temporary, 'synthetic-password');
    await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
    await command(join(pgBin, `initdb${extension}`), ['-D', dataDir, '-U', 'catalog_browser_fixture_owner',
      '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--no-locale', `--pwfile=${passwordFile}`]);
    clusterStarted = true;
    await command(join(pgBin, `pg_ctl${extension}`), ['-D', dataDir, '-w', '-l', join(temporary, 'postgres.log'),
      '-o', '-h 127.0.0.1 -p 54956 -F', 'start']);
    pgConnection = { host: '127.0.0.1', port: 54956, user: 'catalog_browser_fixture_owner', password, database: 'postgres' };
  }
  owner = new pg.Client({ ...pgConnection, connectionTimeoutMillis: 3_000 });
  await owner.connect();
  assert.ok(Number((await owner.query('SHOW server_version_num')).rows[0].server_version_num) >= 170000);
  await owner.query(`CREATE DATABASE ${database}`); created = true;
  const databaseConnection = pgConnection;
  bootstrap = new pg.Client({ ...databaseConnection, database });
  await bootstrap.connect();
  const runner = await readFile(join(root, 'ops/postgres/run-migrations.sh'), 'utf8');
  const blocks = [...runner.matchAll(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/gu)].map(match => match[1]);
  await roleBlock(bootstrap, blocks.find(block => block.includes('CREATE ROLE %I NOLOGIN')));
  migrator = new pg.Client({ ...databaseConnection, database, user: roles.migration_user, password });
  await migrator.connect();
  await migrator.query(`SET ROLE ${roles.schema_owner}`);
  await migrator.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const migrationDir = join(root, 'ops/postgres/migrations');
  const migrations = (await readdir(migrationDir)).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
  assert.equal(migrations.length, 29);
  for (const name of migrations) {
    const sql = await readFile(join(migrationDir, name), 'utf8');
    await migrator.query('BEGIN');
    await migrator.query(sql);
    await migrator.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
    await migrator.query('COMMIT');
  }
  await migrator.end();
  await roleBlock(bootstrap, blocks.find(block => block.includes("CREATE ROLE %I LOGIN', :'runtime_user'")));
  await bootstrap.query(`SET ROLE ${roles.schema_owner}`);

  const baselineCourses = JSON.parse(await readFile(join(root, 'public/data/course-data.json'), 'utf8'));
  const baselineMaterials = JSON.parse(await readFile(join(root, 'public/data/resource-manifest.json'), 'utf8'));
  const course = baselineCourses.courses[0], meeting = baselineCourses.schedules.find(item => item.courseId === course.id);
  const pepper = randomBytes(32).toString('hex');
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DB_PASSWORD: password, AUTH_TOKEN_PEPPER: pepper,
    AUTH_ALLOWED_ORIGINS: origin, AUTH_PUBLIC_ORIGIN: 'https://catalog-fixture.invalid', AUTH_CREDENTIALS_ENABLED: 'false',
    AUTH_PASSWORD_RESET_MODE: 'disabled', AUTH_EMAIL_VERIFICATION_MODE: 'disabled', AUTH_ADMIN_ENABLED: 'true',
    AUTH_ADMIN_MFA_ACTIVE_KEY_ID: 'fixture', AUTH_ADMIN_MFA_KEYS: JSON.stringify({ fixture: randomBytes(32).toString('base64') }),
    AUTH_ADMIN_RECOVERY_PEPPER: randomBytes(32).toString('hex'), AUTH_SESSION_COOKIE: 'catalog_fixture_session',
    AUTH_ADMIN_COOKIE: 'catalog_fixture_mfa', AUTH_DEVICE_COOKIE: 'catalog_fixture_device', AUTH_CATALOG_UPLOAD_DIR: uploadDir });
  const security = createAdminSecurity({ activeKeyId: config.adminMfaActiveKeyId, keyring: config.adminMfaKeys, recoveryPepper: config.adminRecoveryPepper });
  const seeds = {};
  for (const role of ['admin', 'user']) {
    const id = randomUUID(), sessionId = randomUUID(), token = createOpaqueToken();
    const username = `catalog-native-${role}`;
    await bootstrap.query('INSERT INTO app_users(id,role,username,normalized_username,display_name) VALUES($1,$2,$3,$3,$3)', [id, role, username]);
    await bootstrap.query("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [sessionId,id,tokenDigest(token,pepper)]);
    await bootstrap.query("INSERT INTO user_profiles(user_id,onboarding_skipped,revision,client_updated_at) VALUES($1,true,1,now())", [id]);
    seeds[role] = { id, username, cookies: [{ name: config.sessionCookie, value: token, url: origin, httpOnly: true, sameSite: 'Lax' }] };
    if (role === 'admin') {
      const enrollment = security.createEnrollment({ userId: id, accountLabel: username });
      const encrypted = enrollment.encrypted;
      await bootstrap.query(`INSERT INTO admin_mfa_credentials(id,user_id,key_id,encrypted_secret,secret_iv,secret_auth_tag)
        VALUES($1,$2,$3,$4,$5,$6)`, [enrollment.factorId,id,encrypted.keyId,encrypted.encryptedSecret,encrypted.secretIv,encrypted.secretAuthTag]);
      const elevation = createOpaqueToken();
      await bootstrap.query("INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at) VALUES($1,$2,$3,'totp',now()+interval '20 minutes')", [id,sessionId,tokenDigest(elevation,pepper)]);
      seeds.admin.cookies.push({ name: config.adminCookie, value: elevation, url: origin, httpOnly: true, sameSite: 'Strict' });
    }
  }
  const planId = randomUUID();
  await bootstrap.query('INSERT INTO user_sync_states(user_id,current_revision) VALUES($1,1)', [seeds.user.id]);
  await bootstrap.query("INSERT INTO timetable_plans(id,user_id,client_id,name,revision,client_updated_at) VALUES($1,$2,'original-plan','合成原始课表',1,now())", [planId,seeds.user.id]);
  await bootstrap.query('INSERT INTO timetable_plan_schedules(user_id,plan_id,schedule_id,revision,client_updated_at) VALUES($1,$2,$3,1,now())', [seeds.user.id,planId,meeting.id]);
  await bootstrap.query("INSERT INTO user_settings(user_id,active_plan_client_id,revision,client_updated_at) VALUES($1,'original-plan',1,now())", [seeds.user.id]);
  await bootstrap.query("INSERT INTO user_assignments(user_id,client_id,course_id,title,due_date,revision,client_updated_at) VALUES($1,'original-assignment',$2,'合成原始作业','2026-12-01',1,now())", [seeds.user.id,course.id]);
  await bootstrap.end();

  runtime = new pg.Pool({ ...databaseConnection, database, user: roles.runtime_user, password, max: 5 });
  const identity = (await runtime.query('SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(identity, { current_user: roles.runtime_user, session_user: roles.runtime_user, rolsuper: false, rolbypassrls: false });
  const store = createAuthStore(runtime, { catalogUploadDir: uploadDir });
  auth = createAuthServer({ store, config, passwordService: createPasswordService(),
    rateLimiters: createApiRateLimiters({ store }), adminSecurity: security });
  await listen(auth, 3142);
  const current = await store.getCatalogCurrent();
  const fixture = { origin, seeds, runtimeRole: roles.runtime_user, migrationCount: migrations.length,
    course: { id: course.id, title: course.title, meetingId: meeting.id }, existingMaterialId: baselineMaterials.materials[0].id,
    baseline: current };
  gateway = createServer((request, response) => {
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) { response.writeHead(403).end(); return; }
    const pathname = new URL(request.url, origin).pathname;
    if (pathname === '/__catalog_fixture/shutdown' && request.method === 'POST' && request.headers['x-catalog-fixture'] === 'shutdown') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"stopping":true}');
      setImmediate(() => { void shutdown().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); }); });
      return;
    }
    if (pathname === '/__catalog_fixture') {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      if (!appReady) { response.writeHead(503, { 'Retry-After': '1' }).end('Built app is starting'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(fixture)); return;
    }
    const upload = pathname.startsWith('/resources/files/uploads/');
    const toAuth = upload || /^\/api\/(?:auth|admin|catalog|teachers|community|material-bookmarks|data-feedback|academic)(?:\/|$)/u.test(pathname);
    const upstream = proxyRequest({ hostname: '127.0.0.1', port: toAuth ? 3142 : 3139, method: request.method,
      path: upload ? request.url.replace('/resources/files/uploads/', '/api/catalog/files/') : request.url,
      headers: { ...request.headers, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'http' } }, reply => {
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Synthetic fixture upstream unavailable'); });
    request.pipe(upstream);
  });
  await listen(gateway, 3141);
  if (setupOnly) {
    console.log(`Catalog synthetic PostgreSQL and real auth API ready at ${origin}; built app not started.`);
    await new Promise(() => {});
  }
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, env: { ...process.env,
    NODE_ENV: 'production', PORT: '3139', HOSTNAME: '127.0.0.1', VINEXT_INTERNAL_PORT: '3140', CATALOG_API_ORIGIN: origin }, stdio: ['ignore','pipe','pipe'] });
  let appOutput = '';
  for (const stream of [app.stdout, app.stderr]) stream.on('data', bytes => { appOutput = (appOutput + bytes.toString()).slice(-6_000); });
  let ready = false;
  const startupDeadline = Date.now() + 60_000;
  while (Date.now() < startupDeadline) {
    if (app.exitCode !== null) throw new Error(`Synthetic app exited: ${appOutput}`);
    try { ready = (await fetch(`${origin}/admin`, { signal: AbortSignal.timeout(Math.min(1_000, startupDeadline - Date.now())) })).ok; } catch { /* bounded startup retry */ }
    if (ready) break;
    await new Promise(done => setTimeout(done, Math.min(250, Math.max(0, startupDeadline - Date.now()))));
  }
  assert.ok(ready, `Built app did not become ready: ${appOutput}`);
  appReady = true;
  console.log(`Catalog native fixture ready at ${origin}; PostgreSQL17+,32 migrations,actual runtime LOGIN; synthetic users only.`);
  await new Promise(() => {});
} catch (error) {
  console.error(error.message);
  await shutdown();
  process.exitCode = 1;
}
