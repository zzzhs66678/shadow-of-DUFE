import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("PostgreSQL is private, resource-limited, health-checked, and log-rotated", async () => {
  const compose = await read("docker-compose.yml");

  assert.match(compose, /postgres:/);
  assert.match(compose, /expose:\s*\n\s*- "5432"/);
  assert.doesNotMatch(compose, /ports:\s*\n\s*-\s*"5432:5432"/);
  assert.match(compose, /mem_limit: 384m/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /max-size: "10m"/);
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
  const guard = await read("ops/maintenance/disk-guard.sh");

  assert.match(backup, /LOCAL_KEEP="\$\{LOCAL_KEEP:-1\}"/);
  assert.match(backup, /MAX_DISK_PERCENT="\$\{MAX_DISK_PERCENT:-85\}"/);
  assert.match(backup, /COMPOSE_PROJECT_NAME="\$\{COMPOSE_PROJECT_NAME:-dufesh\}"/);
  assert.match(backup, /ossutil stat/);
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
});

test("auth traffic has bounded in-memory burst protection", async () => {
  const limiter = await read("services/auth-api/src/rate-limit.mjs");
  const server = await read("services/auth-api/src/server.mjs");

  assert.match(limiter, /capacity: 2_400/);
  assert.match(limiter, /capacity: 300/);
  assert.match(limiter, /communityWrite:[\s\S]*?capacity: 12/);
  assert.match(limiter, /communityReaction:[\s\S]*?capacity: 60/);
  assert.match(limiter, /communityReport:[\s\S]*?capacity: 5/);
  assert.match(limiter, /maxKeys = 10_000/);
  assert.match(limiter, /idleTtlMs/);
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

  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /Permissions-Policy/);
  assert.match(caddy, /Content-Security-Policy/);
  assert.match(caddy, /default-src 'self'/);
  assert.match(caddy, /object-src 'none'/);
  assert.match(caddy, /frame-ancestors 'none'/);
  assert.match(caddy, /connect-src 'self'/);
});

test("Xiaoying is isolated behind a private, resource-bounded service", async () => {
  const compose = await read("docker-compose.yml");
  const caddy = await read("deploy/Caddyfile");
  const server = await read("xiaoying-executor/bin/server.mjs");
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
  assert.match(server, /__Secure-dufesh_xiaoying_session/);
  assert.match(dockerfile, /USER node/);
});

test("static assets and route discovery have explicit cache and SEO policy", async () => {
  const caddy = await read("deploy/Caddyfile");
  const robots = await read("app/robots.ts");
  const sitemap = await read("app/sitemap.ts");
  const layout = await read("app/layout.tsx");

  assert.match(caddy, /max-age=31536000, immutable/);
  assert.match(caddy, /\.well-known\/security\.txt[\s\S]*text\/plain/);
  assert.match(caddy, /www\.dufesh\.cn[\s\S]*redir https:\/\/dufesh\.cn\{uri\} 308/);
  assert.match(robots, /\/campus-lab\//);
  assert.match(sitemap, /https:\/\/dufesh\.cn\/privacy/);
  assert.match(layout, /application\/ld\+json/);
  assert.match(layout, /dufesh-social\.png/);
});
