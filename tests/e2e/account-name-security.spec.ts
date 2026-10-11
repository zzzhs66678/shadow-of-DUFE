import { expect, test, type Page } from "@playwright/test";
import { savedState } from "../fixtures/hub-experience.mjs";

async function setup(page: Page, mode: "name" | "momo" = "name") {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const user = { id: "name-browser-fixture", username: "sea-student", accountName: "小海", displayName: mode === "momo" ? "momo" : "小海", nameMode: mode,
    nameModeAvailableAt: null as string | null, email: "sea@example.com", emailVerified: true, schoolAccount: "20260001" };
  let pending: Record<string, unknown> | null = null;
  await page.addInitScript(state => {
    localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(state));
    localStorage.setItem("dufesh:student-profile:v3:user:name-browser-fixture", JSON.stringify(state));
  }, savedState());
  await page.route("**/api/auth/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (["POST", "PUT"].includes(req.method())) writes.push({ path, body: req.postDataJSON() });
    if (path === "/api/auth/session") return route.fulfill({ json: { authenticated: true, user,
      session: { expiresAt: "2099-01-01T00:00:00.000Z", deviceId: "fixture-device" }, login: { credentialsAvailable: true } } });
    if (path === "/api/auth/devices") return route.fulfill({ json: { devices: [] } });
    if (path.startsWith("/api/auth/sync")) return route.fulfill({ status: 503, json: { error: "synthetic_offline" } });
    if (path === "/api/auth/name-change") {
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        pending = { id: "pending-fixture", userId: user.id, requestedUsername: body.username ?? null,
          requestedDisplayName: body.displayName ?? null, status: "pending", reason: null,
          createdAt: new Date().toISOString(), reviewedAt: null };
      }
      return route.fulfill({ status: req.method() === "POST" ? 202 : 200, json: { request: pending } });
    }
    if (path === "/api/auth/name-mode") {
      const { mode: nextMode } = req.postDataJSON();
      user.nameMode = nextMode; user.displayName = nextMode === "momo" ? "momo" : user.accountName;
      user.nameModeAvailableAt = new Date(Date.now() + 7 * 86400000).toISOString();
      return route.fulfill({ json: { nameMode: user.nameMode, accountName: user.accountName, displayName: user.displayName,
        nameModeAvailableAt: user.nameModeAvailableAt } });
    }
    if (path === "/api/auth/profile") { user.schoolAccount = req.postDataJSON().schoolAccount; return route.fulfill({ json: { user } }); }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/?view=me");
  await page.getByRole("button", { name: "管理账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "@sea-student", exact: true })).toBeVisible();
  return { writes, user };
}

for (const width of [390, 1280]) {
  test(`name request does not rename immediately; school number saves independently at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { writes, user } = await setup(page, "momo");
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    const profile = page.locator(".account-profile");
    await expect(profile.getByLabel("昵称", { exact: true })).toHaveValue("小海");
    await profile.getByLabel("昵称", { exact: true }).fill("远山");
    await profile.getByRole("button", { name: "提交改名申请", exact: true }).click();
    await expect(profile).toContainText("改名申请待审核");
    await expect(profile.getByRole("button", { name: "提交改名申请", exact: true })).toBeDisabled();
    expect(writes[0]).toEqual({ path: "/api/auth/name-change", body: { displayName: "远山" } });
    expect(user.accountName).toBe("小海");
    expect(user.displayName).toBe("momo");
    await profile.getByLabel("学号").fill("20260002");
    await profile.getByRole("button", { name: "保存学号", exact: true }).click();
    await expect(profile).toContainText("20260002");
    expect(writes[1]).toEqual({ path: "/api/auth/profile", body: { schoolAccount: "20260002" } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });

  test(`momo switch is explicit and cooldown survives refresh at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { writes, user } = await setup(page);
    const panel = page.locator(".account-name-mode");
    await panel.getByRole("button", { name: "切换为 momo", exact: true }).click();
    await expect(panel).toContainText("7 天内无法再次切换");
    await panel.getByRole("button", { name: "取消切换", exact: true }).click();
    expect(writes).toHaveLength(0);
    await panel.getByRole("button", { name: "切换为 momo", exact: true }).click();
    await panel.getByRole("button", { name: "确认切换", exact: true }).click();
    await expect(panel.getByRole("button", { name: "切回自己的名字", exact: true })).toBeDisabled();
    expect(writes).toEqual([{ path: "/api/auth/name-mode", body: { mode: "momo" } }]);
    expect(user.accountName).toBe("小海");
    await page.reload();
    await page.getByRole("button", { name: "管理账号", exact: true }).click();
    await expect(panel.getByRole("button", { name: "切回自己的名字", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    await expect(page.locator(".account-profile").getByLabel("昵称", { exact: true })).toHaveValue("小海");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });

  test(`a stale account tab discards the previous name draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { user } = await setup(page);
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    await page.locator(".account-profile").getByLabel("昵称", { exact: true }).fill("旧账号草稿");
    await page.route("**/api/auth/name-change", async route => {
      if (route.request().method() !== "POST") return route.fulfill({ json: { request: null } });
      expect(route.request().headers()["x-account-owner"]).toBe("name-browser-fixture");
      user.id = "changed-browser-fixture"; user.username = "other-student"; user.accountName = "乙"; user.displayName = "乙";
      return route.fulfill({ status: 409, json: { error: "account_changed" } });
    });
    await page.getByRole("button", { name: "提交改名申请", exact: true }).click();
    await expect(page.getByRole("heading", { name: "@other-student", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "编辑资料", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    await expect(page.locator(".account-profile").getByLabel("昵称", { exact: true })).toHaveValue("乙");
  });
}
