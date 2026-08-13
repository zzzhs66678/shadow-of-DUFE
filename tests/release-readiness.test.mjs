import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("production images can be bound to one immutable release tag", async () => {
  const compose = await read("docker-compose.yml");
  const runbook = await read("docs/OPERATIONS_RUNBOOK.md");
  const workflow = await read(".github/workflows/quality.yml");

  for (const image of ["dufesh-app", "dufesh-auth-api", "dufesh-xiaoying"]) {
    assert.match(
      compose,
      new RegExp(`image: ${image}:\\$\\{DUFESH_IMAGE_TAG:-latest\\}`),
    );
    assert.doesNotMatch(compose, new RegExp(`image: ${image}:latest`));
  }
  assert.match(runbook, /DUFESH_RELEASE_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(runbook, /docker compose up -d --no-build/);
  assert.match(runbook, /不运行旧迁移器/u);
  assert.match(workflow, /node --test tests\/release-readiness\.test\.mjs/);
});

test("administrator bootstrap remains explicit, one-time, and session-revoking", async () => {
  const bootstrap = await read("services/auth-api/bin/bootstrap-admin.mjs");
  const packageJson = JSON.parse(
    await read("services/auth-api/package.json"),
  );
  const runbook = await read("docs/OPERATIONS_RUNBOOK.md");

  assert.equal(packageJson.scripts["admin:bootstrap"], "node bin/bootstrap-admin.mjs");
  assert.match(bootstrap, /AUTH_ADMIN_ENABLED must be true/);
  assert.match(bootstrap, /mfaConfigured && !rotate/);
  assert.match(bootstrap, /Existing sessions were revoked/);
  assert.match(bootstrap, /Recovery codes \(shown once\)/);
  assert.match(runbook, /不得重定向、录屏、复制到工单或进入集中日志/u);
  assert.match(runbook, /--rotate/);
});

test("every tracked public image has a source or ownership credit", async () => {
  const credits = await read("public/images/CREDITS.md");
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "public/images"],
    { cwd: new URL(".", root) },
  );
  const images = stdout
    .split(/\r?\n/u)
    .filter((path) => /\.(?:jpe?g|png|webp|gif|svg)$/iu.test(path));

  assert.ok(images.length > 0);
  for (const path of images) {
    const filename = path.split("/").at(-1);
    assert.ok(
      credits.includes(`\`${filename}\``),
      `missing image credit: ${filename}`,
    );
  }
  assert.match(credits, /CC BY 2\.0/);
  assert.match(credits, /CC BY-SA 3\.0/);
  assert.match(credits, /supplied by the site creator/);
  assert.match(credits, /original social-preview artwork/);
});

test("delivery report preserves all fourteen required status sections", async () => {
  const report = await read("docs/FINAL_DELIVERY_REPORT.md");
  const readme = await read("README.md");

  for (let section = 1; section <= 14; section += 1) {
    assert.match(report, new RegExp(`^## ${section}\\. `, "mu"));
  }
  for (const state of [
    "已完成并验证",
    "已实现待 staging",
    "外部阻塞",
    "尚未完成",
  ]) {
    assert.match(report, new RegExp(state, "u"));
  }
  assert.match(report, /本发布分支未部署/u);
  assert.match(report, /已推送并创建 Draft PR #10/u);
  assert.match(readme, /docs\/FINAL_DELIVERY_REPORT\.md/);
});
