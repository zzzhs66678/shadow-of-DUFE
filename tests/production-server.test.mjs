import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHTTPServer } from "node:http";
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

test("Baiguo handoff verifies administrator MFA twice and keeps the management key on the server", { timeout: 30_000 }, async () => {
  let calls = 0, revoke = false;
  const auth = createHTTPServer((req, res) => {
    const elevated = req.headers.cookie === "fixture=admin" && !revoke;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ role: elevated ? "admin" : "user", elevated, elevatedUntil: "2099-01-01T00:00:00Z" }));
  });
  const baiguo = createHTTPServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    assert.equal(value.password, "synthetic-server-management-key");
    assert.ok(value.expires_at > Date.now() / 1000 && value.expires_at <= Date.now() / 1000 + 30);
    assert.equal(req.headers.cookie, undefined);
    if (calls === 2) revoke = true;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ticket: "A".repeat(43) }));
  });
  await new Promise(resolve => auth.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => baiguo.listen(0, "127.0.0.1", resolve));
  const port = await freePort();
  let internalPort = await freePort();
  while (internalPort === port) internalPort = await freePort();
  const diagnostics = [];
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port), VINEXT_INTERNAL_PORT: String(internalPort),
      BAIGUO_MANAGEMENT_KEY: "synthetic-server-management-key", DUFESH_ADMIN_SESSION_ORIGIN: `http://127.0.0.1:${auth.address().port}`, BAIGUO_DASHBOARD_ORIGIN: `http://127.0.0.1:${baiguo.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => diagnostics.push(String(chunk)));
  child.stderr.on("data", chunk => diagnostics.push(String(chunk)));
  try {
    await waitForGateway(port, child, diagnostics);
    const send = (headers = {}, method = "POST") => fetch(`http://127.0.0.1:${port}/admin/baiguo-session`, { method, headers: { Origin: "https://dufesh.cn", "Content-Type": "application/json", ...headers }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal((await send()).status, 401);
    assert.equal((await send({ Cookie: "fixture=ordinary" })).status, 403);
    assert.equal((await send({ Cookie: "fixture=admin", Origin: "https://outside.example" })).status, 403);
    assert.equal((await send({}, "GET")).status, 405);
    assert.equal(calls, 0);
    const result = await send({ Cookie: "fixture=admin" });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(await result.json(), { ticket: "A".repeat(43) });
    assert.equal((await send({ Cookie: "fixture=admin" })).status, 403, "revocation during issuance must discard the ticket");
    assert.equal(calls, 2);
    assert.doesNotMatch(diagnostics.join(""), /synthetic-server-management-key/);
  } finally {
    child.kill();
    await Promise.all([new Promise(resolve => auth.close(resolve)), new Promise(resolve => baiguo.close(resolve))]);
  }
});

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
      for (const [path, type] of [["/robots.txt", /text\/plain/], ["/sitemap.xml", /xml/]]) {
        const seo = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.equal(seo.status, 200, path);
        assert.match(seo.headers.get("content-type") ?? "", type);
        assert.doesNotMatch(seo.headers.get("x-robots-tag") ?? "", /noindex/i);
      }
      const contentSecurityPolicy = page.headers.get("content-security-policy") ?? "";
      const nonce = contentSecurityPolicy.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
      assert.ok(nonce, "document CSP should provide a per-request script nonce");
      assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/);
      const executableScripts = [...html.matchAll(/<script([^>]*)>/g)].filter(
        (match) => !/type="application\/ld\+json"/.test(match[1]),
      );
      assert.equal(executableScripts.length > 0, true);
      for (const script of executableScripts) {
        assert.match(script[1], new RegExp(`nonce="${nonce}"`));
      }
      const secondPage = await fetch(`http://127.0.0.1:${port}/`);
      assert.match(contentSecurityPolicy, /frame-src 'self';/);
      assert.doesNotMatch(contentSecurityPolicy, /baiguo\.dufesh\.cn/);
      for (const path of ["/admin", "/admin/"]) {
        const admin = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.match(admin.headers.get("content-security-policy"), /frame-src 'self' https:\/\/baiguo\.dufesh\.cn;/);
      }
      const secondNonce = (secondPage.headers.get("content-security-policy") ?? "").match(
        /script-src[^;]*'nonce-([^']+)'/,
      )?.[1];
      assert.notEqual(secondNonce, nonce);

      const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1];
      assert.ok(assetPath, "rendered page should reference a built JS or CSS asset");
      const asset = await fetch(`http://127.0.0.1:${port}${assetPath}`);
      assert.equal(asset.status, 200);
      assert.match(
        asset.headers.get("cache-control") ?? "",
        /max-age=31536000, immutable/,
      );
      assert.equal(
        asset.headers.get("content-security-policy"),
        "default-src 'none'; sandbox",
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
