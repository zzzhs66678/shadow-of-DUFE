import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("school services offer the exact plugin ZIP separately from Ginkgo", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({
    profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
    activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
  })));
  await page.goto("/?view=me");
  const services = page.locator("details.campus-gateway");
  await expect(services.locator("summary")).toContainText("图书馆 · 校园码 · 白果云");
  await services.locator("summary").click();
  const nav = page.getByRole("navigation", { name: "东财常用服务" });
  const plugin = services.getByRole("link", { name: "下载白果云插件 ZIP" });
  await expect(nav.getByRole("link")).toHaveCount(3);
  await expect(nav.getByRole("link", { name: /插件/ })).toHaveCount(0);
  await expect(plugin).toBeVisible();
  await expect(plugin).toHaveAttribute("href", "https://github.com/zzzhs66678/DUFE-Ginkgo-Downloader/releases/download/v0.1.0/DUFE-Ginkgo-Downloader-v0.1.0.zip");
  await expect(plugin).toHaveAttribute("target", "_blank");
  await expect(plugin).toHaveAttribute("rel", "noopener noreferrer");
  await expect(plugin).toContainText("下载 ZIP");
  const navBox = await nav.boundingBox();
  const pluginBox = await plugin.boundingBox();
  expect(pluginBox!.y).toBeGreaterThanOrEqual(navBox!.y + navBox!.height);
  await expect(nav.locator('a[href="https://ginkgostu.dufe.edu.cn/notice/system"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const result = await new AxeBuilder({ page }).include(".campus-gateway").analyze();
  expect(result.violations.filter(v => v.impact === "critical" || v.impact === "serious")).toEqual([]);
});
