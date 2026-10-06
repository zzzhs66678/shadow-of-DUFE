// Shared browser checks: run directly locally, or through teacher-reading.accessibility.spec.ts.
// All API responses and writes are synthetic fixtures. No production hosts or accounts are used.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function runTeacherReadingChecks({ browser, baseURL, screenshots, widths = [320, 390, 844, 1280], contextOptions = {} }) {
const base = new URL(baseURL);
await mkdir(screenshots, { recursive: true });
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
const staleReview = review('66666666-6666-4666-8666-666666666666', '不应出现的旧分页：清除旧链接筛选后必须忽略这条迟到评价。');
const historicalRatings = { courseOrganization: 5, contentClarity: 4, assessmentExplanation: 3, classroomInteraction: 2, materialCompleteness: 1 };
const previousOwnReview = { ...review('88888888-8888-4888-8888-888888888888', '以前发布的真实课堂体验，旧评分保存在服务端。'), sourceType: 'user', authorLabel: '已注册用户', ratings: historicalRatings, version: 7, status: 'published', updatedAt: '2026-10-01T00:00:00Z' };
const currentReview = { ...review('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '课堂的例子很具体，笔记整理起来也清楚。'), sourceType: 'user', authorLabel: '陈同学', publishedAt: '2026-10-01T04:00:00.000Z' };
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

async function expectVisuallyHidden(locator) {
  await expect(locator).toHaveCount(1);
  assert.equal(await locator.evaluate((element) => getComputedStyle(element).clipPath), 'inset(50%)');
  const box = await locator.boundingBox();
  assert.ok(box && box.width <= 1 && box.height <= 1, 'Accessible label takes no visible layout space');
}


async function withPage(width, scenario, run) {
  const context = await browser.newContext({ ...contextOptions, viewport: { width, height: 844 }, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  const signedIn = ['composer', 'old-review', 'hidden-review', 'conflict', 'expired-session'].includes(scenario);
  const state = { scenario, calls: [], teacherCalls: [], writes: [], replyWrites: [], commentCalls: 0, comments: [], ownReview: ['old-review', 'hidden-review', 'conflict'].includes(scenario) ? { ...previousOwnReview, status: scenario === 'hidden-review' ? 'hidden' : 'published' } : null, unexpected: [], errors: [], oldRelease: deferred(), freshRelease: deferred() };
  try {
    if (scenario === 'race' || scenario === 'directory-race') {
      // Emulate a transport that ignores cancellation so generation checks, not only AbortController, are exercised.
      await context.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if ((url.pathname === '/api/teachers' || /\/api\/teachers\/[^/]+\/reviews$/u.test(url.pathname)) && url.searchParams.has('after')) {
            const options = { ...init };
            delete options.signal;
            return originalFetch(input, options);
          }
          return originalFetch(input, init);
        };
      });
    }
    await context.addInitScript(() => {
      localStorage.setItem('dufesh:student-profile:v3:anonymous', JSON.stringify({ academicSnapshots: [{ academicYear: '2026-2027', importedAt: '2026-10-01T00:00:00Z', sections: [{ courseCode: 'LOCAL001', courseName: '本地课程', teachers: ['周明远'] }] }] }));
    });
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
      if (request.method() !== 'GET' && signedIn && url.pathname === `/api${teacherPath}/my-review` && ['PUT', 'DELETE'].includes(request.method())) {
        const input = request.postDataJSON();
        state.writes.push({ method: request.method(), input });
        if (request.method() === 'DELETE') {
          state.ownReview = null;
          await route.fulfill({ json: { review: { id: '88888888-8888-4888-8888-888888888888', status: 'deleted' } } });
        } else if (scenario === 'expired-session') {
          await route.fulfill({ status: 401, json: { error: 'authentication_required' } });
        } else if (scenario === 'conflict' && state.writes.length === 1) {
          state.ownReview = { ...state.ownReview, body: '另一处已更新的评价正文。', version: 8 };
          await route.fulfill({ status: 409, json: { error: 'review_version_conflict' } });
        } else {
          state.ownReview = { ...review('88888888-8888-4888-8888-888888888888', input.body), sourceType: 'user', authorLabel: '已注册用户', ratings: state.ownReview?.ratings ?? null, version: (input.expectedVersion ?? 0) + 1, status: 'published', updatedAt: '2026-10-01T00:00:00Z' };
          await route.fulfill({ status: input.expectedVersion ? 200 : 201, json: { review: state.ownReview } });
        }
        return;
      }
      if (scenario === 'composer' && request.method() !== 'GET' && (url.pathname === `${reviewPath}/${firstReview.id}/comments` || url.pathname === '/api/teachers/review-comments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')) {
        const input = request.postDataJSON();
        state.replyWrites.push({ method: request.method(), input });
        const comment = request.method() === 'POST' ? {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', reviewId: firstReview.id, parentCommentId: null, rootCommentId: null, replyToUserId: null,
          body: input.body, status: 'published', version: 1,
          author: { id: '99999999-9999-4999-8999-999999999999', username: 'reply-user', displayName: '回复用户', avatarUrl: null },
          createdAt: '2026-10-01T04:00:00.000Z', updatedAt: '2026-10-01T04:00:00.000Z', editedAt: null,
        } : { ...state.comments[0], body: request.method() === 'DELETE' ? null : input.body, status: request.method() === 'DELETE' ? 'deleted' : 'published', version: input.version + 1 };
        state.comments = [comment];
        await route.fulfill({ json: { comment } });
        return;
      }
      if (request.method() !== 'GET') {
        state.unexpected.push(`Unexpected write blocked: ${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 405, json: { error: 'fixture_read_only' } });
        return;
      }
      if (url.pathname === '/api/auth/session') {
        await route.fulfill({ json: signedIn ? { authenticated: true, user: { id: '99999999-9999-4999-8999-999999999999' } } : { authenticated: false } });
      } else if (url.pathname === '/api/teachers') {
        const college = url.searchParams.get('college');
        const query = url.searchParams.get('q');
        const after = url.searchParams.get('after');
        state.teacherCalls.push({ college, query, after });
        if (scenario === 'directory-race' && after) {
          const old = college === '会计学院';
          await (old ? state.oldRelease : state.freshRelease).promise;
          await route.fulfill({ json: { items: [{ ...indexItems[old ? 0 : 1], id: old ? 'stale-teacher' : 'new-teacher', displayName: old ? '迟到的旧学院教师' : '新学院第二页教师' }], nextCursor: null } });
        } else if (scenario === 'directory-retry' && after) {
          const attempts = state.teacherCalls.filter((call) => call.after).length;
          await route.fulfill(attempts === 1 ? { status: 503, json: { error: 'fixture_unavailable' } } : { json: { items: [indexItems[0], { ...indexItems[0], id: 'another-teacher', displayName: '同学院第二页教师' }], nextCursor: null } });
        } else {
          await route.fulfill({ json: { items: indexItems.filter((item) => (!college || item.collegeName === college) && (!query || item.displayName.includes(query))), nextCursor: scenario.startsWith('directory-') && scenario !== 'directory-and-reading' ? `${college}-next` : null } });
        }
      } else if (url.pathname === '/api/teachers/colleges') {
        await route.fulfill({ json: { items: indexItems.map((item) => ({ key: item.collegeName, name: item.collegeName, teacherCount: 1 })) } });
      } else if (url.pathname === `/api${teacherPath}`) {
        await route.fulfill({ json: { teacher } });
      } else if (url.pathname === `/api${teacherPath}/my-review`) {
        await route.fulfill(signedIn ? { json: { review: state.ownReview } } : { status: 401, json: { error: 'authentication_required' } });
      } else if (url.pathname === reviewPath) {
        const sort = url.searchParams.get('sort');
        const after = url.searchParams.get('after');
        state.calls.push({ sort, after, query: url.searchParams.get('q') });
        if (url.searchParams.get('q') === '无匹配') {
          await route.fulfill({ json: { items: [], nextCursor: null } });
        } else if (after && scenario === 'retry') {
          const attempts = state.calls.filter((call) => call.after === after).length;
          await route.fulfill(attempts === 1
            ? { status: 503, json: { error: 'fixture_unavailable' } }
            : { json: { items: [firstReview, secondReview], nextCursor: null } });
        } else if (after && scenario === 'race') {
          const old = sort === 'discussed';
          await (old ? state.oldRelease : state.freshRelease).promise;
          await route.fulfill({ json: { items: [old ? staleReview : secondReview], nextCursor: old ? 'stale-cursor' : null } });
        } else {
          await route.fulfill({ json: {
            items: [...(state.ownReview?.status === 'published' ? [{ ...state.ownReview, discussionCount: 0 }] : []), sort === 'discussed' ? discussedReview : firstReview, ...(scenario === 'directory-and-reading' ? [currentReview] : [])],
            nextCursor: scenario === 'retry' || scenario === 'race' ? `${sort}-page-2` : null,
          } });
        }
      } else if (url.pathname.startsWith(`${reviewPath}/`) && url.pathname.endsWith('/comments')) {
        state.commentCalls += 1;
        await route.fulfill({ json: { items: state.comments, nextCursor: null } });
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

  for (const width of widths) {
    await withPage(width, 'directory-and-reading', async (page, state) => {
      await page.goto(`${base.origin}/teachers`);
      await expect(page.getByRole('button', { name: /会计学院/u })).toBeVisible();
      assert.equal(state.teacherCalls.length, 0, 'Default directory loads colleges, not one page of teacher names');
      await noOverflow(page);
      await page.screenshot({ path: path.join(screenshots, `colleges-${width}.png`), fullPage: true });
      assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, [], 'College index passes axe');
      await page.getByRole('button', { name: /会计学院/u }).click();
      const teacherLink = page.getByRole('link', { name: /李怀墨/u });
      await expect(teacherLink).toBeVisible();
      assert.equal(state.teacherCalls.at(-1).college, '会计学院');
      await expect(page.getByRole('link', { name: /周明远/u })).toHaveCount(0);
      await page.reload();
      await expect(page.getByLabel('学院', { exact: true })).toHaveValue('会计学院');
      await expect(teacherLink).toBeVisible();
      await noOverflow(page);
      await page.keyboard.press('Tab');
      await teacherLink.focus();
      const focus = await teacherLink.evaluate((element) => ({ visible: element.matches(':focus-visible'), width: getComputedStyle(element).outlineWidth, color: getComputedStyle(element).outlineColor }));
      assert.ok(focus.visible && focus.width === '2px' && focus.color !== 'rgba(0, 0, 0, 0)', 'Directory links have a visible keyboard outline');
      await page.getByRole('region', { name: '本学期教师', exact: true }).getByRole('button', { name: '周明远', exact: true }).click();
      await expect(page.getByRole('link', { name: /周明远/u })).toBeVisible();
      assert.equal(state.teacherCalls.at(-1).college, null, 'Semester shortcut searches the whole school');
      await page.getByLabel('全校姓名搜索', { exact: true }).fill('李怀墨');
      await expect(teacherLink).toBeVisible();
      assert.equal(state.teacherCalls.at(-1).college, null);

      await page.goto(`${base.origin}${teacherPath}`);
      const body = page.getByText(firstReview.body, { exact: true });
      await expect(body).toBeVisible();
      await expect(page.getByRole('heading', { name: teacher.displayName, exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: teacher.collegeName, exact: true })).toBeVisible();
      await expectVisuallyHidden(page.getByRole('heading', { name: '学生评价', exact: true }));
      await expectVisuallyHidden(page.getByRole('heading', { name: '写评价', exact: true }));
      await expect(page.locator('a[href="#teacher-contribution"]')).toHaveCount(0);
      const contribution = page.locator('#teacher-contribution');
      assert.equal(await contribution.evaluate((element) => Boolean(document.querySelector('[aria-labelledby="teacher-reviews-title"] article')?.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'Composer follows historical review entries');
      const firstBox = await body.boundingBox();
      assert.ok(firstBox && firstBox.y >= 0 && firstBox.y + Math.min(firstBox.height, 32) < 844, 'Historical review body starts on the first screen');
      const textbooks = page.getByRole('heading', { name: '教材', exact: true, includeHidden: true });
      await expect(textbooks).toBeHidden();
      await expect(page.getByRole('searchbox')).toHaveCount(0);
      await expect(page.getByRole('radio')).toHaveCount(0);
      await expect(page.getByText(/五项教学维度|五项评分|五维/u)).toHaveCount(0);
      await expect(page.getByRole('group', { name: '评价排序方式' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: '登录后写评价', exact: true })).toBeVisible();
      const entry = page.locator('article').filter({ hasText: firstReview.body });
      await expect(entry.getByText('历史评价', { exact: true })).toBeVisible();
      assert.equal(await entry.getByText('历史评价', { exact: true }).evaluate((element) => element.tagName), 'SMALL');
      await expect(entry.locator('time, b, img')).toHaveCount(0);
      await expect(page.getByText(/学长学姐|站内公开于|展开讨论|参与讨论/u)).toHaveCount(0);
      await expect(entry.getByRole('button', { name: '回复', exact: true })).toBeVisible();
      assert.equal(state.commentCalls, 0, 'Replies are still fetched only on demand');
      const currentEntry = page.locator('article').filter({ hasText: currentReview.body });
      await expect(currentEntry.getByText(currentReview.authorLabel, { exact: true })).toBeVisible();
      await expect(currentEntry.locator('time')).toHaveAttribute('datetime', currentReview.publishedAt);
      await expect(currentEntry.locator('time')).toHaveText('2026/10/1');
      assert.ok(await entry.locator('small').evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 12));
      assert.ok(await currentEntry.locator('time').evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 12));
      assert.equal(await body.evaluate((element) => getComputedStyle(element).fontSize), '16px');
      await noOverflow(page);
      await page.screenshot({ path: path.join(screenshots, `reading-${width}.png`), fullPage: true });
      assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, [], 'Review stream passes axe');

      const teachingToggle = page.locator('summary').filter({ hasText: '课程与教材' });
      await teachingToggle.focus();
      await page.keyboard.press('Enter');
      await expect(textbooks).toBeVisible();
      await expect(body).toBeVisible();
      await expect(page.getByText('第 3 版', { exact: true })).toBeVisible();
      await noOverflow(page);
      assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, [], 'Expanded secondary teaching information passes axe');
      await teachingToggle.click();
      await expect(body).toBeVisible();
      await expect(textbooks).toBeHidden();

      await page.goto(`${base.origin}${teacherPath}?panel=teaching`);
      await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
      const legacyPanelBox = await body.boundingBox();
      assert.ok(legacyPanelBox && legacyPanelBox.y >= 0 && legacyPanelBox.y < 600, 'Old panel=teaching does not hide or push the review stream out of view');

      await page.goto(`${base.origin}${teacherPath}?reviewQuery=${encodeURIComponent('无匹配')}&reviewSort=relevant`);
      await expect(page.getByText('没有找到包含“无匹配”的公开评价。', { exact: true })).toBeVisible();
      await expect(page.getByText('还没有公开评价。', { exact: true })).toHaveCount(0);
      assert.equal(state.calls.at(-1).query, '无匹配');
      await page.getByRole('button', { name: '查看全部评价', exact: true }).click();
      await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
      assert.equal(state.calls.at(-1).query, null);
      assert.equal(state.calls.at(-1).sort, 'latest');
      assert.equal(new URL(page.url()).search, '');
      await expect(page.getByRole('button', { name: '查看全部评价', exact: true })).toHaveCount(0);
      await noOverflow(page);
    });
  }

  await withPage(390, 'directory-retry', async (page, state) => {
    await page.goto(`${base.origin}/teachers?college=${encodeURIComponent('会计学院')}`);
    await expect(page.getByRole('link', { name: /李怀墨/u })).toBeVisible();
    await page.getByRole('button', { name: '继续查看教师', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新读取更多教师', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /李怀墨/u })).toBeVisible();
    await page.getByRole('button', { name: '重新读取更多教师', exact: true }).click();
    await expect(page.getByRole('link', { name: /同学院第二页教师/u })).toBeVisible();
    await expect(page.getByRole('link', { name: /李怀墨/u })).toHaveCount(1);
    assert.equal(state.teacherCalls.filter((call) => call.after).length, 2);
  });

  await withPage(390, 'directory-race', async (page, state) => {
    await page.goto(`${base.origin}/teachers?college=${encodeURIComponent('会计学院')}`);
    const more = page.getByRole('button', { name: '继续查看教师', exact: true });
    await expect(more).toBeVisible();
    await more.evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.teacherCalls.filter((call) => call.after).length).toBe(1);
    await page.getByLabel('学院', { exact: true }).selectOption('国际经济贸易学院');
    await expect(page.getByRole('link', { name: /周明远/u })).toBeVisible();
    await expect(page.getByRole('link', { name: /李怀墨/u })).toHaveCount(0);
    await page.getByRole('button', { name: '继续查看教师', exact: true }).click();
    await expect.poll(() => state.teacherCalls.filter((call) => call.after).length).toBe(2);
    const staleResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/teachers' && new URL(response.url()).searchParams.get('after') === '会计学院-next');
    state.oldRelease.resolve();
    await (await staleResponse).finished();
    await afterPaint(page);
    await expect(page.getByRole('link', { name: /迟到的旧学院教师/u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '正在继续读取', exact: true })).toBeDisabled();
    state.freshRelease.resolve();
    await expect(page.getByRole('link', { name: /新学院第二页教师/u })).toBeVisible();
    await expect(page.getByRole('link', { name: /迟到的旧学院教师/u })).toHaveCount(0);
    await noOverflow(page);
  });

  await withPage(390, 'composer', async (page, state) => {
    await page.goto(`${base.origin}${teacherPath}#teacher-reviews-title`);
    const body = page.getByText(firstReview.body, { exact: true });
    await expect(body).toBeVisible();
    const contribution = page.locator('#teacher-contribution');
    const input = contribution.getByLabel(/评价正文/u);
    await expect(input).toBeVisible();
    await expectVisuallyHidden(contribution.getByText('评价正文', { exact: true }));
    assert.ok(await contribution.evaluate((element) => Boolean(document.querySelector('[aria-labelledby="teacher-reviews-title"] article')?.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)), 'New-review form follows historical content without expanding anything');
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, [], 'Text-only composer passes axe');
    await expect(contribution.getByRole('textbox')).toHaveCount(1);
    await expect(contribution.getByRole('radio')).toHaveCount(0);
    await expect(input).toHaveAttribute('minlength', '1');
    await input.fill('　 ');
    await contribution.getByRole('button', { name: '发布', exact: true }).click();
    await expect(contribution.getByText('请写下评价内容。')).toBeVisible();
    assert.equal(state.writes.length, 0, 'Whitespace-only review never reaches the API');
    const reviewBody = '好';
    await input.fill(reviewBody);
    await contribution.getByRole('button', { name: '发布', exact: true }).click();
    await expect(page.getByText(reviewBody, { exact: true })).toBeVisible();
    await expect(contribution.getByRole('button', { name: '修改我的评价', exact: true })).toBeVisible();
    assert.deepEqual(state.writes[0].input, { body: reviewBody }, 'Create sends only the body, without invented ratings');
    assert.equal(state.ownReview.ratings, null);
    await contribution.getByRole('button', { name: '修改我的评价', exact: true }).click();
    await input.fill(`${reviewBody}补充：资料与进度一致。`);
    await contribution.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByText(`${reviewBody}补充：资料与进度一致。`, { exact: true })).toBeVisible();
    assert.deepEqual(state.writes[1].input, { body: `${reviewBody}补充：资料与进度一致。`, expectedVersion: 1 });
    await contribution.getByRole('button', { name: '修改我的评价', exact: true }).click();
    await contribution.getByRole('button', { name: '删除我的评价', exact: true }).click();
    await expect(contribution.getByRole('button', { name: '确认删除', exact: true })).toBeVisible();
    await contribution.getByRole('button', { name: '确认删除', exact: true }).click();
    await expectVisuallyHidden(contribution.getByRole('heading', { name: '写评价', exact: true }));
    await expect(input).toHaveValue('');
    assert.equal(state.writes[2].input.version, 2);
    assert.deepEqual(state.writes.map((write) => write.method), ['PUT', 'PUT', 'DELETE']);
    const history = page.locator('article').filter({ hasText: firstReview.body });
    const replyToggle = history.getByRole('button', { name: '回复', exact: true });
    await replyToggle.focus();
    await page.keyboard.press('Enter');
    // A wrapping label's text can include React's textarea defaultValue after editing.
    // Match the accessible textbox name, which remains independent of its current value.
    const replyInput = history.getByRole('textbox', { name: '回复正文', exact: true });
    await expect(replyInput).toBeVisible();
    await expect(history.getByRole('button', { name: '收起', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expectVisuallyHidden(history.getByText('回复正文', { exact: true }));
    await replyInput.fill('补充一条课堂体验');
    await history.getByRole('button', { name: '发布回复', exact: true }).click();
    const reply = history.locator('ol > li');
    await expect(reply.getByText('补充一条课堂体验', { exact: true })).toBeVisible();
    await expect(reply.getByText('回复用户', { exact: true })).toBeVisible();
    await expect(reply.locator('time')).toHaveAttribute('datetime', '2026-10-01T04:00:00.000Z');
    await reply.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(replyInput).toHaveValue('补充一条课堂体验');
    await replyInput.fill('修改后的课堂体验');
    await history.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(reply.getByText('修改后的课堂体验', { exact: true })).toBeVisible();
    await history.getByRole('button', { name: '收起', exact: true }).click();
    await expect(replyInput).toHaveCount(0);
    await replyToggle.click();
    await expect(reply.getByText('修改后的课堂体验', { exact: true })).toBeVisible();
    assert.equal(state.commentCalls, 1, 'Folding preserves the loaded replies');
    page.once('dialog', (dialog) => void dialog.accept());
    await reply.getByRole('button', { name: '删除', exact: true }).click();
    await expect(reply.getByText('这条回复已不可见，讨论位置仍被保留。', { exact: true })).toBeVisible();
    assert.deepEqual(state.replyWrites, [
      { method: 'POST', input: { body: '补充一条课堂体验', replyToCommentId: null } },
      { method: 'PATCH', input: { body: '修改后的课堂体验', version: 1 } },
      { method: 'DELETE', input: { version: 2 } },
    ]);
    await history.getByRole('button', { name: '举报评价', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, [], 'Expanded reply composer and tombstones pass axe');
    await noOverflow(page);
    await page.screenshot({ path: path.join(screenshots, 'composer-390.png'), fullPage: true });
  });

  await withPage(390, 'old-review', async (page, state) => {
    await page.goto(`${base.origin}${teacherPath}`);
    await expect(page.getByText(previousOwnReview.body, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '修改我的评价', exact: true }).click();
    const input = page.getByLabel(/评价正文/u);
    await expect(input).toHaveValue(previousOwnReview.body);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await input.fill('补充一句。');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByText('补充一句。', { exact: true })).toBeVisible();
    assert.deepEqual(state.writes[0].input, { body: '补充一句。', expectedVersion: 7 });
    assert.deepEqual(state.ownReview.ratings, historicalRatings, 'Editing old rated reviews neither invents nor replaces historical ratings');
  });

  await withPage(390, 'hidden-review', async (page, state) => {
    await page.goto(`${base.origin}${teacherPath}`);
    const contribution = page.locator('#teacher-contribution');
    await expect(contribution.getByText('评价已隐藏，审核期间不可修改，仍可删除。', { exact: true })).toBeVisible();
    await expect(contribution.getByRole('textbox')).toHaveCount(0);
    await expect(contribution.getByRole('button', { name: '修改我的评价', exact: true })).toHaveCount(0);
    await expect(page.getByText(previousOwnReview.body, { exact: true })).toHaveCount(0);
    await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
    await contribution.getByRole('button', { name: '删除我的评价', exact: true }).click();
    await contribution.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(state.writes.length, 0, 'Delete confirmation can be cancelled');
    await contribution.getByRole('button', { name: '删除我的评价', exact: true }).click();
    await contribution.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(contribution.getByLabel(/评价正文/u)).toHaveValue('');
    assert.deepEqual(state.writes, [{ method: 'DELETE', input: { version: 7 } }]);
  });

  await withPage(390, 'conflict', async (page, state) => {
    await page.goto(`${base.origin}${teacherPath}`);
    await page.getByRole('button', { name: '修改我的评价', exact: true }).click();
    const input = page.getByLabel(/评价正文/u);
    await input.fill('本地修改');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByText('这份评价已经在另一处更新。页面将读取最新版本，请核对后再保存。', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('另一处已更新的评价正文。');
    assert.equal(state.writes.length, 1, 'Conflict never automatically resubmits or overwrites the newer version');
    await input.fill('核对后修改');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByText('核对后修改', { exact: true })).toBeVisible();
    assert.deepEqual(state.writes[1].input, { body: '核对后修改', expectedVersion: 8 });
  });

  await withPage(390, 'expired-session', async (page, state) => {
    await page.goto(`${base.origin}${teacherPath}`);
    await page.getByLabel(/评价正文/u).fill('课堂体验');
    await page.getByRole('button', { name: '发布', exact: true }).click();
    await expect(page.getByText('登录状态已失效，请重新登录后再提交。', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '登录后写评价', exact: true })).toBeVisible();
    await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
    assert.equal(state.writes.length, 1);
  });

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
    await page.goto(`${base.origin}${teacherPath}?reviewSort=discussed`);
    const more = page.getByRole('button', { name: '继续查看评价', exact: true });
    await expect(more).toBeVisible();
    await more.evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.calls.filter((call) => call.after && call.sort === 'discussed').length).toBe(1);
    await expect(page.getByRole('button', { name: '正在读取…', exact: true })).toBeDisabled();
    assert.equal(state.calls.filter((call) => call.after).length, 1, 'Concurrent clicks do not request the same page twice');
    await page.getByRole('button', { name: '查看全部评价', exact: true }).click();
    await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
    await expect(page.getByText(discussedReview.body, { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '继续查看评价', exact: true }).click();
    await expect.poll(() => state.calls.filter((call) => call.after && call.sort === 'latest').length).toBe(1);
    const staleResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === reviewPath && url.searchParams.get('after') === 'discussed-page-2';
    });
    state.oldRelease.resolve();
    await (await staleResponse).finished();
    await afterPaint(page);
    await expect(page.getByText(staleReview.body, { exact: true })).toHaveCount(0);
    await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '正在读取…', exact: true })).toBeDisabled();
    state.freshRelease.resolve();
    await expect(page.getByText(secondReview.body, { exact: true })).toBeVisible();
    await expect(page.getByText(staleReview.body, { exact: true })).toHaveCount(0);
    assert.equal(state.calls.filter((call) => call.after).length, 2, 'Only one page request per sort is sent');
    await expect(page.getByRole('button', { name: '继续查看评价', exact: true })).toHaveCount(0);
    await noOverflow(page);
  });
  await withPage(390, 'textbook-links', async (page) => {
    await page.goto(`${base.origin}${teacherPath}?panel=teaching&course=LOCAL001`);
    await expect(page.getByRole('heading', { name: '本地验收教材', exact: true })).toBeVisible();
    await expect(page.getByText('第 3 版', { exact: true })).toBeVisible();
    await expect(page.getByText(firstReview.body, { exact: true })).toBeVisible();
    const textbookBox = await page.getByRole('heading', { name: '本地验收教材', exact: true }).boundingBox();
    assert.ok(textbookBox && textbookBox.y >= 0 && textbookBox.y < 844, 'Legacy course link locates its textbook in the expanded secondary information');
    await page.goto(`${base.origin}${teacherPath}?panel=teaching&course=OTHER`);
    await expect(page.getByText('该课程暂未记录教材。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '本地验收教材', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '查看全部教材' }).click();
    await expect(page.getByRole('heading', { name: '本地验收教材', exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.has('course'), false);
    await noOverflow(page);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
  const screenshots = await mkdtemp(path.join(tmpdir(), 'teacher-reading-'));
  try {
    await runTeacherReadingChecks({ browser, baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000', screenshots });
    console.log(JSON.stringify({ screenshots }));
  } finally {
    await browser.close();
  }
}
