import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { makeCatalogSnapshot } from "../../services/auth-api/src/catalog/snapshots.mjs";

// Real public data, with only explicit synthetic additions/metadata edits. These
// tests exercise client consumption; they do not claim to replace SSR catalogs.
const addedCourseId = "99100991";
const changedTitle = "发布回归课程新名称";
const addedTitle = "发布回归新增课程";
const materialId = "fedcba0123456789abcd";
const materialName = "发布回归关联学习资料";
const externalLink = "https://example.test/published-review.pdf";
type Snapshot = Awaited<ReturnType<typeof makeCatalogSnapshot>>;
type Release = { courses: Snapshot; materials: Snapshot };
let original: Release, updated: Release, changedCourseId: string, originalTitle: string;

test.beforeAll(async () => {
  const [courseText, materialText] = await Promise.all([
    readFile(new URL("../../public/data/course-data.json", import.meta.url), "utf8"),
    readFile(new URL("../../public/data/resource-manifest.json", import.meta.url), "utf8"),
  ]);
  const courses = JSON.parse(courseText), materials = JSON.parse(materialText);
  expect(courses.schedules).toHaveLength(5870);
  expect(courses.courses).toHaveLength(1759);
  expect(materials.materials).toHaveLength(457);
  const changedCourse = courses.courses[0];
  changedCourseId = changedCourse.id; originalTitle = changedCourse.title;
  expect(courses.courses.some((course: { id: string }) => course.id === addedCourseId)).toBe(false);
  expect(materials.materials.some((material: { id: string }) => material.id === materialId)).toBe(false);
  original = { courses: await makeCatalogSnapshot("courses", courses, { baseline: true }), materials: await makeCatalogSnapshot("materials", materials, { baseline: true }) };
  const next = structuredClone(courses);
  next.courses[0].title = changedTitle;
  for (const meeting of next.schedules) if (meeting.courseId === changedCourseId) meeting.title = changedTitle;
  next.courses.push({ id: addedCourseId, title: addedTitle, college: changedCourse.college, credits: "2.00", category: "通识选修", property: "任选", textbook: "", publisher: "", author: "", terms: ["fall"], teachers: ["回归合成教师"] });
  next.schedules.push({ id: "browser-published-meeting", sectionId: "browser-published-section", courseSequence: "01", meetingIndex: 1, term: "fall", courseId: addedCourseId, title: addedTitle, teacher: "回归合成教师", classNames: "", weekday: 2, block: 1, periods: [1, 2], weeks: Array.from({ length: 18 }, (_, index) => index + 1), timeText: "1-18周 星期二 第1-2节", building: "之远楼", room: "101", linked: false });
  const nextMaterials = structuredClone(materials);
  nextMaterials.materials.push({ id: materialId, name: materialName, courseIds: [changedCourseId, addedCourseId], courseTitle: `${changedTitle}、${addedTitle}`, teachers: ["回归合成教师"], colleges: [changedCourse.college], terms: ["fall"], years: [], tags: ["课件", "PDF"], category: "课件", kind: "PDF", extension: ".pdf", description: "由稳定课程号关联的一份外部学习资料", sizeBytes: 0, catalogedAt: "2026-10-12T00:00:00Z", previewable: false, previewUrl: "", downloadUrl: externalLink });
  updated = { courses: await makeCatalogSnapshot("courses", next), materials: await makeCatalogSnapshot("materials", nextMaterials) };
  for (const release of [original, updated]) expect(JSON.parse(release.courses.coreText!).catalogId).toBe(JSON.parse(release.courses.fullText).catalogId);
});

async function controlledPublications(context: BrowserContext, options: { mixedFull?: boolean } = {}) {
  let active = original;
  const requests = new Map<Page, string[]>();
  const scriptErrors = new Map<Page, string[]>();
  function observe(page: Page) {
    if (requests.has(page)) return;
    requests.set(page, []); scriptErrors.set(page, []);
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/catalog/") || path.startsWith("/data/course-") || path === "/data/resource-manifest.json") requests.get(page)!.push(path);
    });
    page.on("pageerror", error => scriptErrors.get(page)!.push(error.message));
  }
  context.pages().forEach(observe); context.on("page", observe);
  await context.addInitScript(() => {
    // newPage first executes init scripts in its opaque about:blank document.
    if (!/^https?:$/.test(location.protocol)) return;
    localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({ profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }], activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [] }));
  });
  await context.route("**/api/auth/**", route => route.fulfill({ json: { authenticated: false } }));
  await context.route("**/api/teachers/**", route => route.fulfill({ json: { items: [], teachers: [], nextCursor: null } }));
  await context.route("**/api/catalog/**", async route => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().method()).toBe("GET");
    if (path === "/api/catalog/current") {
      await route.fulfill({ headers: { "Cache-Control": "no-store" }, json: { courses: { revision: active === original ? 0 : 1, version: active.courses.version, coreUrl: `/api/catalog/releases/${active.courses.version}/core`, fullUrl: `/api/catalog/releases/${active.courses.version}/full` }, materials: { revision: active === original ? 0 : 1, version: active.materials.version, url: `/api/catalog/releases/${active.materials.version}/materials` } } });
      return;
    }
    for (const release of [original, updated]) {
      const prefix = `/api/catalog/releases/${release.courses.version}`;
      const body = path === `${prefix}/core` ? release.courses.coreText
        : path === `${prefix}/full` ? (options.mixedFull ? updated.courses.fullText : release.courses.fullText)
        : path === `/api/catalog/releases/${release.materials.version}/materials` ? release.materials.fullText : null;
      if (body !== null) { await route.fulfill({ contentType: "application/json; charset=utf-8", headers: { "Cache-Control": "public, max-age=31536000, immutable" }, body }); return; }
    }
    await route.fulfill({ status: 404, json: { error: "catalog_not_found" } });
  });
  return { publish: () => { active = updated; }, paths: (page: Page) => requests.get(page) ?? [], errors: (page: Page) => scriptErrors.get(page) ?? [] };
}

async function navigation(page: Page) {
  const desktop = page.getByRole("navigation", { name: "主导航", exact: true });
  return await desktop.isVisible() ? desktop : page.getByRole("navigation", { name: "手机主导航", exact: true });
}
async function openLibrary(page: Page, courseId: string) {
  await (await navigation(page)).getByRole("button", { name: "课程", exact: true }).click();
  await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "课程库", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索全校课程", exact: true }).fill(courseId);
  return page.getByRole("tabpanel", { name: "课程库", exact: true }).locator("article").filter({ hasText: courseId });
}

for (const width of [390, 1280]) {
  test(`new visits discover published courses/materials while an open page keeps one pinned release at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await controlledPublications(context);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".today-page")).toBeVisible();
    expect(state.paths(page)).toContain(`/api/catalog/releases/${original.courses.version}/core`);
    expect(state.paths(page).some(path => path.endsWith("/full"))).toBe(false);
    state.publish();
    const oldCard = await openLibrary(page, changedCourseId);
    await expect(oldCard).toHaveCount(1);
    await expect(oldCard).toContainText(originalTitle);
    await oldCard.getByRole("button", { name: "查看课程", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: originalTitle, exact: true })).toBeVisible();
    await expect.poll(() => state.paths(page).includes(`/api/catalog/releases/${original.materials.version}/materials`)).toBe(true);
    await expect(page.getByRole("dialog").getByText(materialName, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "关闭课程详情", exact: true }).click();
    await (await navigation(page)).getByRole("button", { name: "今天", exact: true }).click();
    const oldCardAgain = await openLibrary(page, addedCourseId);
    await expect(oldCardAgain).toHaveCount(0);
    expect(state.paths(page).filter(path => path === "/api/catalog/current")).toHaveLength(1);
    expect(state.paths(page).filter(path => path.endsWith("/full"))).toEqual([`/api/catalog/releases/${original.courses.version}/full`]);
    expect(state.paths(page).filter(path => path.startsWith("/data/"))).toEqual([]);

    const fresh = await context.newPage();
    await fresh.setViewportSize({ width, height: 900 });
    await fresh.goto("/", { waitUntil: "domcontentloaded" });
    await expect(fresh.locator(".today-page")).toBeVisible();
    expect(state.paths(fresh)).toContain(`/api/catalog/releases/${updated.courses.version}/core`);
    expect(state.paths(fresh).some(path => path.endsWith("/full"))).toBe(false);
    const renamed = await openLibrary(fresh, changedCourseId);
    await expect(renamed).toContainText(changedTitle);
    await expect(renamed).not.toContainText(originalTitle);
    await renamed.getByRole("button", { name: "查看课程", exact: true }).click();
    const renamedDrawer = fresh.getByRole("dialog");
    await expect(renamedDrawer.getByRole("heading", { name: changedTitle, exact: true })).toBeVisible();
    const existingCourseMaterial = renamedDrawer.locator(".course-material-list article").filter({ hasText: materialName });
    await expect(existingCourseMaterial).toHaveCount(1);
    await expect(existingCourseMaterial.getByRole("link", { name: "下载", exact: true })).toHaveAttribute("href", externalLink);
    await fresh.getByRole("button", { name: "关闭课程详情", exact: true }).click();
    const added = await openLibrary(fresh, addedCourseId);
    await expect(added).toHaveCount(1);
    await expect(added).toContainText(addedTitle);
    await added.getByRole("button", { name: "查看课程", exact: true }).click();
    const addedDrawer = fresh.getByRole("dialog");
    await expect(addedDrawer.getByRole("heading", { name: addedTitle, exact: true })).toBeVisible();
    await expect(addedDrawer).toContainText("回归合成教师");
    await expect(addedDrawer).toContainText("1-18周");
    await expect(addedDrawer.getByText(materialName, { exact: true })).toHaveCount(1);
    await expect(addedDrawer.locator(".course-material-list article").getByRole("link", { name: "下载", exact: true })).toHaveAttribute("href", externalLink);
    expect(state.paths(fresh).filter(path => path === "/api/catalog/current")).toHaveLength(1);
    expect(state.paths(fresh).filter(path => path.endsWith("/full"))).toEqual([`/api/catalog/releases/${updated.courses.version}/full`]);
    expect(state.paths(fresh).filter(path => path.endsWith("/materials"))).toEqual([`/api/catalog/releases/${updated.materials.version}/materials`]);
    expect(state.paths(fresh).filter(path => path.startsWith("/data/"))).toEqual([]);
    expect(state.errors(page)).toEqual([]); expect(state.errors(fresh)).toEqual([]);
    await fresh.close();
  });
}

test("a full snapshot from a different catalog is rejected without silently showing bundled courses", async ({ page, context }) => {
  const state = await controlledPublications(context, { mixedFull: true });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".today-page")).toBeVisible();
  await (await navigation(page)).getByRole("button", { name: "课程", exact: true }).click();
  await expect(page.getByText("完整课程数据没有加载成功", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "课程库", exact: true })).toHaveCount(0);
  expect(state.paths(page).filter(path => path.startsWith("/data/"))).toEqual([]);
  await page.getByRole("button", { name: "回到今日", exact: true }).click();
  await expect(page.locator(".today-page")).toBeVisible();
  expect(state.errors(page)).toEqual([]);
});
