// Local-only browser check: npm run build && npm start, then node tests/teacher-reading.browser.mjs.
// All API responses are synthetic fixtures. No production hosts, accounts, or writes are used.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const base = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000');
assert.ok(['http:', 'https:'].includes(base.protocol), 'Use a local HTTP(S) server');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'This script refuses non-loopback hosts');
assert.equal(base.username + base.password, '', 'Do not provide credentials');

const teacherId = '11111111-1111-4111-8111-111111111111';
const teacherPath = `/teachers/${teacherId}`;
const reviewPath = `/api${teacherPath}/reviews`;
const teacher = {
  id: teacherId, displayName: '李怀墨', collegeName: '会计学院', courseCount: 1, reviewCount: 4,
  ratings: { courseOrganization: null, contentClarity: null, assessmentExplanation: null, classroomInteraction: null, materialCompleteness: null },
  sections: [{ id: 'fixture-section', termKey: '2026-2027-fall', courseId: 'LOCAL001', courseTitle: '本地验收课程', sectionNo: '01', status: 'current' }],
  textbooks: [{ id: 'fixture-book', termKey: '2026-2027-fall', courseId: 'LOCAL001', courseTitle: '本地验收课程', sectionNo: '01', selectionStatus: 'specified', title: '本地验收教材', author: '测试作者', publisher: '测试出版社', edition: '第 3 版', isbn: '9780000000000', status: 'current' }],
};
const review = (id, body) => ({ id, body, sourceType: 'legacy_approved', authorLabel: '历史整理内容', ratings: null, discussionCount: 0, publishedAt: '2026-09-20T04:00:00.000Z' });
const firstReview = review('22222222-2222-4222-8222-222222222222', '历史评价首屏：讲课条理清楚，课堂举例贴近实际。考核要求请以当学期说明为准。');
const secondReview = review('33333333-3333-4333-8333-333333333333', '第二页评价：平时可以整理课堂笔记，复习时再结合教材查漏补缺。');
const discussedReview = review('44444444-4444-4444-8444-444444444444', '热议排序首条：课堂讨论有帮助，以下是另一组排序结果。');
const discussedMore = review('55555555-5555-4555-8555-555555555555', '热议排序第二页：这条评价只属于热议排序的后续页面。');
const staleReview = review('66666666-6666-4666-8666-666666666666', '不应出现的旧分页：排序切换后必须忽略这条迟到评价。');
const indexItems = [
  { ...teacher, updatedAt: '2026-09-20T04:00:00.000Z' },
  { id: '77777777-7777-4777-8777-777777777777', displayName: '周明远', collegeName: '国际经济贸易学院', courseCount: 3, reviewCount: 12, updatedAt: '2026-09-20T04:00:00.000Z' },
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function afterPaint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function noOverflow(page) {
  await afterPaint(page);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.root <= dimensions.width && dimensions.body <= dimensions.width, `Page overflows: ${JSON.stringify(dimensions)}`);
}

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });

async function withPage(width, scenario, run) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  const state = { scenario, calls: [], unexpected: [], errors: [], oldRelease: deferred(), freshRelease: deferred() };
  try {
    if (scenario === 'race') {
      // Emulate a transport that ignores cancellation so generation checks, not only AbortController, are exercised.
      await context.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (/\/api\/teachers\/[^/]+\/reviews$/u.test(url.pathname) && url.searchParams.has('after')) {
            const options = { ...init };
            delete options.signal;
            return originalFetch(input, options);
          }
          return originalFetch(input, init);
        };
      });
    }
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.href === 'https://dufesh.cn/favicon.svg') {
        // Site metadata uses an absolute icon URL; serve a fixture without contacting that host.
        await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        return;
      }
      if (url.origin !== base.origin) {
        state.unexpected.push(`External request blocked: ${url.origin}${url.pathname}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        await route.continue();
        return;
      }
      if (request.method() !== 'GET') {
        state.unexpected.push(`Unexpected write blocked: ${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 405, json: { error: 'fixture_read_only' } });
        return;
      }
      if (url.pathname === '/api/auth/session') {
        await route.fulfill({ json: { authenticated: false } });
      } else if (url.pathname === '/api/teachers') {
        await route.fulfill({ json: { items: indexItems, nextCursor: null } });
      } else if (url.pathname === `/api${teacherPath}`) {
        await route.fulfill({ json: { teacher } });
      } else if (url.pathname === `/api${teacherPath}/my-review`) {
        await route.fulfill({ status: 401, json: { error: 'authentication_required' } });
      } else if (url.pathname === reviewPath) {
        const sort = url.searchParams.get('sort');
        const after = url.searchParams.get('after');
        state.calls.push({ sort, after, query: url.searchParams.get('q') });
        if (after && scenario === 'retry') {
          const attempts = state.calls.filter((call) => call.after === after).length;
          await route.fulfill(attempts === 1
            ? { status: 503, json: { error: 'fixture_unavailable' } }
            : { json: { items: [firstReview, secondReview], nextCursor: null } });
        } else if (after && scenario === 'race') {
          const old = sort !== 'discussed';
          await (old ? state.oldRelease : state.freshRelease).promise;
          await route.fulfill({ json: { items: [old ? staleReview : discussedMore], nextCursor: old ? 'stale-cursor' : null } });
        } else {
          await route.fulfill({ json: {
            items: [sort === 'discussed' ? discussedReview : firstReview],
            nextCursor: scenario === 'retry' || scenario === 'race' ? `${sort}-page-2` : null,
          } });
        }
      } else if (url.pathname.startsWith(`${reviewPath}/`) && url.pathname.endsWith('/comments')) {
        await route.fulfill({ json: { items: [], nextCursor: null } });
      } else {
        state.unexpected.push(`Unmocked API blocked: ${url.pathname}`);
        await route.fulfill({ status: 501, json: { error: 'missing_fixture' } });
      }
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => state.errors.push(error.message));
    await run(page, state);
    assert.deepEqual(state.errors, [], 'No uncaught browser errors');
    assert.deepEqual(state.unexpected, [], 'No unmocked API, external request, or write is allowed');
    console.log(JSON.stringify({ scenario, width, passed: true }));
  } finally {
    state.oldRelease.resolve();
    state.freshRelease.resolve();
    await context.close();
  }
}

try {
  for (const width of [390, 844]) {
    await withPage(width, 'directory-and-reading', async (page) => {
      await page.goto(`${base.origin}/teachers`);
      const teacherLink = page.getByRole('link', { name: /李怀墨/u });
      await expect(teacherLink).toBeVisible();
      await noOverflow(page);
      await page.keyboard.press('Tab');
      await teacherLink.focus();
      const focus = await teacherLink.evaluate((element) => ({ visible: element.matches(':focus-visible'), width: getComputedStyle(element).outlineWidth, color: getComputedStyle(element).outlineColor }));
      assert.ok(focus.visible && focus.width === '2px' && focus.color !== 'rgba(0, 0, 0, 0)', 'Directory links have a visible keyboard outline');

      await page.goto(`${base.origin}${teacherPath}`);
      const body = page.getByText(firstReview.body, { exact: true });
      await expect(body).toBeVisible();
      const firstBox = await body.boundingBox();
      assert.ok(firstBox && firstBox.y >= 0 && firstBox.y + Math.min(firstBox.height, 32) < 844, 'Historical review body starts on the first screen');
      const textbooks = page.getByRole('heading', { name: '教材', exact: true, includeHidden: true });
      await expect(textbooks).toBeHidden();
      await expect(page.locator('main > div[hidden]')).toHaveCount(1);
      const entry = page.locator('article').filter({ hasText: firstReview.body });
      assert.ok(await entry.locator('time').evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 12));
      assert.equal(await body.evaluate((element) => getComputedStyle(element).fontSize), '16px');
      await noOverflow(page);

      await page.getByRole('button', { name: '课程与教材', exact: true }).click();
      await expect(textbooks).toBeVisible();
      await expect(body).toBeHidden();
      await expect(page.getByText('第 3 版', { exact: true })).toBeVisible();
      await noOverflow(page);
      await page.getByRole('button', { name: /^学生评价/u }).click();
      await expect(body).toBeVisible();
      await expect(textbooks).toBeHidden();

      await page.goto(`${base.origin}${teacherPath}?reviewQuery=${encodeURIComponent('考核')}&reviewSort=relevant`);
      await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
      const summary = page.locator('summary').filter({ hasText: '查找与排列评价' });
      await expect(summary).toContainText('考核');
      await expect(summary).toContainText('相关');
      const query = page.getByLabel('在评价里查找', { exact: true });
      await expect(query).toBeHidden();
      await summary.click();
      await expect(query).toBeVisible();
      assert.equal(await query.evaluate((element) => getComputedStyle(element).fontSize), '16px');
      await summary.click();
      await expect(summary).toContainText('考核');
      await noOverflow(page);
    });
  }

  await withPage(390, 'retry', async (page, state) => {
    await page.goto(`${base.origin}${teacherPath}`);
    await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续查看评价', exact: true }).click();
    await expect(page.getByText('后续评价暂时没有加载成功，已读内容仍保留。', { exact: true })).toBeVisible();
    await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重新读取更多评价', exact: true }).click();
    await expect(page.getByText(secondReview.body, { exact: true })).toBeVisible();
    await expect(page.getByText(firstReview.body, { exact: true })).toHaveCount(1);
    assert.equal(state.calls.filter((call) => call.after).length, 2, 'One failed page request and one retry');
    await expect(page.getByRole('button', { name: '重新读取更多评价', exact: true })).toHaveCount(0);
    await noOverflow(page);
  });

  await withPage(390, 'race', async (page, state) => {
    await page.goto(`${base.origin}${teacherPath}`);
    const more = page.getByRole('button', { name: '继续查看评价', exact: true });
    await expect(more).toBeVisible();
    await more.evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.calls.filter((call) => call.after && call.sort === 'latest').length).toBe(1);
    await expect(page.getByRole('button', { name: '正在读取…', exact: true })).toBeDisabled();
    assert.equal(state.calls.filter((call) => call.after).length, 1, 'Concurrent clicks do not request the same page twice');
    await page.locator('summary').filter({ hasText: '查找与排列评价' }).click();
    await page.getByRole('button', { name: '热议', exact: true }).click();
    await expect(page.getByText(discussedReview.body, { exact: true })).toBeVisible();
    await expect(page.getByText(firstReview.body, { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '继续查看评价', exact: true }).click();
    await expect.poll(() => state.calls.filter((call) => call.after && call.sort === 'discussed').length).toBe(1);
    const staleResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === reviewPath && url.searchParams.get('after') === 'latest-page-2';
    });
    state.oldRelease.resolve();
    await (await staleResponse).finished();
    await afterPaint(page);
    await expect(page.getByText(staleReview.body, { exact: true })).toHaveCount(0);
    await expect(page.getByText(discussedReview.body, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '正在读取…', exact: true })).toBeDisabled();
    state.freshRelease.resolve();
    await expect(page.getByText(discussedMore.body, { exact: true })).toBeVisible();
    await expect(page.getByText(staleReview.body, { exact: true })).toHaveCount(0);
    assert.equal(state.calls.filter((call) => call.after).length, 2, 'Only one page request per sort is sent');
    await expect(page.getByRole('button', { name: '继续查看评价', exact: true })).toHaveCount(0);
    await noOverflow(page);
  });
  await withPage(390, 'race', async (page) => {
    await page.goto(`${base.origin}${teacherPath}?panel=teaching&course=LOCAL001`);
    await expect(page.getByRole('heading', { name: '本地验收教材', exact: true })).toBeVisible();
    await expect(page.getByText('第 3 版', { exact: true })).toBeVisible();
    await page.goto(`${base.origin}${teacherPath}?panel=teaching&course=OTHER`);
    await expect(page.getByText('这位教师名下暂未记录该课程的教材，请以任课教师通知为准。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '本地验收教材', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '查看这位教师的全部教材' }).click();
    await expect(page.getByRole('heading', { name: '本地验收教材', exact: true })).toBeVisible();
    await noOverflow(page);
  });
} finally {
  await browser.close();
}
