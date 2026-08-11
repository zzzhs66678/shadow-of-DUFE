import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("vinext image probing is replaced by a fail-closed local package", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const packageLock = await read("package-lock.json");
  const replacement = JSON.parse(
    await read("vendor/image-size-disabled/package.json"),
  );
  const { imageSize } = await import("image-size");

  assert.equal(
    packageJson.dependencies["image-size"],
    "file:vendor/image-size-disabled",
  );
  assert.equal(packageJson.overrides["image-size"], "$image-size");
  assert.equal(replacement.name, "image-size");
  assert.equal(replacement.version, "2.0.3-dufesh.0");
  assert.match(
    packageLock,
    /"node_modules\/image-size": \{\s*"resolved": "vendor\/image-size-disabled",\s*"link": true/,
  );

  const malformedInputs = [
    Buffer.from("icns000000000000", "ascii"),
    Buffer.from("0000ftypavif0000", "ascii"),
    Buffer.from("0000JXL 00000000", "ascii"),
  ];
  for (const input of malformedInputs) {
    assert.throws(
      () => imageSize(input),
      /Build-time image probing is disabled/,
    );
  }

  const appFiles = await readdir(new URL("../app/", import.meta.url), {
    recursive: true,
  });
  const sourceFiles = appFiles.filter((file) => /\.(?:[cm]?[jt]sx?)$/i.test(file));
  const localImageImport = /(?:from\s*|import\s*\()\s*["'][^"']+\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)["']/i;
  for (const file of sourceFiles) {
    const source = await readFile(new URL(`../app/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, localImageImport, `${file} imports a local image`);
  }
  assert.equal(
    appFiles.some((file) =>
      /(?:^|[\\/])(?:favicon|icon|apple-icon|opengraph-image|twitter-image)\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?)$/i.test(
        file,
      ),
    ),
    false,
    "app metadata images must use audited public URLs with explicit dimensions",
  );
});

test("CI enforces the repository TypeScript boundary", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const workflow = await read(".github/workflows/quality.yml");
  const tsconfig = JSON.parse(await read("tsconfig.json"));
  const cloudflareEnv = await read("cloudflare-env.d.ts");

  assert.equal(packageJson.scripts.typecheck, "tsc --noEmit");
  assert.match(workflow, /npm run typecheck/);
  assert.equal(tsconfig.compilerOptions.allowImportingTsExtensions, true);
  assert.deepEqual(tsconfig.compilerOptions.types, ["@cloudflare/workers-types"]);
  assert.match(cloudflareEnv, /interface Env[\s\S]*DB\?: D1Database/);
});

test("CI blocks critical and serious accessibility regressions on desktop and mobile", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const workflow = await read(".github/workflows/quality.yml");
  const config = await read("playwright.config.ts");
  const suite = await read("tests/e2e/accessibility.spec.ts");

  assert.equal(
    packageJson.scripts["test:a11y"],
    "playwright test tests/e2e/accessibility.spec.ts",
  );
  assert.equal(packageJson.scripts["test:browser"], "playwright test");
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npm run test:browser/);
  assert.match(config, /npm run build && node server\.mjs/);
  assert.match(config, /\? "node server\.mjs"/);
  assert.match(config, /devices\["Desktop Chrome"\]/);
  assert.match(config, /devices\["Pixel 5"\]/);
  assert.match(config, /width: 768, height: 1024/);
  assert.match(config, /width: 667, height: 375/);
  assert.match(suite, /blockingImpacts = new Set\(\["critical", "serious"\]\)/);
  assert.match(suite, /new AxeBuilder\(\{ page \}\)/);
});

test("CI checks five main views across all target widths", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const workflow = await read(".github/workflows/quality.yml");
  const config = await read("playwright.config.ts");
  const suite = await read("tests/e2e/responsive.spec.ts");
  const performanceSuite = await read("tests/e2e/performance.spec.ts");

  assert.equal(
    packageJson.scripts["test:responsive"],
    "playwright test tests/e2e/responsive.spec.ts",
  );
  assert.match(workflow, /npm run test:browser/);
  assert.match(workflow, /tests\/course-core-data\.test\.mjs/);
  for (const width of [320, 360, 375, 390, 414, 667, 768, 844]) {
    assert.match(config, new RegExp(`width: ${width}`));
  }
  assert.match(config, /name: "performance"/);
  assert.match(suite, /\.today-page/);
  assert.match(suite, /\.catalog-page-v2/);
  assert.match(suite, /\.schedule-page/);
  assert.match(suite, /\.rooms-page/);
  assert.match(suite, /\.me-page/);
  assert.match(suite, /document\.documentElement\.scrollWidth/);
  assert.match(suite, /toBeLessThanOrEqual/);
  assert.match(performanceSuite, /not\.toContain\("\/data\/course-data\.json"\)/);
});

test("PostgreSQL is private, resource-limited, health-checked, and log-rotated", async () => {
  const compose = await read("docker-compose.yml");

  assert.match(compose, /postgres:/);
  assert.match(compose, /expose:\s*\n\s*- "5432"/);
  assert.doesNotMatch(compose, /ports:\s*\n\s*-\s*"5432:5432"/);
  assert.match(compose, /mem_limit: 384m/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /max-size: "10m"/);
});

test("CI runs migrations twice against native PostgreSQL 17 and checks runtime roles", async () => {
  const workflow = await read(".github/workflows/quality.yml");
  const integration = await read("tests/postgres-runtime-integration.test.mjs");
  const migrationRunner = await read("ops/postgres/run-migrations.sh");

  assert.match(workflow, /postgres-integration:/);
  assert.match(workflow, /image: postgres:17-alpine/);
  assert.match(workflow, /Apply migrations twice/);
  assert.match(workflow, /run-migrations\.sh[\s\S]*run-migrations\.sh/);
  assert.match(workflow, /POSTGRES_INTEGRATION: "true"/);
  assert.match(workflow, /Run isolated backup restore drill/);
  assert.match(workflow, /RESTORE_DRILL_MODE=native/);
  assert.match(integration, /server_version_num/);
  assert.match(integration, /Array\.from\(\{ length: 20 \}/);
  assert.match(integration, /api_rate_limit_buckets/);
  assert.match(integration, /admin_audit_events/);
  assert.match(integration, /teacher_review_candidate_decisions/);
  assert.match(integration, /ci-importer-denied/);
  assert.match(integration, /ci_reject_community_hide_audit/);
  assert.match(integration, /original_notification_count/);
  assert.match(integration, /sameNameTeacherId/);
  assert.match(integration, /isolatedSameNameReviews/);
  assert.match(integration, /academic import and review moderation serialize/);
  assert.match(integration, /moderationRollbackRace/);
  assert.match(migrationRunner, /MIGRATION_DB_ROLE/);
  assert.match(migrationRunner, /PGOPTIONS="-c role=\$MIGRATION_DB_ROLE"/);
  assert.match(migrationRunner, /--username "\$MIGRATION_DB_USER"/);
  assert.match(migrationRunner, /ALTER TABLE %I\.%I OWNER TO %I/);
  assert.match(migrationRunner, /ALTER FUNCTION %I\.%I\(%s\) OWNER TO %I/);
  assert.match(workflow, /BACKUP_DB_USER: dufesh_backup_ci/);
  assert.match(workflow, /MIGRATION_DB_ROLE: dufesh_schema_owner_ci/);
  assert.match(workflow, /MIGRATION_DB_USER: dufesh_migrator_ci/);
  assert.match(workflow, /PGPASSWORD="\$BACKUP_DB_PASSWORD" pg_dump/);
  assert.match(integration, /const backup = poolFor/);
  assert.match(integration, /ci_migrator_transaction_probe/);
});

test("CI builds and smoke-tests every production Linux image", async () => {
  const workflow = await read(".github/workflows/quality.yml");
  const appDockerfile = await read("Dockerfile");
  const authDockerfile = await read("services/auth-api/Dockerfile");
  const xiaoyingDockerfile = await read("xiaoying-executor/Dockerfile");

  assert.match(workflow, /container-builds:/);
  assert.match(workflow, /name: linux-production-images/);
  assert.match(workflow, /docker build[\s\S]*--tag dufesh-app:ci/);
  assert.match(workflow, /docker build[\s\S]*--tag dufesh-auth-api:ci/);
  assert.match(workflow, /docker build[\s\S]*--tag dufesh-xiaoying:ci/);
  assert.match(workflow, /import\('\@node-rs\/argon2'\)/);
  assert.match(workflow, /import\('sharp'\)/);
  assert.match(workflow, /ls image-size --all/);
  assert.match(workflow, /manifest\.version !== '2\.0\.3-dufesh\.0'/);
  assert.match(workflow, /http:\/\/127\.0\.0\.1:3000\//);
  assert.match(workflow, /docker image inspect --format '\{\{\.Config\.User\}\}'/);

  for (const dockerfile of [appDockerfile, authDockerfile, xiaoyingDockerfile]) {
    assert.match(
      dockerfile,
      /ARG NODE_IMAGE=docker\.m\.daocloud\.io\/library\/node:22-alpine/,
    );
    assert.match(dockerfile, /FROM \$\{NODE_IMAGE\}/);
    assert.match(dockerfile, /USER node/);
  }
});

test("identity foundation keeps OAuth identities, devices, and sessions separate", async () => {
  const migration = await read("ops/postgres/migrations/0001_identity_foundation.sql");

  for (const table of ["app_users", "oauth_identities", "user_devices", "user_sessions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /UNIQUE \(provider, provider_subject\)/);
  assert.match(migration, /UNIQUE \(token_hash\)/);
  assert.match(migration, /ON DELETE CASCADE/);
});

test("backup and disk protection have bounded local retention", async () => {
  const backup = await read("ops/postgres/backup.sh");
  const migrations = await read("ops/postgres/run-migrations.sh");
  const restoreDrill = await read("ops/postgres/restore-drill.sh");
  const restoreTimer = await read(
    "deploy/systemd/dufesh-db-restore-drill.timer",
  );
  const guard = await read("ops/maintenance/disk-guard.sh");

  assert.match(backup, /LOCAL_KEEP="\$\{LOCAL_KEEP:-1\}"/);
  assert.match(backup, /MAX_DISK_PERCENT="\$\{MAX_DISK_PERCENT:-85\}"/);
  assert.match(backup, /COMPOSE_PROJECT_NAME="\$\{COMPOSE_PROJECT_NAME:-dufesh\}"/);
  assert.match(backup, /ossutil stat/);
  assert.match(backup, /sha256sum "\$\(basename "\$backup_file"\)"/);
  assert.match(backup, /BACKUP_DB_USER/);
  assert.match(backup, /-e PGPASSWORD="\$BACKUP_DB_PASSWORD" postgres/);
  assert.match(backup, /--username "\$BACKUP_DB_USER"/);
  assert.doesNotMatch(backup, /--username "\$POSTGRES_USER"/);
  assert.match(migrations, /CREATE ROLE %I LOGIN', :'backup_user'/);
  assert.match(migrations, /GRANT SELECT ON ALL TABLES IN SCHEMA public/);
  assert.match(migrations, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
  assert.match(migrations, /WHERE member_role\.rolname = :'backup_user'/);
  assert.match(restoreDrill, /actual_checksum="\$\(sha256sum "\$backup_file"/);
  assert.match(restoreDrill, /actual_checksum" != "\$expected_checksum/);
  assert.match(restoreDrill, /dufesh_restore_drill_/);
  assert.match(restoreDrill, /--template template0/);
  assert.match(restoreDrill, /--maintenance-db "\$POSTGRES_DB"/);
  assert.match(restoreDrill, /pg_restore/);
  assert.match(restoreDrill, /--exit-on-error/);
  assert.match(restoreDrill, /migration_count < 16/);
  assert.match(restoreDrill, /NOT convalidated/);
  assert.match(restoreDrill, /api_rate_limit_buckets/);
  assert.match(restoreDrill, /dropdb[\s\S]*--if-exists "\$drill_database"/);
  assert.match(restoreDrill, /cleanup\ncreated=0\necho "Restore drill passed/);
  assert.match(restoreDrill, /RESTORE_DRILL_MAX_SECONDS/);
  assert.match(restoreDrill, /RESTORE_DRILL_MODE="\$\{RESTORE_DRILL_MODE:-docker\}"/);
  assert.match(restoreDrill, /run_postgres\(\)/);
  assert.match(restoreTimer, /OnCalendar=Sun/);
  assert.match(restoreTimer, /Persistent=true/);
  assert.match(guard, /docker builder prune/);
  assert.match(guard, /disk-critical/);
});

test("auth API is private, pooled, health-checked, and routed on the same origin", async () => {
  const compose = await read("docker-compose.yml");
  const caddy = await read("deploy/Caddyfile");
  const database = await read("services/auth-api/src/db.mjs");
  const dockerfile = await read("services/auth-api/Dockerfile");
  const vite = await read("vite.config.ts");

  assert.match(compose, /auth-api:/);
  assert.match(compose, /expose:\s*\n\s*- "3100"/);
  assert.doesNotMatch(compose, /ports:\s*\n\s*-\s*"3100:3100"/);
  assert.match(compose, /mem_limit: 128m/);
  assert.match(compose, /read_only: true/);
  assert.match(caddy, /handle \/api\/auth\/\*/);
  assert.match(caddy, /reverse_proxy auth-api:3100/);
  assert.match(caddy, /@teacher_api path \/api\/teachers \/api\/teachers\/\*/);
  assert.match(vite, /AUTH_API_DEV_TARGET/);
  assert.match(vite, /"\/api\/auth"/);
  assert.match(vite, /"\/api\/admin"/);
  assert.match(database, /max: config\.poolMax/);
  assert.match(database, /connectionTimeoutMillis: 3_000/);
  assert.match(dockerfile, /COPY --chown=node:node src \.\/src/);
});

test("OAuth transactions are one-time, browser-bound, and store only digests", async () => {
  const migration = await read(
    "ops/postgres/migrations/0003_oauth_transactions.sql",
  );
  const server = await read("services/auth-api/src/server.mjs");
  const provider = await read(
    "services/auth-api/src/providers/mock-wechat.mjs",
  );

  assert.match(migration, /state_hash text NOT NULL/);
  assert.match(migration, /browser_token_hash text NOT NULL/);
  assert.match(migration, /consumed_at timestamptz/);
  assert.doesNotMatch(migration, /\bstate_token\b|\bbrowser_token\b/);
  assert.match(server, /AUTH_OAUTH_TRANSACTION_INVALID/);
  assert.match(server, /x-dufesh-mock-secret/);
  assert.match(provider, /timingSafeEqual/);
  assert.match(provider, /createHmac\("sha256"/);
});

test("personal cloud data keeps stable client IDs, revisions, and tombstones", async () => {
  const migration = await read(
    "ops/postgres/migrations/0004_personal_cloud_data.sql",
  );
  const smoke = await read("ops/postgres/smoke-personal-data.sql");

  for (const table of [
    "user_sync_states",
    "user_profiles",
    "timetable_plans",
    "timetable_plan_schedules",
    "personal_activities",
    "user_assignments",
    "user_settings",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /CREATE OR REPLACE FUNCTION next_user_revision/);
  assert.match(migration, /UNIQUE \(user_id, client_id\)/);
  assert.match(migration, /UNIQUE \(plan_id, schedule_id\)/);
  assert.match(migration, /deleted_at timestamptz/);
  assert.match(migration, /source IN \('manual', 'class_import'\)/);
  assert.match(migration, /preferred_term IN \('fall', 'spring'\)/);
  assert.match(migration, /color IN \('red', 'blue', 'green', 'amber'\)/);
  assert.match(smoke, /distinct teaching meetings were collapsed/);
  assert.match(smoke, /cross-user plan relationship was accepted/);
  assert.match(smoke, /personal data did not cascade on account deletion/);
});

test("sync writes use bounded, payload-bound idempotency keys", async () => {
  const migration = await read(
    "ops/postgres/migrations/0005_sync_mutations.sql",
  );
  const server = await read("services/auth-api/src/server.mjs");
  const store = await read("services/auth-api/src/personal-store.mjs");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_sync_mutations/);
  assert.match(migration, /payload_hash text NOT NULL/);
  assert.match(migration, /PRIMARY KEY \(user_id, mutation_id\)/);
  assert.match(server, /REQUEST_BODY_TOO_LARGE/);
  assert.match(server, /trustedOrigin/);
  assert.match(store, /FOR UPDATE/);
  assert.match(store, /SYNC_MUTATION_REUSED/);
  assert.match(store, /payload\.baseRevision !== currentRevision/);
  assert.match(store, /interval '30 days'/);
});

test("account devices and self-service deletion remain session- and origin-bound", async () => {
  const server = await read("services/auth-api/src/server.mjs");
  const database = await read("services/auth-api/src/db.mjs");

  assert.match(server, /url\.pathname === "\/api\/auth\/devices"/);
  assert.match(server, /url\.pathname === "\/api\/auth\/account\/delete"/);
  assert.match(server, /confirmation !== "DELETE_MY_ACCOUNT"/);
  assert.match(server, /trustedOrigin/);
  assert.match(database, /async listUserDevices/);
  assert.match(database, /async revokeUserDevice/);
  assert.match(database, /async deleteAccount/);
  assert.match(database, /DELETE FROM app_users/);
});

test("account avatars are normalized, bounded, metadata-free, and account-scoped", async () => {
  const migration = await read("ops/postgres/migrations/0007_user_avatars.sql");
  const processor = await read("services/auth-api/src/avatars.mjs");
  const server = await read("services/auth-api/src/server.mjs");
  const database = await read("services/auth-api/src/db.mjs");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_avatars/);
  assert.match(migration, /image\/webp/);
  assert.match(migration, /byte_size BETWEEN 1 AND 524288/);
  assert.match(migration, /byte_size = octet_length\(image_bytes\)/);
  assert.match(migration, /ON DELETE CASCADE/);
  assert.match(processor, /limitInputPixels: MAX_PIXELS/);
  assert.match(processor, /resize\(OUTPUT_SIZE, OUTPUT_SIZE/);
  assert.match(processor, /\.webp\(/);
  assert.doesNotMatch(processor, /withMetadata/);
  assert.match(server, /url\.pathname === "\/api\/auth\/profile\/avatar"/);
  assert.match(server, /avatar_type_unsupported/);
  assert.match(server, /avatar_rate_limit_exceeded/);
  assert.match(server, /trustedOrigin/);
  assert.match(database, /JOIN app_users u ON u\.id = a\.user_id/);
  assert.match(database, /u\.status = 'active'/);
});

test("email verification tokens are hashed, email-bound, and single-use", async () => {
  const migration = await read("ops/postgres/migrations/0009_email_verification.sql");
  const server = await read("services/auth-api/src/server.mjs");
  const database = await read("services/auth-api/src/db.mjs");
  const config = await read("services/auth-api/src/config.mjs");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS email_verification_tokens/);
  assert.match(migration, /normalized_email text NOT NULL/);
  assert.match(migration, /token_hash text NOT NULL/);
  assert.doesNotMatch(migration, /\btoken\s+text\b/);
  assert.match(server, /\/api\/auth\/email\/verification\/request/);
  assert.match(server, /\/api\/auth\/email\/verification\/confirm/);
  assert.match(server, /trustedOrigin/);
  assert.match(server, /tokenDigest\(verificationToken, config\.tokenPepper\)/);
  assert.match(database, /async consumeEmailVerification/);
  assert.match(database, /users\.normalized_email = tokens\.normalized_email/);
  assert.match(database, /tokens\.consumed_at IS NULL/);
  assert.match(config, /AUTH_EMAIL_VERIFICATION_MODE=response is forbidden in production/);
});

test("admin security requires encrypted MFA, short elevation, and append-only audit", async () => {
  const migration = await read("ops/postgres/migrations/0008_admin_security.sql");
  const config = await read("services/auth-api/src/config.mjs");
  const security = await read("services/auth-api/src/admin-security.mjs");
  const routes = await read("services/auth-api/src/admin-routes.mjs");
  const caddy = await read("deploy/Caddyfile");
  const migrations = await read("ops/postgres/run-migrations.sh");

  assert.match(migration, /role IN \('user', 'moderator', 'admin'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_elevated_sessions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_mfa_credentials/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_recovery_codes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_audit_events/);
  assert.match(migration, /BEFORE UPDATE OR DELETE OR TRUNCATE ON admin_audit_events/);
  assert.match(config, /AUTH_ADMIN_MFA_KEYS/);
  assert.match(config, /AUTH_ADMIN_RECOVERY_PEPPER/);
  assert.match(config, /900/);
  assert.match(security, /aes-256-gcm/);
  assert.match(security, /timingSafeEqual/);
  assert.doesNotMatch(security, /console\.(?:log|error)/);
  assert.match(routes, /SameSite=Strict|sameSite: "Strict"/);
  assert.match(routes, /admin_forbidden/);
  assert.match(routes, /admin_mfa_required/);
  assert.match(caddy, /handle \/api\/admin\/\*/);
  assert.match(caddy, /X-Robots-Tag "noindex, nofollow, noarchive"/);
  assert.match(migrations, /AUTH_DB_USER/);
  assert.match(migrations, /NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  assert.match(
    migrations,
    /REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit_events/,
  );
  assert.match(migrations, /REVOKE ALL PRIVILEGES ON schema_migrations/);
});

test("administrator console is private, elevated, and auditable by design", async () => {
  const page = await read("app/admin/page.tsx");
  const console = await read("app/admin/AdminConsole.tsx");
  const styles = await read("app/admin/admin.module.css");
  const robots = await read("app/robots.ts");

  assert.match(page, /index: false/);
  assert.match(page, /noimageindex: true/);
  assert.match(robots, /\/admin\//);
  assert.match(console, /\/api\/admin\/session/);
  assert.match(console, /\/api\/admin\/elevation/);
  assert.match(console, /expectedStatus: target\.status/);
  assert.match(console, /reason\.trim\(\)\.length < 8/);
  assert.match(console, /验证码不会写入日志/);
  assert.match(console, /既有会话已撤销/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(console, /dangerouslySetInnerHTML/);
});

test("community foundation enforces two-level replies, idempotent reactions, and soft deletion", async () => {
  const migration = await read(
    "ops/postgres/migrations/0010_community_foundation.sql",
  );

  for (const table of [
    "community_topics",
    "community_comments",
    "community_topic_likes",
    "community_comment_likes",
    "community_topic_bookmarks",
    "community_user_blocks",
    "community_content_edits",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /validate_community_comment_depth/);
  assert.match(migration, /community replies are limited to two levels/);
  assert.match(migration, /community comment thread identity is immutable/);
  assert.match(migration, /PRIMARY KEY \(topic_id, user_id\)/);
  assert.match(migration, /PRIMARY KEY \(comment_id, user_id\)/);
  assert.match(migration, /status IN \('published', 'hidden', 'deleted'\)/);
  assert.match(migration, /community content must be soft-deleted/);
  assert.match(migration, /community_content_edits_append_only/);
  assert.match(migration, /ON DELETE SET NULL/);
});

test("community notifications and moderation preserve dedupe, fallback, and immutable audit", async () => {
  const migration = await read(
    "ops/postgres/migrations/0010_community_foundation.sql",
  );
  const migrations = await read("ops/postgres/run-migrations.sh");

  for (const table of [
    "community_notifications",
    "community_reports",
    "community_moderation_cases",
    "community_case_reports",
    "community_moderation_actions",
    "community_user_sanctions",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /UNIQUE \(recipient_user_id, dedupe_key\)/);
  assert.match(migration, /fallback_path text/);
  assert.match(migration, /community_reports_open_dedupe_uidx/);
  assert.match(migration, /community_moderation_cases_active_uidx/);
  assert.match(migration, /community_moderation_actions_append_only/);
  assert.match(migration, /community report evidence is immutable/);
  assert.match(migration, /community case-report links are append-only/);
  assert.match(
    migration,
    /community moderation action target must match its case/,
  );
  assert.match(
    migration,
    /community notification comment must belong to its topic/,
  );
  assert.match(migration, /left\(fallback_path, 2\) <> '\/\/'/);
  assert.doesNotMatch(
    migration,
    /reporter_user_id uuid NOT NULL REFERENCES app_users/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS community_content_edits \([\s\S]*?actor_user_id uuid,/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS community_moderation_actions \([\s\S]*?actor_user_id uuid,/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS community_notifications \([\s\S]*?actor_user_id uuid,/,
  );
  assert.doesNotMatch(
    migration,
    /community_user_sanctions[\s\S]*user_id uuid NOT NULL REFERENCES app_users/,
  );
  assert.match(
    migrations,
    /REVOKE UPDATE, DELETE, TRUNCATE ON community_moderation_actions/,
  );
  assert.match(
    migrations,
    /REVOKE UPDATE, DELETE, TRUNCATE ON community_content_edits/,
  );
  assert.match(
    migrations,
    /REVOKE DELETE, TRUNCATE ON community_topics, community_comments/,
  );
});

test("community read paths preserve deleted thread anchors and use the auth proxy", async () => {
  const migration = await read(
    "ops/postgres/migrations/0011_community_read_paths.sql",
  );
  const caddy = await read("deploy/Caddyfile");
  const vite = await read("vite.config.ts");

  assert.match(
    migration,
    /community_comments_public_roots_cursor_idx[\s\S]*?\(topic_id, created_at ASC, id ASC\)[\s\S]*?WHERE parent_comment_id IS NULL/,
  );
  assert.match(
    migration,
    /community_comments_public_replies_cursor_idx[\s\S]*?\(root_comment_id, created_at ASC, id ASC\)[\s\S]*?WHERE root_comment_id IS NOT NULL/,
  );
  assert.doesNotMatch(migration, /status <> 'deleted'/);
  assert.match(caddy, /handle \/api\/community\/\*/);
  assert.match(vite, /"\/api\/community": \{ target: authApiDevTarget \}/);
});

test("community reports preserve immutable evidence snapshots for moderation", async () => {
  const migration = await read(
    "ops/postgres/migrations/0012_community_report_evidence.sql",
  );
  assert.match(migration, /evidence_title/);
  assert.match(migration, /evidence_body/);
  assert.match(migration, /evidence_author_label/);
  assert.match(migration, /community report evidence snapshot is required/);
  assert.match(
    migration,
    /NEW\.evidence_body IS DISTINCT FROM OLD\.evidence_body/,
  );
});

test("teacher import foundation separates identities, section textbooks, and pending legacy reviews", async () => {
  const migration = await read(
    "ops/postgres/migrations/0013_teacher_catalog_imports.sql",
  );
  const migrations = await read("ops/postgres/run-migrations.sh");

  for (const table of [
    "data_import_batches",
    "data_import_rows",
    "data_import_mutations",
    "teachers",
    "teacher_source_identities",
    "teacher_aliases",
    "teacher_course_sections",
    "teaching_section_textbooks",
    "teacher_review_candidates",
    "teacher_reviews",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(
    migration,
    /UNIQUE \(source_system, external_teacher_key\)/,
  );
  assert.doesNotMatch(migration, /UNIQUE \(normalized_name\)/);
  assert.doesNotMatch(
    migration,
    /UNIQUE \(normalized_college, normalized_name\)/,
  );
  assert.match(migration, /teacher identity fields are immutable/);
  assert.match(migration, /data_import_batches_applied_fingerprint_uidx/);
  assert.match(migration, /data import row evidence is append-only/);
  assert.match(migration, /term_key, course_id, section_no/);
  assert.match(migration, /isbn_status IN \('valid', 'missing', 'placeholder', 'invalid'\)/);
  assert.match(migration, /source_type IN \('user', 'legacy_approved'\)/);
  assert.match(migration, /author_label = '历史整理内容'/);
  assert.match(migration, /legacy teacher review candidates must start pending/);
  assert.match(migration, /sanitized_body text/);
  assert.match(migration, /original_body_sha256 text/);
  assert.match(migration, /teacher_reviews_legacy_dedupe_uidx/);
  assert.match(migration, /teacher reviews must be soft-deleted/);
  assert.match(
    migrations,
    /REVOKE ALL PRIVILEGES ON data_import_batches, data_import_rows, data_import_mutations, teacher_review_candidates/,
  );
  assert.match(
    migrations,
    /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON teachers, teacher_source_identities, teacher_aliases, teacher_course_sections, teaching_section_textbooks/,
  );
  assert.match(migrations, /IMPORT_DB_USER/);
  assert.match(migrations, /IMPORT_DB_PASSWORD/);
  assert.match(migrations, /ALTER ROLE %I PASSWORD %L NOSUPERUSER[\s\S]*NOINHERIT/);
  assert.match(
    migrations,
    /GRANT SELECT, INSERT ON data_import_rows, data_import_mutations/,
  );
  assert.match(migrations, /GRANT SELECT ON teacher_reviews/);
  assert.doesNotMatch(
    migrations,
    /ALL TABLES IN SCHEMA public TO %I',\s*:'import_user'/,
  );
});

test("teacher review moderation requires elevation and immutable one-time decisions", async () => {
  const migration = await read(
    "ops/postgres/migrations/0014_teacher_review_moderation.sql",
  );
  const routes = await read("services/auth-api/src/admin-routes.mjs");
  const store = await read("services/auth-api/src/teacher-review-store.mjs");
  const grants = await read("ops/postgres/run-migrations.sh");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS teacher_review_candidate_decisions/);
  assert.match(migration, /candidate_id uuid NOT NULL UNIQUE/);
  assert.match(migration, /teacher_review_candidate_decisions_append_only/);
  assert.match(migration, /FOR UPDATE OF import_batch, candidate/);
  assert.match(migration, /administrator_elevation_required/);
  assert.match(migration, /admin\.teacher_review\.' \|\| p_decision/);
  assert.match(migration, /rollback_teacher_review_candidate_for_import/);
  assert.match(routes, /\/api\/admin\/teacher-reviews\/candidates/);
  assert.match(routes, /teacher_review_candidate_conflict/);
  assert.match(store, /list_teacher_review_candidates_for_admin/);
  assert.match(store, /moderate_teacher_review_candidate/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON teacher_review_candidate_decisions/);
  assert.match(
    grants,
    /REVOKE EXECUTE ON FUNCTION require_elevated_teacher_review_admin[\s\S]*rollback_teacher_review_candidate_for_import/,
  );
  assert.match(
    grants,
    /GRANT SELECT, INSERT ON teacher_review_candidates TO %I/,
  );
  assert.doesNotMatch(
    grants,
    /GRANT SELECT, INSERT, UPDATE ON[^\n]*teacher_review_candidates[^\n]*:'import_user'/,
  );
});

test("user teacher reviews are session-scoped, versioned, and soft-deleted", async () => {
  const migration = await read(
    "ops/postgres/migrations/0015_teacher_user_reviews.sql",
  );
  const routes = await read("services/auth-api/src/teacher-routes.mjs");
  const contract = await read("services/auth-api/src/teacher-review-contract.mjs");
  const store = await read("services/auth-api/src/teacher-store.mjs");

  assert.match(migration, /teacher_reviews_one_active_user_review_uidx/);
  assert.match(migration, /WHERE source_type = 'user' AND status <> 'deleted'/);
  assert.match(migration, /teacher review content digest mismatch/);
  assert.match(migration, /legacy teacher review evidence is immutable/);
  assert.match(routes, /my-review/);
  assert.match(routes, /trustedOrigin/);
  assert.match(routes, /teacherReviewWrite/);
  assert.match(contract, /hasOnlyKeys/);
  assert.match(contract, /normalized\.length < 20/);
  assert.match(store, /author_user_id = \$2/);
  assert.match(store, /status = 'deleted'/);
  assert.match(store, /version = \$10/);
});

test("auth traffic combines bounded burst protection with persistent high-risk quotas", async () => {
  const limiter = await read("services/auth-api/src/rate-limit.mjs");
  const server = await read("services/auth-api/src/server.mjs");
  const entrypoint = await read("services/auth-api/src/index.mjs");
  const grants = await read("ops/postgres/run-migrations.sh");
  const migration = await read(
    "ops/postgres/migrations/0016_shared_rate_limits.sql",
  );

  assert.match(limiter, /capacity: 2_400/);
  assert.match(limiter, /capacity: 300/);
  assert.match(limiter, /communityWrite:[\s\S]*?capacity: 12/);
  assert.match(limiter, /communityReaction:[\s\S]*?capacity: 60/);
  assert.match(limiter, /communityReport:[\s\S]*?capacity: 5/);
  assert.match(limiter, /teacherReviewModeration:[\s\S]*?capacity: 30/);
  assert.match(limiter, /teacherReviewWrite:[\s\S]*?capacity: 6/);
  assert.match(limiter, /maxKeys = 10_000/);
  assert.match(limiter, /idleTtlMs/);
  assert.match(limiter, /createSharedTokenBucket/);
  assert.match(limiter, /store\.consumeRateLimit/);
  assert.match(entrypoint, /createApiRateLimiters\(\{ store \}\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS api_rate_limit_buckets/);
  assert.match(migration, /octet_length\(key_digest\) = 32/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION consume_api_rate_limit/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /REVOKE ALL ON FUNCTION consume_api_rate_limit/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON api_rate_limit_buckets/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION consume_api_rate_limit/);
  assert.match(server, /rate_limit_exceeded/);
  assert.match(server, /Retry-After/);
  assert.match(server, /clientAddress/);
});

test("expired sessions and sync tombstones have bounded retention", async () => {
  const cleanup = await read("ops/postgres/cleanup.sh");
  const timer = await read("deploy/systemd/dufesh-db-cleanup.timer");

  assert.match(cleanup, /pg_advisory_xact_lock/);
  assert.match(cleanup, /user_sync_mutations/);
  assert.match(cleanup, /password_reset_tokens/);
  assert.match(cleanup, /email_verification_tokens/);
  assert.match(cleanup, /user_sessions/);
  assert.match(cleanup, /timetable_plan_schedules/);
  assert.match(cleanup, /personal_activities/);
  assert.match(cleanup, /user_assignments/);
  assert.match(cleanup, /interval '180 days'/);
  assert.match(cleanup, /claimed_device_id IS NULL/);
  assert.match(timer, /04:15:00 Asia\/Shanghai/);
  assert.match(timer, /Persistent=true/);
});

test("edge headers constrain embedding, browser capabilities, and active content", async () => {
  const caddy = await read("deploy/Caddyfile");
  const gateway = await read("server.mjs");
  const xiaoying = await read("xiaoying-executor/bin/server.mjs");
  const policies = `${gateway}\n${xiaoying}\n${caddy}`;

  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /Permissions-Policy/);
  assert.match(policies, /Content-Security-Policy|content-security-policy/);
  assert.match(policies, /default-src 'self'/);
  assert.match(policies, /object-src 'none'/);
  assert.match(policies, /frame-ancestors 'none'/);
  assert.match(policies, /connect-src 'self'/);
  assert.match(gateway, /'nonce-\$\{nonce\}'/);
  assert.match(xiaoying, /'sha256-/);
  assert.doesNotMatch(caddy, /unsafe-inline/);
  assert.doesNotMatch(xiaoying, /unsafe-inline/);
});

test("Xiaoying is isolated behind a private, resource-bounded service", async () => {
  const compose = await read("docker-compose.yml");
  const caddy = await read("deploy/Caddyfile");
  const server = await read("xiaoying-executor/bin/server.mjs");
  const store = await read("xiaoying-executor/src/local-store.mjs");
  const traceProtocol = await read("xiaoying-executor/src/traceint-protocol.mjs");
  const traceProtocolConfig = await read(
    "xiaoying-executor/src/traceint-protocol-config.mjs",
  );
  const traceClient = await read("xiaoying-executor/src/traceint-client.mjs");
  const dockerfile = await read("xiaoying-executor/Dockerfile");

  assert.match(compose, /xiaoying:/);
  assert.match(compose, /expose:\s*\n\s*- "43120"/);
  assert.doesNotMatch(compose, /ports:\s*\n\s*-\s*"43120:43120"/);
  assert.match(compose, /xiaoying_data:\/data/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /mem_limit: 192m/);
  assert.match(caddy, /handle_path \/campus-lab\/\*/);
  assert.match(caddy, /X-Robots-Tag "noindex, nofollow, noarchive"/);
  assert.match(server, /XIAOYING_MASTER_KEY/);
  assert.match(server, /sameOriginRequest/);
  assert.match(server, /withinRateLimit/);
  assert.doesNotMatch(server, /const rateLimits = new Map/);
  assert.match(server, /forwarded\.at\(-1\)/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS public_rate_limits/);
  assert.match(store, /createHmac\("sha256", this\.masterKey\)/);
  assert.match(store, /BEGIN IMMEDIATE/);
  assert.match(
    traceProtocol,
    /cookieEndpoint: "https:\/\/wechat\.v2\.traceint\.com/,
  );
  assert.doesNotMatch(traceProtocol, /cookieEndpoint: "http:\/\//);
  assert.match(traceProtocolConfig, /protocols: \["https:"\]/);
  assert.match(traceClient, /url\.protocol !== "https:"/);
  assert.match(server, /__Secure-dufesh_xiaoying_session/);
  assert.match(dockerfile, /USER node/);
});

test("static assets and route discovery have explicit cache and SEO policy", async () => {
  const caddy = await read("deploy/Caddyfile");
  const packageJson = JSON.parse(await read("package.json"));
  const server = await read("server.mjs");
  const robots = await read("app/robots.ts");
  const sitemap = await read("app/sitemap.ts");
  const layout = await read("app/layout.tsx");

  assert.match(caddy, /max-age=31536000, immutable/);
  assert.equal(packageJson.scripts.start, "node server.mjs");
  for (const prefix of ["/assets/", "/data/", "/images/", "/.well-known/"]) {
    assert.match(server, new RegExp(`"${prefix.replaceAll("/", "\\/")}"`));
  }
  assert.match(server, /max-age=31536000, immutable/);
  assert.match(server, /candidate\.startsWith\(`\$\{clientDir\}\$\{sep\}`\)/);
  assert.match(server, /host: "127\.0\.0\.1"/);
  assert.match(server, /"X-Content-Type-Options": "nosniff"/);
  assert.match(caddy, /\.well-known\/security\.txt[\s\S]*text\/plain/);
  assert.match(caddy, /www\.dufesh\.cn[\s\S]*redir https:\/\/dufesh\.cn\{uri\} 308/);
  assert.match(
    caddy,
    /http:\/\/112\.126\.75\.74 \{\r?\n\tredir https:\/\/dufesh\.cn\{uri\} 308\r?\n\}/,
  );
  assert.match(robots, /\/campus-lab\//);
  assert.match(sitemap, /https:\/\/dufesh\.cn\/privacy/);
  assert.match(layout, /application\/ld\+json/);
  assert.match(layout, /dufesh-social\.png/);
});
