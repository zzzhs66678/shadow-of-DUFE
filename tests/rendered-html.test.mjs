import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("material search and detail routes stay independent from course selection", async () => {
  const searchResponse = await render(
    "/api/materials?q=%E9%AB%98%E6%95%B0&limit=10",
  );
  assert.equal(searchResponse.status, 200);
  const search = await searchResponse.json();
  assert.equal(search.total, 1);
  assert.equal(search.items[0].name, "高数下.pdf");
  assert.ok(search.items.every((item) => item.id && item.downloadUrl));
  assert.ok(search.items.every((item) => !("sectionId" in item)));

  const materialId = search.items[0].id;
  const detailApi = await render(`/api/materials/${materialId}`);
  assert.equal(detailApi.status, 200);
  assert.equal((await detailApi.json()).material.id, materialId);

  const detailPage = await render(`/materials/${materialId}`);
  assert.equal(detailPage.status, 200);
  const detailHtml = await detailPage.text();
  assert.match(detailHtml, /高数下\.pdf/);
  assert.match(detailHtml, /下载原件/);
  assert.doesNotMatch(detailHtml, /选择教学班/);

  const missing = await render("/api/materials/missing-material");
  assert.equal(missing.status, 404);
});

test("server-renders the branded data-loading shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>东财之影｜课表、空教室与学习资料<\/title>/i);
  assert.match(html, /DUFE · STUDENT DESK/);
  assert.match(html, /东财之影是面向东北财经大学学生的非官方校园学习工具/);
  assert.match(html, /href="\/\?view=schedule"/);
  assert.match(html, /正在加载课程数据/);
  assert.match(html, /稍等一下，马上就好/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("SEO output exposes canonical, readable branding and WebSite without JavaScript", async () => {
  for (const path of ["/", "/?view=rooms", "/?utm_source=seo-check"]) {
    const response = await render(path);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.headers.get("x-robots-tag") ?? "", /noindex/i);
    assert.match(html, /<link rel="canonical" href="https:\/\/dufesh.cn\/"/);
    assert.match(html, /<h1[^>]*>东财之影<\/h1>/);
    assert.doesNotMatch(html, /<meta name="robots" content="[^"]*noindex/i);
    const schemas = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
      .map((match) => JSON.parse(match[1]));
    const website = schemas.filter((schema) => schema["@type"] === "WebSite");
    assert.equal(website.length, 1);
    assert.equal(website[0].name, "东财之影");
    assert.equal(website[0].url, "https://dufesh.cn/");
  }
});

test("sitemap URLs match public pages and the real material catalog, all returning canonical 200 HTML", async () => {
  const robots = await render("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type"), /text\/plain/);
  const rules = await robots.text();
  assert.match(rules, /Sitemap: https:\/\/dufesh.cn\/sitemap.xml/);
  assert.match(rules, /Disallow: \/admin\$/);
  assert.doesNotMatch(rules, /^Disallow: \/$/m);

  const response = await render("/sitemap.xml");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /xml/);
  const xml = await response.text();
  assert.doesNotMatch(xml, /<lastmod>/);
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  const catalog = JSON.parse(await readFile(new URL("../public/data/resource-manifest.json", import.meta.url), "utf8"));
  const expected = ["/", "/teachers", "/materials", "/community", "/privacy", "/terms", "/account/delete",
    ...catalog.materials.map((item) => `/materials/${encodeURIComponent(item.id)}`)];
  assert.deepEqual(urls.map((url) => new URL(url).pathname).sort(), [...new Set(expected)].sort());
  assert.equal(new Set(urls).size, urls.length);

  // One worker instance exercises every emitted URL, without a JS-capable browser.
  const { default: worker } = await import("../dist/server/index.js");
  for (const url of urls) {
    assert.equal(new URL(url).origin, "https://dufesh.cn");
    const page = await worker.fetch(new Request(url), {}, { waitUntil() {} });
    assert.equal(page.status, 200, url);
    const html = await page.text();
    assert.ok(html.includes(`<link rel="canonical" href="${url}"`), url);
    assert.doesNotMatch(html, /<meta name="robots" content="[^"]*noindex/i, url);
  }
  assert.equal((await render("/seo-missing-page")).status, 404);
  assert.equal((await render("/materials/seo-missing-material")).status, 404);
});

test("community list and topic routes render independent readable shells", async () => {
  const list = await render("/community");
  assert.equal(list.status, 200);
  const listHtml = await list.text();
  assert.match(listHtml, /<title>校园回廊｜东财之影<\/title>/i);
  assert.match(listHtml, /让有用的话/);
  assert.match(listHtml, /按时间追新/);
  assert.match(listHtml, /主题排序方式/);
  assert.match(listHtml, />最新<\/button>/);
  assert.match(listHtml, />热议<\/button>/);
  assert.match(listHtml, /href="\/materials"/);
  assert.doesNotMatch(listHtml, /积分榜|用户等级/);

  const detail = await render(
    "/community/topics/00000000-0000-4000-8000-000000000001",
  );
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /正在展开这段讨论/);
  assert.match(detailHtml, /href="\/community"/);

  const profile = await render(
    "/community/users/00000000-0000-4000-8000-000000000002",
  );
  assert.equal(profile.status, 200);
  const profileHtml = await profile.text();
  assert.match(profileHtml, /<title>社区公开档案｜东财之影<\/title>/i);
  assert.match(profileHtml, /正在打开公开档案/);
  assert.match(profileHtml, /href="\/community"/);
});

test("course index preserves the expected source relationships", async () => {
  const raw = await readFile(
    new URL("../public/data/course-data.json", import.meta.url),
    "utf8",
  );
  const data = JSON.parse(raw);

  assert.equal(data.colleges.length, 19);
  assert.equal(data.majors.length, 72);
  assert.equal(data.courses.length, 1759);
  assert.equal(data.buildings.length, 5);
  assert.deepEqual(data.buildings, [
    "之远楼",
    "笃行楼",
    "书音楼",
    "播慧楼",
    "砺金楼",
  ]);
  assert.ok(data.majorCourses.length > 4000);
  assert.ok(data.schedules.length > 5800);
  const roomSchedules = data.schedules.filter((item) =>
    data.buildings.includes(item.building),
  );
  assert.equal(roomSchedules.length, data.quality.roomScheduleRows);
  assert.ok(
    data.schedules.some((item) => !data.buildings.includes(item.building)),
  );
  assert.ok(data.courses.every((course) => course.id && course.title));
});
