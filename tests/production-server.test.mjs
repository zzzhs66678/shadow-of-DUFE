import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import test from "node:test";

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForGateway(port, child, diagnostics) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`production gateway exited early\n${diagnostics.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response;
    } catch {
      // The vinext server and public gateway start in sequence.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`production gateway did not become ready\n${diagnostics.join("")}`);
}

test(
  "production gateway serves built public data without exposing source files",
  { timeout: 30_000 },
  async () => {
    const port = await freePort();
    let internalPort = await freePort();
    while (internalPort === port) internalPort = await freePort();
    const diagnostics = [];
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        VINEXT_INTERNAL_PORT: String(internalPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => diagnostics.push(String(chunk)));
    child.stderr.on("data", (chunk) => diagnostics.push(String(chunk)));

    try {
      const page = await waitForGateway(port, child, diagnostics);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<main|__next|东财之影/);

      const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1];
      assert.ok(assetPath, "rendered page should reference a built JS or CSS asset");
      const asset = await fetch(`http://127.0.0.1:${port}${assetPath}`);
      assert.equal(asset.status, 200);
      assert.match(
        asset.headers.get("cache-control") ?? "",
        /max-age=31536000, immutable/,
      );
      assert.equal((await asset.arrayBuffer()).byteLength > 0, true);

      const core = await fetch(
        `http://127.0.0.1:${port}/data/course-core.json`,
      );
      assert.equal(core.status, 200);
      assert.match(core.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(core.headers.get("x-content-type-options"), "nosniff");
      assert.match(
        core.headers.get("cache-control") ?? "",
        /stale-while-revalidate/,
      );
      assert.equal((await core.json()).version, 1);

      const fullHead = await fetch(
        `http://127.0.0.1:${port}/data/course-data.json`,
        { method: "HEAD" },
      );
      assert.equal(fullHead.status, 200);
      assert.equal(
        Number(fullHead.headers.get("content-length")) > 3_000_000,
        true,
      );

      const source = await fetch(`http://127.0.0.1:${port}/server.mjs`);
      assert.notEqual(source.status, 200);
      assert.equal((await source.text()).includes("resolvePublicAsset"), false);

      const missing = await fetch(
        `http://127.0.0.1:${port}/data/not-present.json`,
      );
      assert.equal(missing.status, 404);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 1_500);
      });
    }
  },
);
