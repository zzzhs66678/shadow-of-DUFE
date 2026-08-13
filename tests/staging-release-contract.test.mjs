import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("staging topology is isolated and immutable by default", async () => {
  const compose = await read("docker-compose.staging.yml");

  assert.match(compose, /DUFESH_IMAGE_TAG:\?set a full 40-character Git SHA/);
  assert.match(compose, /DUFESH_STAGING_POSTGRES_ENV_FILE:\?set an absolute staging-only path/);
  assert.match(compose, /DUFESH_STAGING_AUTH_ENV_FILE:\?set an absolute staging-only path/);
  assert.match(compose, /DUFESH_STAGING_RESOURCES_DIR:\?set an absolute staging-only path/);
  assert.match(compose, /127\.0\.0\.1\}:\$\{DUFESH_STAGING_HTTPS_PORT:-8443\}:443/);
  assert.doesNotMatch(compose, /DUFESH_STAGING_HTTP_PORT/);
  assert.match(compose, /postgres_staging_data:/);
  assert.match(compose, /xiaoying_staging_data:/);
  assert.doesNotMatch(compose, /\/srv\/apps\/dufesh\/shared/);
  assert.doesNotMatch(compose, /image: dufesh-(?:app|auth-api|xiaoying):latest/);
});

test("core gateway does not wait for the optional xiaoying service", async () => {
  const production = await read("docker-compose.yml");
  const staging = await read("docker-compose.staging.yml");

  for (const compose of [production, staging]) {
    const web = compose.slice(compose.indexOf("  web:"));
    assert.match(web, /depends_on:\s+app:\s+condition: service_healthy/);
    assert.doesNotMatch(web, /depends_on:[\s\S]*?xiaoying:/);
  }
  assert.match(staging, /xiaoying:\s+profiles: \["xiaoying"\]/);
});

test("application containers use a constrained runtime filesystem", async () => {
  for (const path of ["docker-compose.yml", "docker-compose.staging.yml"]) {
    const compose = await read(path);
    const app = compose.slice(compose.indexOf("  app:"), compose.indexOf("\n  xiaoying:") > 0
      ? compose.indexOf("\n  xiaoying:")
      : compose.indexOf("\n  postgres:"));
    assert.match(app, /read_only: true/);
    assert.match(app, /\/tmp:size=64m,mode=1777/);
    assert.match(app, /no-new-privileges:true/);
    assert.match(app, /cpus: 1\.00/);
    assert.match(app, /pids_limit: 256/);
  }

  const production = await read("docker-compose.yml");
  const gateway = production.slice(production.indexOf("  web:"), production.indexOf("\nvolumes:"));
  assert.match(gateway, /read_only: true/);
  assert.match(gateway, /\/tmp:size=16m,mode=1777/);
  assert.match(gateway, /no-new-privileges:true/);
  assert.match(gateway, /cpus: 0\.50/);
});

test("staging preflight refuses production targets and unapproved public binds", async () => {
  const preflight = await read("ops/staging/preflight.sh");
  const smoke = await read("ops/staging/smoke.sh");
  const caddy = await read("deploy/staging/Caddyfile");

  assert.match(preflight, /production hosts are forbidden in staging/);
  assert.match(preflight, /public bind requires explicit approval/);
  assert.match(preflight, /public Caddy site address must match the staging origin/);
  assert.match(preflight, /staging origin must use HTTPS/);
  assert.match(preflight, /POSTGRES_DB must end in _staging/);
  assert.match(preflight, /must have mode 600/);
  assert.match(smoke, /refusing a production target/);
  assert.match(smoke, /homepage does not reference any JS\/CSS assets/);
  assert.match(smoke, /compiled asset cache policy is missing/);
  assert.match(caddy, /X-Robots-Tag "noindex, nofollow, noarchive"/);
});
