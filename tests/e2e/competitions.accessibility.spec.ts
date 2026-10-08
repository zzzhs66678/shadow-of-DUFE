import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { competitions, competitionPath } from "../../app/competitions/catalog";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({
    profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
    activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
  })));
});

test("personal entry leads to real competition notices and the unchanged ZIP download", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?view=me");
  const gateway = page.getByRole("region", { name: "学科考试及竞赛", exact: true });
  await expect(gateway).toBeVisible();
  const plugin = page.getByRole("region", { name: "白果云插件", exact: true });
  expect((await gateway.boundingBox())!.y).toBeGreaterThan((await plugin.boundingBox())!.y + (await plugin.boundingBox())!.height);
  expect((await gateway.boundingBox())!.height).toBeLessThanOrEqual(110);
  await expect(gateway.getByRole("link")).toHaveCount(1);
  await expect(gateway.getByRole("link")).toContainText("学科考试及竞赛");
  await gateway.getByRole("link", { name: /查看/ }).click();
  await expect(page).toHaveURL(/\/competitions$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("学科考试及竞赛");
  const navigation = page.getByRole("navigation", { name: "考试及竞赛导航" });
  const backToMe = navigation.getByRole("link", { name: "返回我的", exact: true });
  await expect(navigation.getByRole("link")).toHaveCount(1);
  const backBounds = (await backToMe.boundingBox())!;
  expect(backBounds.height).toBeGreaterThanOrEqual(44);
  expect(backBounds.x).toBeLessThan(page.viewportSize()!.width / 2);
  expect(backBounds.y).toBeLessThan(40);
  await expect(page.locator('main a[href^="/competitions/"]')).toHaveCount(6);
  await page.locator('main a[href="/competitions/dalian-math"]').click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("大连市数学竞赛");
  const resource = competitions[0].resources[0];
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: /下载试题/ }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(resource.filename);
  const body = await readFile((await download.path())!);
  expect(body.length).toBe(resource.sizeBytes);
  expect(createHash("sha256").update(body).digest("hex")).toBe(resource.sha256);
  const response = await page.request.head(resource.href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/zip");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  await page.screenshot({ path: testInfo.outputPath("competition-detail.png"), fullPage: true });
  await page.getByRole("link", { name: "返回考试及竞赛", exact: true }).click();
  await expect(page).toHaveURL(/\/competitions$/);
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("大连市数学竞赛");
  await page.getByRole("link", { name: "返回考试及竞赛", exact: true }).click();
  await backToMe.click();
  await expect(page).toHaveURL(/\?view=me#competitions-entry$/);
  await expect(gateway).toBeInViewport();
  await expect(gateway.getByRole("link")).toBeFocused();
  expect(errors).toEqual([]);
});

test("all competition details are readable, accessible and have the correct school link", async ({ page }) => {
  for (const item of competitions) {
    await page.goto(competitionPath(item.slug));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(item.title);
    const back = page.getByRole("navigation", { name: "考试及竞赛导航" }).getByRole("link");
    await expect(back).toHaveText("返回考试及竞赛");
    await expect(back).toHaveAttribute("href", "/competitions");
    const notice = page.getByRole("region", { name: "学校通知", exact: true }).getByRole("link");
    await expect(notice).toHaveAttribute("href", item.notice.url);
    await expect(notice).toHaveAttribute("target", "_blank");
    await expect(notice).toHaveAttribute("rel", "noopener noreferrer");
    await expect(notice.locator("time")).toHaveText(item.notice.publishedAt);
    await expect(page.getByRole("link", { name: /下载试题/ })).toHaveCount(item.resources.length);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter(v => ["critical", "serious"].includes(v.impact ?? ""))).toEqual([]);
  }
});
