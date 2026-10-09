import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page, type TestInfo } from "@playwright/test";
import type { CommunityAuthor, CommunityComment, CommunityTopic } from "../../app/community/community-api";

// No build or server lifecycle in this test. Against the already-running preview:
// $env:WALL_BASE_URL='http://localhost:3107'
// npx playwright test --config=tests/e2e wall.accessibility.spec.ts --workers=1 --output=test-results/wall
// Using the directory config above deliberately bypasses the root config's build.
const baseURL = process.env.WALL_BASE_URL ?? process.env.PLAYWRIGHT_BASE_URL ??
  (process.env.CI ? "http://localhost:3000" : "http://localhost:3107");
const now = "2026-10-09T04:00:00.000Z";
const ids = {
  me: "00000000-0000-4000-8000-000000009101",
  peer: "00000000-0000-4000-8000-000000009102",
  latest: "00000000-0000-4000-8000-000000009111",
  replied: "00000000-0000-4000-8000-000000009112",
  short: "00000000-0000-4000-8000-000000009113",
  published: "00000000-0000-4000-8000-000000009114",
  root: "00000000-0000-4000-8000-000000009121",
  child: "00000000-0000-4000-8000-000000009122",
  reply: "00000000-0000-4000-8000-000000009123",
};
const me: CommunityAuthor = { id: ids.me, username: "wall_fixture_a", displayName: "测试同学甲", avatarUrl: null };
const peer: CommunityAuthor = { id: ids.peer, username: "wall_fixture_b", displayName: "测试同学乙", avatarUrl: null };
const draftKey = `dufe:wall-draft:${ids.me}`;
type Mutation = { method: string; path: string; body: Record<string, unknown> };
type WallFixture = {
  topics: Map<string, CommunityTopic>;
  comments: Map<string, CommunityComment[]>;
  mutations: Mutation[];
  feedRequests: string[];
  currentUser: CommunityAuthor;
  postOwners: string[];
  stalePagination: "off" | "first-page" | "expired";
  failPosts: number;
  failReplies: number;
};

function topic(id: string, title: string, body: string, createdAt: string, author = peer): CommunityTopic {
  return { id, title, body, author, createdAt, updatedAt: createdAt, editedAt: null,
    status: "published", visibility: "public", version: 1, liked: false, bookmarked: false,
    likeCount: 2, commentCount: 0, lastReplyAt: null };
}

function comment(id: string, body: string, parentCommentId: string | null = null): CommunityComment {
  return { id, topicId: ids.replied, parentCommentId, rootCommentId: parentCommentId,
    replyToUserId: parentCommentId ? peer.id : null, body, status: "published", version: 1,
    author: parentCommentId ? me : peer, liked: false, likeCount: 0,
    createdAt: "2026-10-09T03:00:00.000Z", updatedAt: "2026-10-09T03:00:00.000Z", editedAt: null };
}

const test = base.extend<{ wall: WallFixture }>({
  wall: async ({ page, context }, run) => {
    const origin = new URL(baseURL);
    // Never run this mock-write workflow against staging, production or another host.
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(origin.hostname);
    const latest = topic(ids.latest, "合成样例：刚发布的课程交流", "这是一条用于界面回归的合成帖子，不是真实同学发布的数据。", "2026-10-09T02:00:00.000Z");
    const replied = topic(ids.replied, "合成样例：较早发布但刚有回复", [
      "这条合成讨论用于验证按最新回复排序，发布时间保持不变。",
      "多行正文应自然换行，窄屏不应截断操作按钮或遮挡作者。",
      `长字符串换行：${"wall-fixture-layout-".repeat(12)}`,
      ...Array.from({ length: 5 }, (_, index) => `合成段落 ${index + 1}：用于检查展开全文及详情阅读。`),
    ].join("\n"), "2026-10-07T02:00:00.000Z");
    replied.lastReplyAt = "2026-10-09T03:30:00.000Z";
    replied.commentCount = 2;
    const short = topic(ids.short, "你好", "你好", "2026-10-06T02:00:00.000Z", me);
    const wall: WallFixture = {
      topics: new Map([latest, replied, short].map((item) => [item.id, item])),
      comments: new Map([[ids.replied, [comment(ids.root, "合成根回复：欢迎补充你的想法。"), comment(ids.child, "合成二层回复：这不是线上内容。", ids.root)]]]),
      mutations: [], feedRequests: [], currentUser: me, postOwners: [], stalePagination: "off", failPosts: 0, failReplies: 0,
    };
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.setFixedTime(new Date(now));
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const reply = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { "Cache-Control": "no-store" } });
      // Shared page metadata uses a production-absolute icon URL. Fulfill it
      // synthetically as well: never contact production, even for the favicon.
      if (method === "GET" && url.href === "https://dufesh.cn/favicon.svg") {
        await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" />' });
        return;
      }
      if (url.origin !== origin.origin) {
        unexpected.push(`${method} external:${url.origin}${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        if (["GET", "HEAD"].includes(method)) await route.continue();
        else { unexpected.push(`${method} ${url.pathname}`); await reply({ error: "fixture_unhandled_write" }, 501); }
        return;
      }
      // Every API request is fulfilled here. Unknown routes never hit a real backend.
      if (method === "GET" && url.pathname === "/api/auth/session") {
        await reply({ authenticated: true, user: wall.currentUser }); return;
      }
      if (method === "GET" && url.pathname === "/api/community/notifications/unread-count") {
        await reply({ unread: 0 }); return;
      }
      if (url.pathname === "/api/community/topics" && method === "GET") {
        const sort = url.searchParams.get("sort");
        wall.feedRequests.push(url.search);
        if (!["latest", "replied"].includes(sort ?? "")) {
          unexpected.push(`unsupported feed sort:${sort}`);
          await reply({ error: "invalid_fixture_sort" }, 400); return;
        }
        if (wall.stalePagination === "first-page") {
          if (url.searchParams.has("cursor")) {
            expect(url.searchParams.get("cursor")).toBe("fixture-reply-version-1");
            wall.stalePagination = "expired";
            // The prior page is no longer authoritative. A refresh must replace,
            // rather than append to, its now-unavailable record.
            wall.topics.delete(ids.replied);
            wall.topics.get(ids.latest)!.lastReplyAt = now;
            await reply({ error: "community_cursor_stale" }, 409); return;
          }
          await reply({ items: [wall.topics.get(ids.replied)], nextCursor: "fixture-reply-version-1" }); return;
        }
        const items = [...wall.topics.values()].filter((item) => item.visibility === "public").sort((left, right) => {
          const leftAt = sort === "replied" ? left.lastReplyAt ?? left.createdAt : left.createdAt;
          const rightAt = sort === "replied" ? right.lastReplyAt ?? right.createdAt : right.createdAt;
          return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id);
        });
        await reply({ items, nextCursor: null }); return;
      }
      if (url.pathname === "/api/community/topics" && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        wall.mutations.push({ method, path: url.pathname, body });
        const owner = request.headers()["x-community-owner"];
        wall.postOwners.push(owner ?? "");
        // Match the optional backend precondition: the header cannot select the
        // author, and a stale tab must not publish its draft as the new account.
        if (owner !== undefined && owner !== wall.currentUser.id) {
          await reply({ error: "community_account_changed" }, 409); return;
        }
        if (wall.failPosts > 0) { wall.failPosts--; await reply({ error: "community_write_rate_limited" }, 429); return; }
        const title = String(body.title ?? "").normalize("NFKC").trim();
        if (title && Array.from(title).length < 4) {
          await reply({ error: "invalid_community_body" }, 400); return;
        }
        const created = topic(ids.published, title || String(body.body).slice(0, 48), String(body.body), now, wall.currentUser);
        created.visibility = body.visibility === "unlisted" ? "unlisted" : "public";
        wall.topics.set(created.id, created);
        await reply({ topic: created }, 201); return;
      }
      const detail = url.pathname.match(/^\/api\/community\/topics\/([0-9a-f-]{36})$/);
      if (detail && ["GET", "PATCH"].includes(method)) {
        const current = wall.topics.get(detail[1]);
        if (!current) { await reply({ error: "community_topic_unavailable" }, 404); return; }
        if (method === "PATCH") {
          const body = request.postDataJSON() as Record<string, unknown>;
          wall.mutations.push({ method, path: url.pathname, body });
          if (body.version !== current.version) { await reply({ error: "community_version_conflict" }, 409); return; }
          // Match the real partial-update contract: an explicitly supplied title
          // must meet the new-title minimum; an unchanged legacy short title must be omitted.
          if (Object.hasOwn(body, "title") && Array.from(String(body.title).normalize("NFKC").trim()).length < 4) {
            await reply({ error: "invalid_community_topic" }, 400); return;
          }
          Object.assign(current, { body: String(body.body), version: current.version + 1, updatedAt: now, editedAt: now },
            Object.hasOwn(body, "title") ? { title: String(body.title) } : {});
        }
        await reply({ topic: current }); return;
      }
      const replies = url.pathname.match(/^\/api\/community\/topics\/([0-9a-f-]{36})\/comments$/);
      if (replies && ["GET", "POST"].includes(method)) {
        if (method === "GET") { await reply({ items: wall.comments.get(replies[1]) ?? [], nextCursor: null }); return; }
        const body = request.postDataJSON() as Record<string, unknown>;
        wall.mutations.push({ method, path: url.pathname, body });
        if (wall.failReplies > 0) { wall.failReplies--; await reply({ error: "service_unavailable" }, 503); return; }
        const items = wall.comments.get(replies[1]) ?? [];
        const target = items.find((item) => item.id === body.replyToCommentId);
        const rootId = target ? target.rootCommentId ?? target.id : null;
        const created = { ...comment(ids.reply, String(body.body), rootId), topicId: replies[1], author: me, createdAt: now, updatedAt: now };
        wall.comments.set(replies[1], [...items, created]);
        const current = wall.topics.get(replies[1]);
        if (current) { current.commentCount++; current.lastReplyAt = now; }
        await reply({ comment: created }, 201); return;
      }
      unexpected.push(`${method} ${url.pathname}${url.search}`);
      await reply({ error: "fixture_unhandled_api" }, 501);
    });
    await run(wall);
    expect(unexpected, "All API writes must stay inside the synthetic fixture").toEqual([]);
    expect(errors, "No browser script errors").toEqual([]);
  },
});

test.use({ baseURL, channel: process.env.CI ? undefined : "chrome", serviceWorkers: "block", timezoneId: "Asia/Shanghai" });
test.setTimeout(60_000);

async function reloadKeepingDraft(page: Page) {
  // Reload deliberately leaves this document. Accept only beforeunload, while
  // the test below verifies that the account-scoped draft survives navigation.
  const acceptReload = async (dialog: import("@playwright/test").Dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.accept();
  };
  page.once("dialog", acceptReload);
  try { await page.reload(); }
  finally { page.off("dialog", acceptReload); }
}

async function auditAndCapture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const viewport = page.viewportSize()!;
  const size = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(size.document, `document overflow in ${name}`).toBeLessThanOrEqual(size.width + 1);
  expect(size.body, `body overflow in ${name}`).toBeLessThanOrEqual(size.width + 1);
  const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? "")), `axe in ${name}`).toEqual([]);
  const path = testInfo.outputPath(`${name}-${viewport.width}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const width of [320, 390, 760, 1280]) {
  test.describe(`东财墙 ${width}px`, () => {
    test.use({ viewport: { width, height: width < 600 ? 844 : 900 } });

    test("最新发布／最新回复、刷新和详情返回保留 URL 排序", async ({ page, wall }, testInfo) => {
      await page.goto("/community");
      await expect(page.getByRole("heading", { level: 1, name: "东财墙", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "帖子正文", exact: true })).toBeEnabled();
      const latest = page.getByRole("list", { name: "最新发布的帖子", exact: true });
      const replied = page.getByRole("list", { name: "最新回复的帖子", exact: true });
      await expect(latest.locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.latest}`);
      await expect(page.getByRole("button", { name: "最新发布", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("list").filter({ hasText: "合成样例" })).toHaveCount(1);
      await auditAndCapture(page, testInfo, "feed-latest");

      await page.getByRole("button", { name: "最新回复", exact: true }).click();
      await expect(page).toHaveURL(/\/community\?sort=replied$/);
      await expect(replied.locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.replied}`);
      await expect(replied.locator(":scope > li").first()).toContainText("最近回复");
      await page.reload();
      await expect(page.getByRole("button", { name: "最新回复", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(replied.locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.replied}`);
      const first = replied.locator(":scope > li").first();
      await first.getByRole("link", { name: /^查看测试同学乙的帖子/ }).click();
      await expect(page).toHaveURL(new RegExp(`/community/topics/${ids.replied}\\?from=replied$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(wall.topics.get(ids.replied)!.title);
      await expect(page.getByRole("link", { name: "返回东财墙", exact: true })).toHaveAttribute("href", "/community?sort=replied");
      await auditAndCapture(page, testInfo, "topic-long-body");
      await page.getByRole("link", { name: "返回东财墙", exact: true }).click();
      await expect(page).toHaveURL(/\/community\?sort=replied$/);
      await expect(replied.locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.replied}`);

      await page.getByRole("button", { name: "最新发布", exact: true }).click();
      await expect(latest.locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.latest}`);
      await page.goBack();
      await expect(page.getByRole("button", { name: "最新回复", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(replied.locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.replied}`);
      await page.goForward();
      await expect(page.getByRole("button", { name: "最新发布", exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(wall.feedRequests.some((query) => new URLSearchParams(query).get("sort") === "latest")).toBe(true);
      expect(wall.feedRequests.some((query) => new URLSearchParams(query).get("sort") === "replied")).toBe(true);
      expect(wall.mutations).toEqual([]);
    });

    test("纯正文发帖失败保留草稿，刷新恢复，成功才清除", async ({ page, wall }, testInfo) => {
      wall.failPosts = 1;
      await page.goto("/community?sort=replied");
      const composer = page.getByRole("form", { name: "发布帖子", exact: true });
      const body = composer.getByRole("textbox", { name: "帖子正文", exact: true });
      const text = "合成草稿：只填写正文，不填写标题。\n失败后这段文字应保留。";
      await expect(body).toBeEnabled();
      await expect(composer.locator("details")).not.toHaveAttribute("open", "");
      await body.fill(text);
      await composer.getByRole("combobox", { name: "可见范围", exact: true }).selectOption("unlisted");
      await composer.getByRole("button", { name: "发布", exact: true }).click();
      await expect(composer.getByRole("alert")).toContainText("操作有些频繁");
      await expect(body).toHaveValue(text);
      expect(wall.mutations).toHaveLength(1);
      expect(wall.mutations[0]).toMatchObject({ method: "POST", path: "/api/community/topics", body: { title: "", body: text, visibility: "unlisted" } });
      await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), draftKey)).toMatchObject({ title: "", body: text, visibility: "unlisted" });
      await auditAndCapture(page, testInfo, "composer-failed-draft");

      await reloadKeepingDraft(page);
      await expect(body).toHaveValue(text);
      await expect(composer.getByRole("combobox", { name: "可见范围", exact: true })).toHaveValue("unlisted");
      await composer.getByRole("button", { name: "发布", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/community/topics/${ids.published}\\?from=latest$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("帖子详情");
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect(page.getByText("仅链接可见", { exact: false })).toBeVisible();
      await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
      expect(wall.mutations).toHaveLength(2);
      expect(wall.mutations[1].body).toEqual(wall.mutations[0].body);
      await auditAndCapture(page, testInfo, "body-only-topic");
      await page.getByRole("link", { name: "返回东财墙", exact: true }).click();
      await expect(page).toHaveURL(/\/community$/);
      await expect(page.getByRole("textbox", { name: "帖子正文", exact: true })).toHaveValue("");
    });

    test("过期分页返回 409 后自动重取第一页且不混入旧列表", async ({ page, wall }, testInfo) => {
      wall.stalePagination = "first-page";
      await page.goto("/community?sort=replied");
      const stream = page.getByRole("list", { name: "最新回复的帖子", exact: true });
      await expect(stream.locator(":scope > li")).toHaveCount(1);
      await expect(stream.locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.replied}`);
      const expiredResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/community/topics" && url.searchParams.has("cursor");
      });
      await page.getByRole("button", { name: "更多帖子", exact: true }).click();
      expect((await expiredResponse).status()).toBe(409);
      await expect(page.getByText("帖子有更新，已刷新列表。", { exact: true })).toBeVisible();
      await expect(stream.locator(":scope > li")).toHaveCount(2);
      await expect(stream.locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.latest}`);
      await expect(page.locator(`#post-${ids.replied}`)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "更多帖子", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "最新回复", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page).toHaveURL(/\/community\?sort=replied$/);
      const queries = wall.feedRequests.map((query) => new URLSearchParams(query));
      const expiredIndex = queries.findIndex((query) => query.has("cursor"));
      expect(expiredIndex).toBeGreaterThanOrEqual(1);
      expect(queries.filter((query) => query.has("cursor"))).toHaveLength(1);
      expect(queries[expiredIndex + 1].has("cursor")).toBe(false);
      expect(queries[expiredIndex + 1].get("sort")).toBe("replied");
      expect(wall.mutations).toEqual([]);
      await auditAndCapture(page, testInfo, "stale-pagination-refreshed");
    });

    test("手动短标题按码点拒绝且不请求 API，四字标题可发布", async ({ page, wall }, testInfo) => {
      await page.goto("/community");
      const composer = page.getByRole("form", { name: "发布帖子", exact: true });
      const body = composer.getByRole("textbox", { name: "帖子正文", exact: true });
      await expect(body).toBeEnabled();
      const text = "合成正文：验证手动标题字数，不应把两个 emoji 当成四个字。";
      await body.fill(text);
      await composer.locator("summary").click();
      const title = composer.getByRole("textbox", { name: "帖子标题（选填）", exact: true });
      for (const invalid of ["短题", "短题目", "😀😀", "  短  "]) {
        await title.fill(invalid);
        await composer.getByRole("button", { name: "发布", exact: true }).click();
        await expect(composer.getByRole("alert")).toHaveText("标题至少写 4 个字，也可以留空。");
        await expect(title).toBeFocused();
        await expect(title).toHaveValue(invalid);
        await expect(body).toHaveValue(text);
        expect(wall.mutations).toEqual([]);
      }
      await auditAndCapture(page, testInfo, "manual-short-title-rejected");
      await title.fill("学习交流");
      await composer.getByRole("button", { name: "发布", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/community/topics/${ids.published}\\?from=latest$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("学习交流");
      expect(wall.mutations).toEqual([{ method: "POST", path: "/api/community/topics", body: { title: "学习交流", body: text, visibility: "public" } }]);
      expect(wall.postOwners).toEqual([ids.me]);
    });

    test("静默切换账号后旧草稿带原 owner 被 409 拒绝，新账号只读取自己的草稿", async ({ page, wall }, testInfo) => {
      await page.goto("/community");
      const composer = page.getByRole("form", { name: "发布帖子", exact: true });
      const body = composer.getByRole("textbox", { name: "帖子正文", exact: true });
      const oldDraft = "合成甲草稿：绝不能变成乙账号发布的帖子。";
      const newDraft = "合成乙草稿：只允许乙账号主动发布这一段。";
      const newDraftKey = `dufe:wall-draft:${ids.peer}`;
      await expect(body).toBeEnabled();
      await expect(composer.locator(`a[href="/community/users/${ids.me}"]`)).toBeVisible();
      await body.fill(oldDraft);
      await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null")?.body, draftKey)).toBe(oldDraft);
      await page.evaluate(({ key, body }) => sessionStorage.setItem(key, JSON.stringify({ title: "", body, visibility: "public" })), { key: newDraftKey, body: newDraft });

      // Simulate an HttpOnly-session switch in another tab without notifying this
      // document. Only the server session changes; the mounted composer is still A.
      wall.currentUser = peer;
      const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/community/topics" && response.request().method() === "POST");
      await composer.getByRole("button", { name: "发布", exact: true }).click();
      expect((await rejected).status()).toBe(409);
      await expect(composer.getByRole("alert")).toContainText("登录账号已变化");
      expect(wall.postOwners).toEqual([ids.me]);
      expect(wall.topics.has(ids.published)).toBe(false);
      expect(wall.mutations).toHaveLength(1);
      expect(wall.mutations[0].body.body).toBe(oldDraft);
      await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null")?.body, draftKey)).toBe(oldDraft);
      expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null")?.body, newDraftKey)).toBe(newDraft);
      await auditAndCapture(page, testInfo, "old-account-draft-rejected");

      await reloadKeepingDraft(page);
      await expect(composer.locator(`a[href="/community/users/${ids.peer}"]`)).toBeVisible();
      await expect(body).toHaveValue(newDraft);
      await expect(composer).not.toContainText(oldDraft);
      await composer.getByRole("button", { name: "发布", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/community/topics/${ids.published}\\?from=latest$`));
      await expect(page.getByText(newDraft, { exact: true })).toBeVisible();
      expect(wall.postOwners).toEqual([ids.me, ids.peer]);
      expect(wall.topics.get(ids.published)!.author!.id).toBe(ids.peer);
      expect(wall.topics.get(ids.published)!.body).toBe(newDraft);
      expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null")?.body, draftKey)).toBe(oldDraft);
      expect(await page.evaluate((key) => sessionStorage.getItem(key), newDraftKey)).toBeNull();
    });

    test("保留原短标题编辑正文，PATCH 必须省略 title", async ({ page, wall }, testInfo) => {
      await page.goto(`/community/topics/${ids.short}?from=replied`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("帖子详情");
      const menu = page.locator('summary[aria-label="帖子更多操作"]');
      await menu.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "编辑帖子", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
      await expect(page.getByRole("button", { name: "编辑帖子", exact: true })).not.toBeVisible();
      await menu.click();
      await page.getByRole("button", { name: "编辑帖子", exact: true }).click();
      const title = page.getByRole("textbox", { name: /^标题/ });
      const body = page.getByRole("textbox", { name: /^正文/ });
      const updated = "你好，这次只修改正文，原来的两个字标题保持不变。";
      await expect(title).toHaveValue("你好");
      await body.fill(updated);
      const save = page.getByRole("button", { name: "保存更改", exact: true });
      await expect(save).toBeEnabled();
      await auditAndCapture(page, testInfo, "edit-short-title");
      await save.click();
      await expect(page.getByText("帖子已更新。", { exact: true })).toBeVisible();
      await expect(page.getByText(updated, { exact: true })).toBeVisible();
      const patch = wall.mutations.find((item) => item.method === "PATCH");
      expect(patch).toEqual({ method: "PATCH", path: `/api/community/topics/${ids.short}`, body: { body: updated, visibility: "public", version: 1 } });
      expect(Object.hasOwn(patch!.body, "title")).toBe(false);
      expect(wall.topics.get(ids.short)!.title).toBe("你好");
      expect(wall.topics.get(ids.short)!.version).toBe(2);
      await page.reload();
      await expect(page.getByText(updated, { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "返回东财墙", exact: true })).toHaveAttribute("href", "/community?sort=replied");
    });

    test("指定回复失败保留内容，未发送时离开可取消，成功后返回原排序", async ({ page, wall }, testInfo) => {
      wall.failReplies = 1;
      await page.goto(`/community/topics/${ids.replied}?from=replied#discussion`);
      const thread = page.locator(`#community-thread-${ids.root}`);
      await thread.getByRole("button", { name: "回复", exact: true }).first().click();
      const replyBody = page.getByRole("textbox", { name: "回复 测试同学乙", exact: true });
      await expect(replyBody).toBeFocused();
      const text = "合成回复：提交失败后仍保留正文和回复对象。";
      await replyBody.fill(text);
      const before = page.url();
      let prompt = "";
      page.once("dialog", async (dialog) => { prompt = dialog.message(); await dialog.dismiss(); });
      await page.getByRole("link", { name: "返回东财墙", exact: true }).click();
      expect(prompt).toContain("还有没发出的内容");
      expect(page.url()).toBe(before);
      await expect(replyBody).toHaveValue(text);
      const submit = replyBody.locator("xpath=..").getByRole("button", { name: "回复", exact: true });
      await submit.click();
      await expect(page.getByText("请求没有完成。检查网络后再试一次。", { exact: true })).toBeVisible();
      await expect(replyBody).toHaveValue(text);
      await expect(page.getByRole("button", { name: "取消指定回复", exact: true })).toBeVisible();
      await auditAndCapture(page, testInfo, "reply-failed-draft");
      await submit.click();
      await expect(page.getByText("回复已发布。", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "说说你的想法", exact: true })).toHaveValue("");
      await expect(thread.getByText(text, { exact: true })).toBeVisible();
      expect(wall.mutations).toHaveLength(2);
      for (const mutation of wall.mutations) expect(mutation).toEqual({
        method: "POST", path: `/api/community/topics/${ids.replied}/comments`, body: { body: text, replyToCommentId: ids.root },
      });
      expect(wall.comments.get(ids.replied)!.at(-1)!.rootCommentId).toBe(ids.root);
      await page.getByRole("link", { name: "返回东财墙", exact: true }).click();
      await expect(page).toHaveURL(/\/community\?sort=replied$/);
      await expect(page.getByRole("list", { name: "最新回复的帖子", exact: true }).locator(":scope > li").first()).toHaveAttribute("id", `post-${ids.replied}`);
    });
  });
}
