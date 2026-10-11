import { test as base, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { whiteboardLecture } from "../fixtures/whiteboard.mjs";
import { savedState } from "../fixtures/hub-experience.mjs";
import { validateWhiteboardMutation } from "../../services/auth-api/src/whiteboard-contract.mjs";
import type { BoardCopy, WhiteboardEntry } from "../../app/whiteboard/client";

const NOW = "2026-10-10T10:00:00+08:00";
const OWNER = "20000000-0000-4000-8000-000000000001";
const lecture: WhiteboardEntry = { ...whiteboardLecture, kind: "event", status: "published" };
const note = (patch: Partial<WhiteboardEntry> = {}): WhiteboardEntry => ({
  id: "20000000-0000-4000-8000-000000000002", kind: "note", title: "", body: "今天也记得好好休息。",
  guest: "", guestBio: "", location: "", startsAt: null, endsAt: null, expiresAt: null,
  status: "published", version: 1, publishedAt: NOW, updatedAt: NOW, ...patch,
});
const archived = note({ id: "20000000-0000-4000-8000-000000000003", body: "已经结束的白板留言。", expiresAt: "2026-10-09T18:00:00+08:00" });
type Mutation = BoardCopy & { status: WhiteboardEntry["status"]; version?: number; mutationId: string };
type Write = { method: string; path: string; owner: string | undefined; body: Mutation };
type Failure = { status: number; error: string } | "lost-response";
type BoardMock = {
  items: WhiteboardEntry[];
  publicError: boolean;
  sessionStatus: number;
  elevatedUntil: string;
  publicReads: URL[];
  adminReads: number;
  writes: Write[];
  commits: number;
  failures: Failure[];
  holdWrite: Promise<void> | null;
  pages: Map<string, { items: WhiteboardEntry[]; nextCursor: string | null }>;
  errors: string[];
  unexpected: string[];
};

// Every API is intercepted: no cookies, real accounts, test posts or live writes.
async function mockBoard(page: Page): Promise<BoardMock> {
  await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript(value => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(value)), savedState());
  const state: BoardMock = {
    items: [{ ...lecture }, archived], publicError: false, sessionStatus: 200,
    elevatedUntil: "2026-10-10T11:00:00+08:00", publicReads: [], adminReads: 0,
    writes: [], commits: 0, failures: [], holdWrite: null, pages: new Map(), errors: [], unexpected: [],
  };
  const receipts = new Map<string, WhiteboardEntry>();
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { "Cache-Control": "no-store" } });
    if (method === "GET" && path === "/api/catalog/current") return json({ error: "not_found" }, 404);
    if (method === "GET" && path === "/api/auth/session") return json({ authenticated: false });
    if (method === "GET" && path === "/api/teachers/by-schedule") return json({ items: [] });
    if (method === "GET" && path === "/api/community/whiteboard") {
      state.publicReads.push(url);
      if (state.publicError) return json({ error: "service_unavailable" }, 503);
      const scope = url.searchParams.get("scope") || "active";
      const cursor = url.searchParams.get("cursor") || "";
      const override = state.pages.get(`${scope}:${cursor}`);
      if (override) return json(override);
      const items = state.items.filter(item => {
        const deadline = item.kind === "event" ? item.endsAt : item.expiresAt;
        const expired = Boolean(deadline && Date.parse(deadline) <= Date.parse(NOW));
        return item.status === "published" && (scope === "archive" ? expired : !expired);
      });
      return json({ items: items.slice(0, Number(url.searchParams.get("limit") || 20)), nextCursor: null });
    }
    if (method === "GET" && path === "/api/admin/session") {
      return state.sessionStatus === 200
        ? json({ role: "admin", mfaConfigured: true, elevated: true, elevatedUntil: state.elevatedUntil })
        : json({ error: state.sessionStatus === 401 ? "authentication_required" : "admin_required" }, state.sessionStatus);
    }
    if (method === "GET" && path === "/api/admin/overview") return json({ overview: { totalUsers: 1, activeUsers: 1, disabledUsers: 0, administrators: 1, verifiedEmails: 1, registrationTrend: [] } });
    if (method === "GET" && path === "/api/admin/users") return json({ users: [], nextCursor: null });
    if (method === "GET" && path === "/api/admin/audit") return json({ events: [] });
    if (method === "GET" && path === "/api/admin/whiteboard") {
      state.adminReads++;
      return json({ items: state.items, viewerId: OWNER, elevatedUntil: state.elevatedUntil, nextCursor: null });
    }
    if (["POST", "PATCH"].includes(method) && /^\/api\/admin\/whiteboard(?:\/[^/]+)?$/.test(path)) {
      const body = request.postDataJSON() as Mutation;
      const write = { method, path, owner: request.headers()["x-whiteboard-owner"], body };
      state.writes.push(write);
      if (state.holdWrite) await state.holdWrite;
      if (write.owner !== OWNER) return json({ error: "whiteboard_owner_changed" }, 403);
      // Use the real strict input contract: extra editor-only fields must not be masked by a permissive mock.
      if (!validateWhiteboardMutation(body, method === "PATCH")) return json({ error: "invalid_whiteboard_mutation" }, 400);
      const failure = state.failures.shift();
      if (failure && failure !== "lost-response") return json({ error: failure.error }, failure.status);
      const receiptKey = `${method}:${path}:${body.mutationId}`;
      let entry = receipts.get(receiptKey);
      if (!entry) {
        const old = method === "PATCH" ? state.items.find(item => path.endsWith(`/${item.id}`)) : undefined;
        if (method === "PATCH" && (!old || old.version !== body.version)) return json({ error: "whiteboard_version_conflict" }, 409);
        const copy = Object.fromEntries(Object.entries(body).filter(([key]) => !["mutationId", "version"].includes(key))) as BoardCopy & { status: WhiteboardEntry["status"] };
        entry = { ...copy, id: old?.id ?? `30000000-0000-4000-8000-${String(state.commits + 1).padStart(12, "0")}`,
          version: (old?.version ?? 0) + 1, publishedAt: old?.publishedAt ?? (body.status === "published" ? NOW : null), updatedAt: NOW };
        state.commits++;
        state.items = [entry, ...state.items.filter(item => item.id !== entry!.id)];
        receipts.set(receiptKey, entry);
      }
      if (failure === "lost-response") return route.abort("failed");
      return json({ entry });
    }
    // These existing admin panels are mounted (but hidden) alongside the desk.
    if (method === "GET" && path === "/api/admin/community/reports") return json({ reports: [], nextCursor: null });
    if (method === "GET" && path === "/api/admin/community/content") return json({ items: [], nextCursor: null });
    if (method === "GET" && path === "/api/admin/teacher-reviews/candidates") return json({ candidates: [], nextCursor: null });
    if (method === "GET" && path === "/api/admin/community/announcements") return json({ announcements: [] });
    state.unexpected.push(`${method} ${path}`);
    return json({ error: "unmocked_api_request" }, 501);
  });
  return state;
}

const test = base.extend<{ board: BoardMock }>({
  board: async ({ page }, provideFixture) => {
    const board = await mockBoard(page);
    await provideFixture(board);
    expect(board.errors, "uncaught browser errors").toEqual([]);
    expect(board.unexpected, "unexpected APIs must never reach a real server").toEqual([]);
  },
});

async function layoutAndAxe(page: Page) {
  expect(await page.evaluate(() => ({ root: document.documentElement.scrollWidth <= innerWidth, body: document.body.scrollWidth <= innerWidth }))).toEqual({ root: true, body: true });
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
}
async function openDesk(page: Page) {
  await page.goto("/admin#whiteboard");
  await expect(page.getByRole("heading", { name: "小白板", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "预览并发布", exact: true })).toBeVisible();
  return page.getByRole("region", { name: "管理小白板", exact: true });
}
async function fillEvent(page: Page) {
  await page.getByRole("button", { name: "讲座 / 活动", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).fill(lecture.title);
  await page.getByLabel("开始时间", { exact: true }).fill("2026-10-14T15:40");
  await page.getByLabel("结束时间", { exact: true }).fill("2026-10-14T17:00");
  await page.getByLabel("地点", { exact: true }).fill(lecture.location);
  await page.getByLabel("嘉宾（选填）", { exact: true }).fill(lecture.guest);
  await page.getByLabel("讲座 / 活动简介").fill(lecture.body);
  await page.locator("form summary").filter({ hasText: "嘉宾简介（选填）" }).click();
  await page.getByLabel("嘉宾简介", { exact: true }).fill(lecture.guestBio);
}
function checkWrite(write: Write, method: "POST" | "PATCH", status: Mutation["status"]) {
  expect(write.method).toBe(method);
  expect(write.owner).toBe(OWNER);
  expect(write.body.status).toBe(status);
  expect(write.body.mutationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(Object.keys(write.body).sort()).toEqual([
    "kind", "title", "body", "guest", "guestBio", "location", "startsAt", "endsAt", "expiresAt", "status", "mutationId", ...(method === "PATCH" ? ["version"] : []),
  ].sort());
}

for (const width of [320, 390, 1280]) {
  test(`published home entry, anonymous event detail and archive at ${width}px`, async ({ page, board }) => {
    await page.setViewportSize({ width, height: 900 });
    board.items.push(note({ status: "draft", body: "未发布的私密草稿" }), note({ id: "20000000-0000-4000-8000-000000000004", status: "withdrawn", body: "撤下的私密内容" }));
    await page.goto("/?view=home");
    const entry = page.getByRole("region", { name: "小白板", exact: true });
    await expect(entry.getByRole("heading", { name: lecture.title })).toBeVisible();
    const deckBox = await page.locator(".today-command-deck").boundingBox();
    const entryBox = await entry.boundingBox();
    expect(deckBox).not.toBeNull(); expect(entryBox).not.toBeNull();
    expect(entryBox!.y).toBeGreaterThanOrEqual(deckBox!.y + deckBox!.height);
    expect(board.publicReads.some(url => url.searchParams.get("scope") === "active" && url.searchParams.get("limit") === "1")).toBe(true);
    await layoutAndAxe(page);
    const link = entry.getByRole("link");
    await link.focus(); await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/whiteboard#note-${lecture.id}$`));
    const article = page.locator(`#note-${lecture.id}`);
    await expect(article.getByText(lecture.body, { exact: true })).toBeVisible();
    await expect(article).toContainText("15:40—17:00");
    await expect(article.getByText(lecture.location, { exact: true })).toBeVisible();
    await expect(article.getByText(lecture.guest, { exact: true })).toBeVisible();
    await article.locator("summary").filter({ hasText: "嘉宾简介" }).click();
    await expect(article.getByText(lecture.guestBio, { exact: true })).toBeVisible();
    await expect(page.getByText("未发布的私密草稿")).toHaveCount(0);
    await expect(page.getByText("撤下的私密内容")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(编辑|撤下|存草稿|预览并发布|确认发布)$/ })).toHaveCount(0);
    await layoutAndAxe(page);
    const archive = page.getByRole("navigation", { name: "白板内容" }).getByRole("button", { name: "往期", exact: true });
    await archive.focus(); await page.keyboard.press("Enter");
    await expect(archive).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(archived.body, { exact: true })).toBeVisible();
    await archive.click();
    await expect(page.getByText(archived.body, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: lecture.title })).toHaveCount(0);
    expect(board.publicReads.some(url => url.searchParams.get("scope") === "archive")).toBe(true);
    await layoutAndAxe(page);
    await page.getByRole("button", { name: "正在板上", exact: true }).click();
    await expect(page.getByRole("heading", { name: lecture.title })).toBeVisible();
    await page.getByRole("button", { name: "正在板上", exact: true }).click();
    await expect(page.getByRole("heading", { name: lecture.title })).toBeVisible();
    expect(board.writes).toHaveLength(0);
  });

  for (const unavailable of ["empty", "error"] as const) {
    test(`home hides the entire whiteboard for ${unavailable} active feed at ${width}px`, async ({ page, board }) => {
      await page.setViewportSize({ width, height: 900 });
      board.items = [archived, note({ status: "draft" }), note({ status: "withdrawn" })];
      board.publicError = unavailable === "error";
      const response = page.waitForResponse(res => new URL(res.url()).pathname === "/api/community/whiteboard");
      await page.goto("/?view=home");
      await (await response).finished();
      await expect(page.locator(".today-command-deck")).toBeVisible();
      await expect(page.locator("#whiteboard-entry")).toHaveCount(0);
      await expect(page.getByRole("region", { name: "小白板", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /打开白板/ })).toHaveCount(0);
      await expect(page.getByText(/暂时没有新留言|白板暂时没读取到/)).toHaveCount(0);
      await layoutAndAxe(page);
      expect(board.publicReads.length).toBeGreaterThan(0);
      expect(board.writes).toHaveLength(0);
    });
  }

  test(`admin event live preview and publish confirmation are accessible at ${width}px`, async ({ page, board }) => {
    await page.setViewportSize({ width, height: 900 });
    board.items = [];
    await openDesk(page);
    await fillEvent(page);
    const preview = page.getByRole("complementary", { name: "小白板实时预览" });
    await expect(preview.getByRole("heading", { name: lecture.title })).toBeVisible();
    await expect(preview).toContainText("15:40—17:00");
    await expect(preview.getByText(lecture.location, { exact: true })).toBeVisible();
    await expect(preview.getByText(lecture.body, { exact: true })).toBeVisible();
    await expect(preview.getByText("仅预览，尚未发布")).toBeVisible();
    expect(board.writes).toHaveLength(0);
    await layoutAndAxe(page);
    await page.getByRole("button", { name: "预览并发布", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "放上白板？", exact: true });
    await expect(dialog.getByRole("heading", { name: lecture.title })).toBeVisible();
    await expect(dialog.getByText(lecture.body, { exact: true })).toBeVisible();
    expect(board.writes).toHaveLength(0);
    await layoutAndAxe(page);
    await dialog.getByRole("button", { name: "确认发布", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("已放上白板");
    expect(board.writes).toHaveLength(1);
    checkWrite(board.writes[0], "POST", "published");
    expect(board.writes[0].body).toMatchObject({ kind: "event", title: lecture.title, body: lecture.body, guest: lecture.guest, guestBio: lecture.guestBio, location: lecture.location, startsAt: lecture.startsAt, endsAt: lecture.endsAt, expiresAt: null });
  });
}

test("public pagination deduplicates overlapping IDs and does not reuse a cursor across scopes", async ({ page, board }) => {
  const second = note();
  board.pages.set("active:", { items: [lecture], nextCursor: "active-page-2" });
  board.pages.set("active:active-page-2", { items: [lecture, second], nextCursor: null });
  board.pages.set("archive:", { items: [archived], nextCursor: null });
  await page.goto("/whiteboard");
  await page.getByRole("button", { name: "再看一些", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.locator(`#note-${lecture.id}`)).toHaveCount(1);
  await expect(page.getByText(second.body, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "再看一些" })).toHaveCount(0);
  await page.getByRole("button", { name: "往期", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.getByText(archived.body, { exact: true })).toBeVisible();
  expect(board.publicReads.filter(url => url.searchParams.get("scope") === "archive").every(url => !url.searchParams.has("cursor"))).toBe(true);
  expect(board.writes).toHaveLength(0);
});

test("standalone empty/error states allow recovery without exposing editor controls", async ({ page, board }) => {
  board.publicError = true;
  await page.goto("/whiteboard");
  await expect(page.getByRole("alert")).toContainText("白板暂时没读取到");
  board.publicError = false; board.items = [];
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("暂时没有新留言。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "往期", exact: true }).click();
  await expect(page.getByText("还没有往期内容。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /发布|撤下|编辑/ })).toHaveCount(0);
  expect(board.writes).toHaveLength(0);
});

test("body-only one-character note needs confirmation; cancelling or Escape never publishes", async ({ page, board }) => {
  board.items = [];
  await openDesk(page);
  const submit = page.getByRole("button", { name: "预览并发布", exact: true });
  await page.getByLabel("想说的话").fill("   ");
  await expect(submit).toBeDisabled();
  await page.getByLabel("想说的话").fill("安");
  await expect(page.getByLabel("标题（选填）", { exact: true })).toHaveValue("");
  await expect(page.getByRole("complementary", { name: "小白板实时预览" }).getByText("安", { exact: true })).toBeVisible();
  await submit.click();
  const dialog = page.getByRole("dialog", { name: "放上白板？", exact: true });
  await dialog.getByRole("button", { name: "再改改", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("想说的话")).toHaveValue("安");
  await submit.click(); await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(board.writes).toHaveLength(0);
  await submit.click(); await dialog.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已放上白板");
  checkWrite(board.writes[0], "POST", "published");
  expect(board.writes[0].body).toMatchObject({ kind: "note", title: "", body: "安", guest: "", guestBio: "", location: "", startsAt: null, endsAt: null, expiresAt: null });
  await page.goto("/whiteboard");
  await expect(page.locator("article").getByText("安", { exact: true })).toBeVisible();
  await expect(page.locator("article h2")).toHaveCount(0);
});

test("event dates reject missing/equal/reversed ends and clearing required fields sends nothing", async ({ page, board }) => {
  await openDesk(page);
  await fillEvent(page);
  const publish = page.getByRole("button", { name: "预览并发布", exact: true });
  const save = page.getByRole("button", { name: "存草稿", exact: true });
  for (const end of ["", "2026-10-14T15:40", "2026-10-14T15:39"]) {
    await page.getByLabel("结束时间", { exact: true }).fill(end);
    await expect(publish).toBeDisabled(); await expect(save).toBeDisabled();
  }
  await page.getByLabel("结束时间", { exact: true }).fill("2026-10-14T17:00");
  await expect(publish).toBeEnabled();
  for (const [label, value] of [["主题", lecture.title], ["地点", lecture.location], ["讲座 / 活动简介", lecture.body]]) {
    await page.getByLabel(label, { exact: label !== "讲座 / 活动简介" }).fill("");
    await expect(publish).toBeDisabled();
    await page.getByLabel(label, { exact: label !== "讲座 / 活动简介" }).fill(value);
  }
  expect(board.writes).toHaveLength(0);
});

test("local draft survives leaving/re-entering; saved draft survives reload and stays private", async ({ page, board }) => {
  board.items = [];
  await openDesk(page);
  await page.getByLabel("想说的话").fill("管理员没有发布的草稿");
  const nav = page.getByRole("navigation", { name: "管理功能" });
  await nav.getByRole("button", { name: "用户", exact: true }).click();
  await nav.getByRole("button", { name: "小白板", exact: true }).click();
  await expect(page.getByLabel("想说的话")).toHaveValue("管理员没有发布的草稿");
  expect(board.writes).toHaveLength(0);
  await page.getByRole("button", { name: "存草稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  checkWrite(board.writes[0], "POST", "draft");
  await page.reload();
  const history = page.getByRole("region", { name: "白板记录", exact: true });
  await expect(history).toContainText("管理员没有发布的草稿");
  await history.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("想说的话")).toHaveValue("管理员没有发布的草稿");
  await page.goto("/whiteboard");
  await expect(page.getByText("暂时没有新留言。", { exact: true })).toBeVisible();
  await expect(page.getByText("管理员没有发布的草稿")).toHaveCount(0);
  expect(board.writes).toHaveLength(1);
});

test("withdraw cancellation is inert; confirmed withdrawal sends owner, version and the full copy", async ({ page, board }) => {
  board.items = [lecture];
  await openDesk(page);
  const row = page.getByRole("region", { name: "白板记录" }).getByRole("listitem");
  let confirmation = page.waitForEvent("dialog").then(async dialog => { expect(dialog.message()).toContain("撤下"); await dialog.dismiss(); });
  await row.getByRole("button", { name: "撤下", exact: true }).click(); await confirmation;
  expect(board.writes).toHaveLength(0);
  await expect(row).toContainText("正在板上");
  confirmation = page.waitForEvent("dialog").then(dialog => dialog.accept());
  await row.getByRole("button", { name: "撤下", exact: true }).click(); await confirmation;
  await expect.poll(() => board.writes.length).toBe(1);
  checkWrite(board.writes[0], "PATCH", "withdrawn");
  expect(board.writes[0].body).toMatchObject({ version: lecture.version, kind: lecture.kind, title: lecture.title, body: lecture.body, guest: lecture.guest, guestBio: lecture.guestBio, location: lecture.location, startsAt: lecture.startsAt, endsAt: lecture.endsAt, expiresAt: null });
  await expect(page.getByRole("status")).toContainText("已撤下");
  await expect(row.getByRole("button", { name: "撤下", exact: true })).toHaveCount(0);
  await page.goto("/whiteboard");
  await expect(page.getByText("暂时没有新留言。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "往期", exact: true }).click();
  await expect(page.getByText("还没有往期内容。", { exact: true })).toBeVisible();
});

for (const status of [401, 403]) {
  test(`non-admin access ${status} never opens the editor or reads its records`, async ({ page, board }) => {
    board.sessionStatus = status;
    await page.goto("/admin#whiteboard");
    await expect(page.getByRole("heading", { name: status === 401 ? "请先登录管理员账号" : "仅管理员可访问", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "管理小白板" })).toHaveCount(0);
    expect(board.adminReads).toBe(0); expect(board.writes).toHaveLength(0);
  });
}

test("MFA expires while composing: editor/confirmation disappear and no mutation is sent", async ({ page, board }) => {
  await page.clock.install({ time: new Date(NOW) });
  board.elevatedUntil = "2026-10-10T10:01:00+08:00";
  await openDesk(page);
  await page.getByLabel("想说的话").fill("验证到期前尚未发布的草稿");
  await page.getByRole("button", { name: "预览并发布", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "放上白板？", exact: true })).toBeVisible();
  await page.clock.fastForward(60_001);
  await expect(page.getByRole("heading", { name: "验证身份", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认发布" })).toHaveCount(0);
  expect(board.writes).toHaveLength(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), `dufesh:whiteboard-draft:${OWNER}:new`)).toContain("验证到期前尚未发布的草稿");
});

test("in-flight duplicate clicks are locked; lost response and 429 retry the same mutation only once", async ({ page, board }) => {
  board.items = [];
  board.failures = ["lost-response", { status: 429, error: "whiteboard_rate_limited" }];
  let release = () => {};
  board.holdWrite = new Promise<void>(resolve => { release = resolve; });
  await openDesk(page);
  await page.getByLabel("想说的话").fill("只发布一次的正文");
  await page.getByRole("button", { name: "预览并发布", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放上白板？", exact: true });
  try {
    await dialog.getByRole("button", { name: "确认发布", exact: true }).click();
    await expect.poll(() => board.writes.length).toBe(1);
    const pending = dialog.getByRole("button", { name: "正在发布…", exact: true });
    await expect(pending).toBeDisabled();
    // Dispatching an extra click also exercises the synchronous lock, not only CSS/disabled styling.
    await pending.dispatchEvent("click");
    expect(board.writes).toHaveLength(1);
  } finally { board.holdWrite = null; release(); }
  await expect(dialog.getByRole("alert")).toContainText("内容还在");
  expect(board.commits).toBe(1);
  await dialog.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("操作有点快");
  expect(board.writes).toHaveLength(2);
  await dialog.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("已放上白板");
  expect(board.writes).toHaveLength(3);
  expect(board.commits).toBe(1);
  expect(new Set(board.writes.map(write => write.body.mutationId)).size).toBe(1);
  expect(board.writes[1].body).toEqual(board.writes[0].body);
  expect(board.writes[2].body).toEqual(board.writes[0].body);
  for (const write of board.writes) checkWrite(write, "POST", "published");
  await expect(page.getByRole("region", { name: "白板记录" }).getByRole("listitem")).toHaveCount(1);
});

test("version conflict preserves the draft across re-entry and cannot overwrite a newer version", async ({ page, board }) => {
  const original = note({ version: 3, body: "服务器原始内容" });
  board.items = [original];
  await openDesk(page);
  const history = page.getByRole("region", { name: "白板记录" });
  await history.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("想说的话").fill("冲突后仍须保留的本地修改");
  board.items = [{ ...original, body: "另一位管理员已经更新", version: 4 }];
  await page.getByRole("button", { name: "预览并更新", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "更新这条白板？", exact: true });
  await dialog.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("草稿已保留");
  checkWrite(board.writes[0], "PATCH", "published");
  expect(board.writes[0].body.version).toBe(3);
  await dialog.getByRole("button", { name: "再改改", exact: true }).click();
  await expect(page.getByLabel("想说的话")).toHaveValue("冲突后仍须保留的本地修改");
  const nav = page.getByRole("navigation", { name: "管理功能" });
  await nav.getByRole("button", { name: "用户", exact: true }).click();
  await nav.getByRole("button", { name: "小白板", exact: true }).click();
  await expect(history).toContainText("另一位管理员已经更新");
  await history.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("想说的话")).toHaveValue("冲突后仍须保留的本地修改");
  await expect(page.getByRole("alert")).toContainText("这份草稿基于较早版本");
  await expect(page.getByRole("button", { name: "预览并更新", exact: true })).toBeDisabled();
  expect(board.writes).toHaveLength(1); expect(board.commits).toBe(0);
  await page.getByRole("button", { name: "使用最新版本", exact: true }).click();
  await expect(page.getByLabel("想说的话")).toHaveValue("另一位管理员已经更新");
  await expect(page.getByRole("button", { name: "预览并更新", exact: true })).toBeEnabled();
});
