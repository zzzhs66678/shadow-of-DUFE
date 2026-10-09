import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = await readFile(new URL("../app/materials/MaterialsExplorer.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/materials/materials.module.css", import.meta.url), "utf8");

test("materials expose an initial-search-compatible, history-free embedded boundary", () => {
  assert.match(source, /export type MaterialSearchState/);
  assert.match(source, /embedded = false/);
  assert.match(source, /onSearchChange\?: \(search: MaterialSearchState\) => void/);
  assert.match(source, /const Root = embedded \? "section" : "main"/);
  assert.match(source, /id=\{embedded \? undefined : "main-content"\}/);
  assert.match(source, /!embedded && <PublicMasthead/);
  assert.match(source, /embedded \? <h2/);
  assert.match(source, /onSearchChangeRef\.current = onSearchChange/);
  assert.match(source, /onSearchChangeRef\.current\?\.\(Object\.fromEntries\(visibleParams\)\)/);
  assert.match(source, /\}, \[embedded, requestParams\]\)/);
  assert.equal((source.match(/window\.history\./g) ?? []).length, 1);
  assert.match(source, /if \(!embedded\) \{[^}]*visibleParams\.delete\("limit"\);[\s\S]*?window\.history\.replaceState/);
  assert.doesNotMatch(source, /ARCHIVE|styles\.indexMark|catalog\.total \?\? 457/);
});

test("materials retain every filter, ranking and original resource links", () => {
  for (const key of ["q", "course", "teacher", "type", "tag", "term", "year"]) {
    assert.ok(source.includes(`changeSearch("${key}", event.target.value)`));
  }
  for (const token of ["与我相关", "全站排序", "ArrowDown", "ArrowUp", '"Enter"', '"Escape"', "encodeURIComponent(material.id)", "href={material.previewUrl}", "href={material.downloadUrl}"]) {
    assert.ok(source.includes(token), token);
  }
  assert.match(source, /moreController\.current = controller/);
  assert.match(source, /controller\.signal\.aborted \|\| currentGeneration !== generation\.current/);
  assert.match(source, /function changeSearch[\s\S]*?invalidateRequests\(\);[\s\S]*?setSearch/);
  assert.match(source, /window\.clearTimeout\(timer\);\s*invalidateRequests\(\)/);
});

test("materials use compact paper controls without altering detail-page decoration", () => {
  for (const color of ["#f4f1e9", "#fbfaf5", "#1d1b18", "#706a62", "#a52325", "#cec6ba"]) assert.ok(css.includes(color));
  assert.match(css, /font-family: var\(--journal-body/);
  assert.match(css, /\.searchField input \{[^}]*min-height: 48px/);
  assert.match(css, /\.searchField \{[^}]*border-bottom: 2px solid var\(--ink\)/);
  assert.doesNotMatch(css.match(/\.searchField \{[^}]*\}/)?.[0] ?? "", /clip-path|box-shadow|background: var\(--ink\)/);
  assert.match(css, /\.embedded \{ min-height: 0; \}/);
  assert.match(css, /\.detailIndex \{[^}]*clip-path: polygon/);
  assert.match(source, /\[filtersOpen, setFiltersOpen\] = useState\(false\)/);
  assert.match(source, /const filtersExpanded = !compactFilters \|\| filtersOpen/);
  assert.match(source, /aria-expanded=\{filtersExpanded\}/);
  assert.match(source, /hidden=\{!filtersExpanded\}/);
  assert.match(css, /\.filterContent:not\(\[hidden\]\) \{ display: grid/);
  assert.doesNotMatch(css, /\.filterContent\s*\{[^}]*display:/);
});

// Optional real-React/Chromium source-component checks, with no server, account or
// network access. Bundles and screenshots stay in memory; fixture URLs are never opened.
// PowerShell: $env:MATERIALS_EXPLORER_BROWSER='1'; node --test tests/materials-explorer.test.mjs
test("materials browser: embedding, callbacks, keyboard, layout and late requests", {
  skip: process.env.MATERIALS_EXPLORER_BROWSER !== "1",
  timeout: 60000,
}, async (t) => {
  const { build } = await import("esbuild");
  const { chromium, expect } = await import("@playwright/test");
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "jsx",
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { MaterialsExplorer } from './app/materials/MaterialsExplorer';
        window.pending = []; window.changes = []; window.links = []; window.historyWrites = [];
        const replaceState = history.replaceState.bind(history);
        history.replaceState = (...args) => { window.historyWrites.push(args[2]); replaceState(...args); };
        window.fetch = (url, options) => {
          if (url === '/api/material-bookmarks') return Promise.resolve(new Response('{}', { status: 401 }));
          if (String(url).startsWith('/api/materials?')) return new Promise((resolve, reject) => {
            // Intentionally ignore abort: cancellation must not be the only stale-write guard.
            window.pending.push({ url: String(url), signal: options?.signal, resolve, reject });
          });
          if (url === '/data/resource-manifest.json') return Promise.resolve(new Response(JSON.stringify({ materials: [] })));
          throw new Error('Unexpected fixture request: ' + url);
        };
        window.complete = (index, payload) => window.pending[index].resolve(new Response(JSON.stringify(payload)));
        document.addEventListener('click', event => {
          const link = event.target.closest('a');
          if (link) { event.preventDefault(); window.links.push(link.getAttribute('href')); }
        });
        let root;
        function Host({ options }) {
          const [tick, setTick] = useState(0);
          window.rerender = () => setTick(value => value + 1);
          const explorer = <MaterialsExplorer {...options} onSearchChange={value => {
            window.changes.push({ value, tick }); setTick(current => current + 1);
          }} />;
          return options.embedded ? <main id="host"><h1>课程</h1>{explorer}</main> : explorer;
        }
        window.mount = options => { root = createRoot(document.getElementById('root')); root.render(<Host options={options} />); };
        window.unmount = () => root.unmount();
      `,
    },
    bundle: true,
    write: false,
    outfile: "materials-source-harness.js",
    format: "iife",
    jsx: "automatic",
    plugins: [{
      name: "isolated-materials-dependencies",
      setup(build) {
        build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
        build.onResolve({ filter: /personal-course-context$/ }, () => ({ path: "context", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: path === "link"
            ? 'import { createElement } from "react"; export default function Link(props) { return createElement("a", props); }'
            : 'export async function loadPersonalCourseContext() { return { currentCourseCodes: ["CURRENT"], currentCourseNames: [], planCourseCodes: [], planCourseNames: [], teacherNames: [] }; }',
          loader: "js",
          resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        }));
      },
    }],
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
  const stylesheet = bundle.outputFiles.find((file) => file.path.endsWith(".css")).text;
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : "chrome" });
  t.after(() => browser.close());
  const filters = { courses: ["会计学"], teachers: ["测试教师"], types: ["课件"], tags: ["复习"], terms: ["fall"], years: [1] };
  const material = (id, name, current = false) => ({
    id, name, courseTitle: "会计学", courseIds: [current ? "CURRENT" : "OTHER"], teachers: ["测试教师"], colleges: [], terms: ["fall"], years: [1], tags: ["复习"], category: "课件", kind: "课件", extension: ".pdf", sizeBytes: 1024, catalogedAt: "2026-10-01T00:00:00Z", description: "来源说明完整保留", previewable: true, previewUrl: `/fixture-preview/${id}`, downloadUrl: `/fixture-download/${id}`,
  });
  const first = material("fixture/a b?资料", "全校资料（测试样例）");
  // Keep literal relevance tied: personal ranking is a tie-breaker after shared search scores.
  const current = material("fixture-current", "本期资料（测试样例）", true);
  const fresh = material("fixture-fresh", "新筛选结果（测试样例）");
  const stale = material("fixture-stale", "不应出现的过期资料");
  const response = (items, hasMore = false) => ({ items, total: hasMore ? 50 : items.length, offset: 0, limit: 24, hasMore, filters, catalog: { total: 50, generatedAt: "2026-10-01" } });
  async function open(options = { embedded: true }, width = 390) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="zh-CN"><head><title>资料组件测试</title></head><body><div id="root"></div></body></html>' }));
    await page.goto("http://materials.test/?view=catalog&center=materials");
    await page.addStyleTag({ content: `* { box-sizing: border-box; } body { margin: 0; background: #f4f1e9; } #host { padding: 18px; } :root { --journal-body: Arial, sans-serif; --dufe-paper: #f4f1e9; --dufe-paper-raised: #fbfaf5; --dufe-ink: #1d1b18; --dufe-muted: #706a62; --dufe-red: #a52325; --dufe-line: #cec6ba; } ${stylesheet}` });
    await page.addScriptTag({ content: script });
    await page.evaluate((options) => window.mount(options), options);
    await waitRequests(page, 1);
    return { page, errors };
  }
  async function waitRequests(page, count) {
    await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(count);
  }
  async function complete(page, index, payload) {
    await page.evaluate(({ index, payload }) => window.complete(index, payload), { index, payload });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }

  await t.test("embedded preserves filters, callback stability, ranking, URLs and keyboard at four widths", async () => {
    const initialSearch = { q: "资料", course: "会计学", teacher: "测试教师", type: "课件", tag: "复习", term: "fall", year: "1" };
    const { page, errors } = await open({ embedded: true, initialSearch });
    try {
      await complete(page, 0, response([first, current], true));
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.locator("#main-content")).toHaveCount(0);
      await expect(page.getByRole("region", { name: "学习资料" })).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "资料页导航" })).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 2, name: "学习资料" })).toHaveCount(1);
      assert.deepEqual(await page.evaluate(() => window.changes.map((item) => item.value)), [initialSearch]);
      const toggle = page.getByRole("button", { name: "筛选资料 · 已选 6", exact: true });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("combobox")).toHaveCount(0);
      const controlledId = await toggle.getAttribute("aria-controls");
      assert.equal(await page.evaluate((id) => document.getElementById(id).hidden, controlledId), true);
      assert.ok((await toggle.boundingBox()).height >= 44);
      assert.ok((await page.getByRole("listitem").first().boundingBox()).y < 450, "Results are above the fold while filters are collapsed");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      assert.equal(await page.evaluate((id) => document.getElementById(id).hidden, controlledId), false);
      await page.evaluate(() => window.rerender());
      await page.getByRole("combobox", { name: /标签/ }).selectOption("");
      await waitRequests(page, 2);
      await complete(page, 1, response([first, current], true));
      const changes = await page.evaluate(() => window.changes);
      assert.equal(changes.length, 2, "Inline parent callbacks must not cause a notification loop");
      assert.ok(changes[1].tick > changes[0].tick, "Changed conditions use the latest callback");
      assert.equal(changes[1].value.tag, undefined);
      await expect(page.getByRole("combobox")).toHaveCount(6);
      const items = page.getByRole("listitem");
      await expect(items.first()).toContainText(current.name);
      await page.getByRole("button", { name: "全站排序" }).click();
      await expect(items.first()).toContainText(first.name);
      await expect(items.first().getByRole("link", { name: first.name })).toHaveAttribute("href", `/materials/${encodeURIComponent(first.id)}`);
      await expect(items.first().getByRole("link", { name: "预览", exact: true })).toHaveAttribute("href", first.previewUrl);
      await expect(items.first().getByRole("link", { name: "下载", exact: true })).toHaveAttribute("href", first.downloadUrl);
      const search = page.getByRole("searchbox");
      await search.focus();
      await search.press("ArrowDown");
      await expect(items.first().getByRole("link", { name: first.name })).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(items.last().getByRole("link", { name: current.name })).toBeFocused();
      await page.keyboard.press("Enter");
      assert.deepEqual(await page.evaluate(() => window.links), ["/materials/fixture-current"]);
      for (const width of [320, 390, 844, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${width}`);
        assert.ok((await search.boundingBox()).height >= 44);
        for (const control of await page.getByRole("combobox").all()) assert.ok((await control.boundingBox()).height >= 44);
        const audit = await new AxeBuilder({ page }).analyze();
        assert.deepEqual(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)), [], `axe at ${width}`);
      }
      await expect(page.getByRole("button", { name: /筛选资料/ })).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.getByRole("button", { name: /筛选资料/ }).click();
      await expect(page.getByRole("combobox")).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(page.getByRole("combobox")).toHaveCount(6);
      await page.setViewportSize({ width: 390, height: 900 });
      await expect(page.getByRole("button", { name: /筛选资料/ })).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("combobox")).toHaveCount(0);
      const collapsedAudit = await new AxeBuilder({ page }).analyze();
      assert.deepEqual(collapsedAudit.violations.filter((item) => ["serious", "critical"].includes(item.impact)), []);
      if (process.env.MATERIALS_EXPLORER_SCREENSHOT === "1") console.log(`MATERIALS_SCREENSHOT:${(await page.screenshot()).toString("base64")}`);
      await search.press("Escape");
      await waitRequests(page, 3);
      assert.deepEqual(await page.evaluate(() => window.changes.at(-1).value), {});
      await complete(page, 2, response([first]));
      assert.deepEqual(await page.evaluate(() => window.historyWrites), []);
      assert.equal(new URL(page.url()).search, "?view=catalog&center=materials");
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  await t.test("late pagination success/error cannot append or unlock the new request", async () => {
    for (const rejectOld of [false, true]) {
      const { page, errors } = await open();
      try {
        await complete(page, 0, response([first], true));
        await page.getByRole("button", { name: "继续查看" }).click();
        await waitRequests(page, 2);
        await page.getByRole("searchbox").fill("新筛选");
        await waitRequests(page, 3);
        assert.equal(await page.evaluate(() => window.pending[1].signal.aborted), true);
        await complete(page, 2, response([fresh], true));
        await page.getByRole("button", { name: "继续查看" }).click();
        await waitRequests(page, 4);
        if (rejectOld) await page.evaluate(() => window.pending[1].reject(new Error("stale_failure")));
        else await complete(page, 1, response([stale]));
        await expect(page.getByRole("button", { name: "正在继续读取" })).toBeDisabled();
        await expect(page.getByText(stale.name)).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        await complete(page, 3, response([current]));
        await expect(page.getByRole("listitem")).toHaveCount(2);
        await expect(page.getByText(fresh.name, { exact: true })).toBeVisible();
        assert.deepEqual(await page.evaluate(() => window.historyWrites), []);
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    }
  });

  await t.test("standalone keeps normalized URLs; stale searches and unmounted work cannot write", async () => {
    const { page, errors } = await open({ initialSearch: { q: "  原搜索  ", tag: "复习" } });
    try {
      await expect(page.locator("main#main-content")).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "资料页导航" })).toBeVisible();
      await page.getByRole("searchbox").fill("  新搜索  ");
      await waitRequests(page, 2);
      await complete(page, 1, response([fresh], true));
      await complete(page, 0, response([stale]));
      await expect(page.getByText(stale.name)).toHaveCount(0);
      assert.equal(new URL(page.url()).pathname, "/materials");
      assert.equal(new URL(page.url()).searchParams.get("q"), "新搜索");
      assert.equal(new URL(page.url()).searchParams.get("tag"), "复习");
      assert.equal(new URL(page.url()).searchParams.has("limit"), false);
      assert.deepEqual(await page.evaluate(() => window.changes), []);
      await page.getByRole("button", { name: "继续查看" }).click();
      await waitRequests(page, 3);
      await page.getByRole("searchbox").fill("卸载中的搜索");
      await waitRequests(page, 4);
      const before = await page.evaluate(() => window.historyWrites);
      await page.evaluate(() => window.unmount());
      await complete(page, 2, response([stale]));
      await complete(page, 3, response([stale]));
      assert.deepEqual(await page.evaluate(() => window.historyWrites), before);
      assert.deepEqual(await page.evaluate(() => window.pending.map((item) => item.signal.aborted)), [true, true, true, true]);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });
});
