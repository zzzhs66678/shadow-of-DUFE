import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Isolated source-component test. No project build/server or real account used.
test("material bookmark UI: account boundaries, list/detail actions, missing records and mobile", {
  skip: process.env.MATERIAL_BOOKMARKS_BROWSER !== "1", timeout: 60000,
}, async (t) => {
  const { build } = await import("esbuild");
  const { chromium, expect } = await import("@playwright/test");
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const bundled = await build({
    stdin: { resolveDir: rootDir, loader: "jsx", contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { MaterialsExplorer } from './app/materials/MaterialsExplorer';
      import { MaterialDetailBookmark } from './app/materials/MaterialBookmarkControls';
      import { MaterialAvailability } from './app/materials/MaterialAvailability';
      import { scoreMaterialSearch, matchesMaterialFilters } from './app/materials/materials-search';
      const a = '00000000-0000-4000-8000-000000002501';
      const b = '00000000-0000-4000-8000-000000002502';
      const first = '11111111111111111111', second = '22222222222222222222', missing = 'ffffffffffffffffffff';
      const make = (id, title, courseId) => ({ id, name: '课件.pdf', courseTitle: title, courseIds: [courseId], teachers: ['刘笑丹'], colleges: [], tags: ['复习'], terms: ['fall'], years: [1], category: '课件', kind: 'PDF', extension: '.pdf', sizeBytes: 1024, catalogedAt: '2026-10-01', description: '测试资料', previewable: true, previewUrl: '/fixture-preview/' + id, downloadUrl: '/fixture-download/' + id });
      window.materials = [make(first, '中国近现代史纲要', 'HISTORY'), make(second, '高级财务会计', 'ACCOUNT')];
      window.account = a;
      window.saved = { [a]: [], [b]: [second] };
      window.holdNextRead = false; window.late = []; window.writes = []; window.failWrite = false; window.failResolve = false;
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
      window.fetch = async (input, options = {}) => {
        const url = new URL(input, location.origin);
        if (url.pathname === '/fixture-denied') return new Response(null, { status: 403 });
        if (url.pathname === '/api/material-bookmarks') {
          const payload = window.account ? { userId: window.account, items: window.saved[window.account].map(materialId => ({ materialId, bookmarkedAt: '2026-10-09' })) } : {};
          const status = window.account ? 200 : 401;
          if (window.holdNextRead) { window.holdNextRead = false; return new Promise(resolve => window.late.push(() => resolve(json(payload, status)))); }
          return json(payload, status);
        }
        if (url.pathname.startsWith('/api/material-bookmarks/')) {
          const id = url.pathname.split('/').at(-1);
          window.writes.push({ id, method: options.method, owner: options.headers['X-Material-Bookmark-Owner'] });
          if (!window.account) return json({ error: 'authentication_required' }, 401);
          if (options.headers['X-Material-Bookmark-Owner'] !== window.account) return json({ error: 'material_bookmark_account_changed' }, 409);
          if (window.failWrite) return json({ error: 'rate_limit_exceeded' }, 429);
          if (options.method === 'PUT') window.saved[window.account] = [...new Set([...window.saved[window.account], id])];
          else window.saved[window.account] = window.saved[window.account].filter(value => value !== id);
          return json({ userId: window.account, materialId: id, bookmarked: options.method === 'PUT' });
        }
        if (url.pathname === '/api/materials/resolve') {
          if (window.failResolve) return json({}, 503);
          return json({ items: JSON.parse(options.body).ids.map(materialId => ({ materialId, material: window.materials.find(item => item.id === materialId) ?? null })) });
        }
        if (url.pathname === '/data/resource-manifest.json') return json({ materials: window.materials });
        if (url.pathname === '/api/materials') {
          const filters = { query: url.searchParams.get('q'), course: url.searchParams.get('course'), teacher: url.searchParams.get('teacher'), type: url.searchParams.get('type'), tag: url.searchParams.get('tag'), term: url.searchParams.get('term'), year: url.searchParams.get('year') };
          const items = window.materials.filter(item => matchesMaterialFilters(item, filters)).sort((l, r) => scoreMaterialSearch(r, filters.query ?? '') - scoreMaterialSearch(l, filters.query ?? ''));
          return json({ items, total: items.length, limit: 24, offset: 0, hasMore: false, filters: { courses: [], teachers: [], types: [], tags: [], terms: [], years: [] }, catalog: { total: 2 } });
        }
        throw new Error('Unexpected fixture request: ' + input);
      };
      window.changeAccount = (user) => { window.account = user; window.dispatchEvent(new Event('dufesh:auth-changed')); };
      window.refreshBookmarks = () => window.dispatchEvent(new Event('dufesh:material-bookmarks-refresh'));
      let root;
      window.mount = (detail = false) => {
        root = createRoot(document.getElementById('root'));
        root.render(detail ? <main><h1>资料详情</h1><MaterialAvailability downloadUrl="/fixture-denied" previewUrl="/fixture-denied" previewable /><MaterialDetailBookmark materialId={first} /></main> : <main><h1>课程资料</h1><MaterialsExplorer embedded /></main>);
      };
      window.unmount = () => root.unmount();
    ` },
    bundle: true, write: false, format: "iife", jsx: "automatic", outfile: "material-bookmarks-harness.js",
    plugins: [{ name: "fixture-dependencies", setup(builder) {
      builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      builder.onResolve({ filter: /personal-course-context$/ }, () => ({ path: "personal", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path === "link" ? 'import { createElement } from "react"; export default function Link(props) { return createElement("a", props); }' : 'export async function loadPersonalCourseContext() { return { currentCourseCodes: ["HISTORY"], currentCourseNames: [], planCourseCodes: [], planCourseNames: [], teacherNames: [] }; }',
        loader: "js", resolveDir: rootDir,
      }));
    } }],
  });
  const js = bundled.outputFiles.find((file) => file.path.endsWith(".js")).text;
  const css = bundled.outputFiles.find((file) => file.path.endsWith(".css")).text;
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : "chrome" });
  t.after(() => browser.close());
  async function open(detail = false) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(6000);
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="zh-CN"><head><title>收藏测试</title></head><body><div id="root"></div></body></html>' }));
    await page.goto("http://materials.test/");
    await page.addStyleTag({ content: `* { box-sizing: border-box; } body { margin: 0; } main { padding: 12px; } :root { --dufe-paper: #f4f1e9; --dufe-paper-raised: #fbfaf5; --dufe-ink: #1d1b18; --dufe-muted: #706a62; --dufe-red: #a52325; --dufe-line: #cec6ba; } ${css}` });
    await page.addScriptTag({ content: js });
    await page.evaluate((detail) => window.mount(detail), detail);
    return { page, errors };
  }
  const a = "00000000-0000-4000-8000-000000002501";
  const b = "00000000-0000-4000-8000-000000002502";
  const firstId = "11111111111111111111";

  await t.test("list IDs stay distinct despite identical filenames; saved tab filters and missing removal", async () => {
    const { page, errors } = await open();
    try {
      await expect(page.getByRole("button", { name: "收藏", exact: true })).toHaveCount(2);
      await page.getByRole("listitem").first().getByRole("button", { name: "收藏", exact: true }).click();
      await expect(page.getByRole("button", { name: "取消收藏", exact: true })).toHaveCount(1);
      assert.deepEqual(await page.evaluate((a) => window.saved[a], a), [firstId]);
      await page.getByRole("searchbox").fill("近代史 刘笑丹");
      await expect(page.getByRole("listitem")).toHaveCount(1);
      await expect(page.getByRole("listitem")).toContainText("中国近现代史纲要");
      await page.getByRole("button", { name: "全站排序", exact: true }).click();
      await expect(page.getByRole("listitem")).toHaveCount(1);
      await page.getByRole("button", { name: "已收藏", exact: true }).click();
      await expect(page.getByRole("list", { name: "已收藏资料" }).getByRole("listitem")).toHaveCount(1);
      await page.getByRole("searchbox").fill("高财");
      await expect(page.getByText("没有符合当前筛选的收藏，试试清空搜索或筛选。")).toBeVisible();
      await page.getByRole("searchbox").fill("");
      await page.evaluate((a) => { window.saved[a].push('ffffffffffffffffffff'); window.refreshBookmarks(); }, a);
      await expect(page.getByText("资料已下架或不存在")).toBeVisible();
      const missing = page.getByRole("listitem").filter({ hasText: "资料已下架或不存在" });
      await expect(missing.getByRole("link")).toHaveCount(0);
      await missing.getByRole("button", { name: "取消收藏" }).click();
      await expect(page.getByText("资料已下架或不存在")).toHaveCount(0);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${width}`);
        assert.ok((await page.getByRole("button", { name: "取消收藏", exact: true }).boundingBox()).height >= 44);
        const audit = await new AxeBuilder({ page }).analyze();
        assert.deepEqual(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)), []);
      }
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), []);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  await t.test("account switch and late responses never restore old user's bookmarks", async () => {
    const { page, errors } = await open();
    try {
      await expect(page.getByRole("button", { name: "收藏", exact: true })).toHaveCount(2);
      await page.evaluate((a) => { window.saved[a] = ['11111111111111111111']; window.holdNextRead = true; window.refreshBookmarks(); }, a);
      await expect.poll(() => page.evaluate(() => window.late.length)).toBe(1);
      await page.evaluate((b) => window.changeAccount(b), b);
      await expect(page.getByRole("listitem").filter({ hasText: "高级财务会计" }).getByRole("button", { name: "取消收藏" })).toBeVisible();
      await page.evaluate(() => window.late[0]());
      await expect(page.getByRole("listitem").filter({ hasText: "中国近现代史纲要" }).getByRole("button", { name: "收藏", exact: true })).toBeVisible();
      // Simulate a cookie switch with no DOM notification: the owner guard still prevents a write.
      await page.evaluate((a) => { window.account = a; }, a);
      await page.getByRole("listitem").filter({ hasText: "高级财务会计" }).getByRole("button", { name: "取消收藏" }).click();
      await expect(page.getByText("登录状态已变化，请确认当前账号后重试。")).toBeVisible();
      assert.deepEqual(await page.evaluate((b) => window.saved[b], b), ['22222222222222222222']);
      await page.evaluate(() => window.changeAccount(null));
      await page.getByRole("button", { name: "已收藏", exact: true }).click();
      await expect(page.getByText("登录后查看已收藏资料")).toBeVisible();
      await expect(page.getByRole("listitem")).toHaveCount(0);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  await t.test("detail saves/removes; failed writes never claim success; failed lookups still allow removal", async () => {
    const { page, errors } = await open(true);
    try {
      await expect(page.getByRole("button", { name: "收藏", exact: true })).toBeEnabled();
      await expect(page.getByText("文件访问受限")).toBeVisible();
      await page.evaluate(() => { window.failWrite = true; });
      await page.getByRole("button", { name: "收藏", exact: true }).click();
      await expect(page.getByText("操作较频繁，请稍后重试。")).toBeVisible();
      await expect(page.getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "false");
      await page.evaluate(() => { window.failWrite = false; });
      await page.getByRole("button", { name: "收藏", exact: true }).click();
      await expect(page.getByRole("button", { name: "取消收藏" })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("link", { name: /下载原件|在线预览/ })).toHaveCount(0);
      await expect(page.getByText("文件访问受限")).toBeVisible();
      await page.getByRole("button", { name: "取消收藏" }).click();
      await expect(page.getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "false");
      await page.evaluate((a) => { window.unmount(); window.saved[a] = ['11111111111111111111']; window.failResolve = true; window.mount(false); }, a);
      await page.getByRole("button", { name: "已收藏", exact: true }).click();
      await expect(page.getByText("收藏的资料信息暂时无法读取")).toBeVisible();
      await page.getByRole("button", { name: "取消收藏" }).click();
      await expect(page.getByText("还没有收藏资料")).toBeVisible();
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });
});
