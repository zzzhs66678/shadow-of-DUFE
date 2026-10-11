import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { CommunityAuthor, CommunityComment, CommunityTopic } from "../../app/community/community-api";

test("two momo authors retain distinct profiles, mentions and ownership", async ({ page, baseURL }, testInfo) => {
  const origin = new URL(baseURL!);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(origin.hostname);
  const now = new Date().toISOString();
  const first: CommunityAuthor = { id: "00000000-0000-4000-8000-000000009301", username: "momo_a", displayName: "momo", nameMode: "momo", avatarUrl: null };
  // Compatibility with the previous projection: the mode field may be absent.
  const second: CommunityAuthor = { id: "00000000-0000-4000-8000-000000009302", username: "momo_b", displayName: "momo", avatarUrl: null };
  const named: CommunityAuthor = { id: "00000000-0000-4000-8000-000000009303", username: "momo", displayName: "自己的名字", nameMode: "name", avatarUrl: null };
  const topic = (author: CommunityAuthor, suffix: string): CommunityTopic => ({ id: `00000000-0000-4000-8000-00000000931${suffix}`, title: `同名昵称的帖子${suffix}`, body: `作者身份由UUID区分${suffix}`, status: "published", visibility: "public", version: 1, author, likeCount: 0, commentCount: 2, liked: false, bookmarked: false, createdAt: now, updatedAt: now, editedAt: null });
  const topics = [topic(first, "1"), topic(second, "2"), topic(named, "3")];
  const comments: CommunityComment[] = [first, second].map((author, index) => ({ id: `00000000-0000-4000-8000-00000000932${index}`, topicId: topics[1].id, parentCommentId: null, rootCommentId: null, replyToUserId: null, body: index === 0 ? "甲的回复" : "乙的回复", status: "published", version: 1, author, likeCount: 0, liked: false, createdAt: now, updatedAt: now, editedAt: null }));
  const writes: { path: string; body: Record<string, unknown>; owner: string | undefined }[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === "https://dufesh.cn/favicon.svg") { await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" />' }); return; }
    if (url.origin !== origin.origin) { await route.abort("blockedbyclient"); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    let payload: unknown = { items: [], nextCursor: null };
    if (url.pathname === "/api/auth/session") payload = { authenticated: true, user: { ...first, role: "user" } };
    if (url.pathname.endsWith("/unread-count")) payload = { unread: 0 };
    if (url.pathname === "/api/community/topics") payload = { items: topics, nextCursor: null };
    if (url.pathname === `/api/community/topics/${topics[1].id}`) payload = { topic: topics[1] };
    if (url.pathname === `/api/community/topics/${topics[1].id}/comments`) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        writes.push({ path: url.pathname, body, owner: request.headers()["x-community-owner"] });
        const created = { ...comments[0], id: "00000000-0000-4000-8000-000000009329", body: body.body };
        comments.push(created);
        payload = { comment: created };
      } else payload = { items: comments, nextCursor: null };
    }
    if (url.pathname.startsWith("/api/community/users/")) {
      const author = [first, second, named].find(item => url.pathname === `/api/community/users/${item.id}`)!;
      payload = { profile: { ...author, joinedAt: now, topicCount: 1, commentCount: 1 }, kind: "topics", items: topics.filter(item => item.author?.id === author.id), nextCursor: null };
    }
    await route.fulfill({ json: payload });
  });
  await page.goto("/community");
  for (const author of [first, second]) {
    const link = page.locator(`a[href="/community/users/${author.id}"]`).filter({ hasText: `@${author.username}` }).first();
    await expect(link).toContainText(`@${author.username}`);
    await expect(link.getByRole("img", { name: "momo 小猫标志", exact: true })).toBeVisible();
  }
  await expect(page.locator(`a[href="/community/users/${named.id}"]`).getByRole("img", { name: "momo 小猫标志", exact: true })).toHaveCount(0);
  await page.locator(`a[href="/community/users/${second.id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(second.id));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("momo");
  await expect(page.getByText(/@momo_b.*加入/)).toBeVisible();
  await expect(page.getByText(topics[1].title, { exact: true })).toBeVisible();
  await expect(page.getByText(topics[0].title, { exact: true })).toHaveCount(0);
  await page.goto(`/community/topics/${topics[1].id}`);
  const own = page.locator("article").filter({ has: page.getByText("甲的回复", { exact: true }) });
  const peer = page.locator("article").filter({ has: page.getByText("乙的回复", { exact: true }) });
  await own.getByLabel("回复更多操作", { exact: true }).click();
  await expect(own.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await own.getByLabel("回复更多操作", { exact: true }).click();
  await peer.getByLabel("回复更多操作", { exact: true }).click();
  await expect(peer.getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
  await expect(peer.getByRole("button", { name: "举报回复", exact: true })).toBeVisible();
  await peer.getByLabel("回复更多操作", { exact: true }).click();
  await page.getByLabel("说说你的想法", { exact: true }).fill("给 @momo_b 的合成回复");
  await page.locator("form").filter({ has: page.getByLabel("说说你的想法", { exact: true }) }).getByRole("button", { name: "回复", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].owner).toBe(first.id);
  expect(writes[0].body.body).toBe("给 @momo_b 的合成回复");
  expect(writes[0].body).not.toHaveProperty("userId");
  expect(writes[0].body).not.toHaveProperty("authorId");
  await expect(page.getByText("给 @momo_b 的合成回复", { exact: true })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("momo-authors.png"), fullPage: true });
  expect(errors).toEqual([]);
});
