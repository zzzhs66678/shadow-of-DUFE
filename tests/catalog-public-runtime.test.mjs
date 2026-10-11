import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

test("one manifest pins lazy full course data to the same version as its core", async (t) => {
  const version = "a".repeat(64), materialVersion = "b".repeat(64);
  const prefix = `/api/catalog/releases/${version}`;
  const paths = [];
  t.mock.method(globalThis, "fetch", async path => {
    paths.push(path);
    if (path === "/api/catalog/current") return Response.json({
      courses: { version, revision: 2, coreUrl: `${prefix}/core`, fullUrl: `${prefix}/full` },
      materials: { version: materialVersion, revision: 1, url: `/api/catalog/releases/${materialVersion}/materials` },
    });
    if (path === `${prefix}/core`) return Response.json({ catalogId: `course-v1:${version}` });
    if (path === `${prefix}/full`) return Response.json({ schedules: [{ id: "stable-meeting" }] });
    return Response.json({ materials: [{ id: "stable-material" }] });
  });
  const loader = await import(`../app/published-catalog.ts?pin=${Date.now()}`);
  const core = await loader.loadPublishedCourseCore();
  assert.deepEqual(paths, ["/api/catalog/current", `${prefix}/core`]);
  const full = await loader.loadPublishedCourseFull(core.catalogId);
  const materials = await loader.loadPublishedMaterials();
  assert.equal(full.schedules[0].id, "stable-meeting");
  assert.equal(materials.materials[0].id, "stable-material");
  assert.equal(paths.filter(path => path === "/api/catalog/current").length, 1);
  assert.equal(paths[2], `${prefix}/full`);
});

test("an older installation without the catalog API keeps its static lazy data path", async (t) => {
  const paths = [];
  t.mock.method(globalThis, "fetch", async path => {
    paths.push(path);
    return path === "/api/catalog/current" ? new Response("missing", { status: 404 }) : Response.json({ catalogId: "old" });
  });
  const loader = await import(`../app/published-catalog.ts?old=${Date.now()}`);
  await loader.loadPublishedCourseCore();
  await loader.loadPublishedCourseFull("old");
  assert.deepEqual(paths, ["/api/catalog/current", "/data/course-core.json", "/data/course-data.json"]);
});

test("publication failure and mixed-version manifests never silently become the bundled catalog", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const failed = await import(`../app/published-catalog.ts?failed=${Date.now()}`);
  await assert.rejects(failed.loadPublishedCourseCore(), /manifest unavailable/);
  const a = "a".repeat(64), b = "b".repeat(64);
  globalThis.fetch = async () => Response.json({
    courses: { coreUrl: `/api/catalog/releases/${a}/core`, fullUrl: `/api/catalog/releases/${b}/full` },
    materials: { url: `/api/catalog/releases/${b}/materials` },
  });
  const mixed = await import(`../app/published-catalog.ts?mixed=${Date.now()}`);
  await assert.rejects(mixed.loadPublishedCourseCore(), /manifest invalid/);
});

test("standalone material lookup follows the published version with bounded refresh and no private headers", async (t) => {
  const originalOrigin = process.env.CATALOG_API_ORIGIN;
  let version = "a".repeat(64), clock = Date.now(), requests = 0, failing = false;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    response.setHeader("Content-Type", "application/json");
    if (failing) { response.statusCode = 503; response.end("{}"); return; }
    response.end(JSON.stringify(request.url === "/api/catalog/current"
      ? { materials: { version, url: `/api/catalog/releases/${version}/materials` } }
      : { schemaVersion: 2, generatedAt: "2026-10-12T00:00:00Z", materials: [{ id: version.slice(0, 20), name: version[0], courseTitle: "课程", teachers: [], colleges: [], terms: [], years: [], tags: [], downloadUrl: "https://example.test/file.pdf" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.CATALOG_API_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (originalOrigin === undefined) delete process.env.CATALOG_API_ORIGIN;
    else process.env.CATALOG_API_ORIGIN = originalOrigin;
    await new Promise(resolve => server.close(resolve));
  });
  t.mock.method(Date, "now", () => clock);
  const { publishedMaterialCatalog } = await import(`../app/materials/published-materials-server.mjs?live=${clock}`);
  const first = await publishedMaterialCatalog();
  assert.equal(first.getMaterialById(version.slice(0, 20)).name, "a");
  assert.equal((await publishedMaterialCatalog()), first);
  assert.equal(requests, 2);
  version = "b".repeat(64); clock += 10_001;
  const next = await publishedMaterialCatalog();
  assert.equal(next.getMaterialById("a".repeat(20)), null);
  assert.equal(next.getMaterialById("b".repeat(20)).name, "b");
  failing = true; clock += 10_001;
  await assert.rejects(publishedMaterialCatalog(), /unavailable/);
});

test("bookmark resolution distinguishes catalog outages from invalid IDs and recovers current records", async t => {
  const previous = process.env.CATALOG_API_ORIGIN;
  const version = "c".repeat(64), materialId = "d".repeat(20);
  let failing = true, requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (failing) { response.writeHead(503).end("{}"); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/api/catalog/current"
      ? { materials: { version, url: `/api/catalog/releases/${version}/materials` } }
      : { schemaVersion: 2, generatedAt: "2026-10-12T00:00:00Z", materials: [{ id: materialId, name: "更新后的收藏资料", courseTitle: "课程", courseIds: [], teachers: [], colleges: [], terms: [], years: [], tags: [], downloadUrl: "https://example.test/current.pdf" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.CATALOG_API_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previous === undefined) delete process.env.CATALOG_API_ORIGIN;
    else process.env.CATALOG_API_ORIGIN = previous;
    await new Promise(resolve => server.close(resolve));
  });
  const { POST } = await import("../app/api/materials/resolve/route.ts");
  const request = ids => new Request("https://example.test/api/materials/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
  });
  assert.equal((await POST(request(["invalid"]))).status, 400);
  assert.equal(requests, 0, "invalid input never queries the catalog");
  const outage = await POST(request([materialId]));
  assert.equal(outage.status, 503);
  assert.deepEqual(await outage.json(), { error: "materials_unavailable" });
  assert.equal(outage.headers.get("cache-control"), "no-store, private");
  failing = false;
  const recovered = await POST(request([materialId, materialId]));
  assert.equal(recovered.status, 200);
  const { items } = await recovered.json();
  assert.equal(items.length, 1);
  assert.equal(items[0].material.name, "更新后的收藏资料");
  assert.equal(items[0].material.downloadUrl, "https://example.test/current.pdf");
});
