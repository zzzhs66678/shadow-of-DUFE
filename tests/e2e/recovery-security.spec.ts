import { expect, test, type Page } from "@playwright/test";
import { savedState } from "../fixtures/hub-experience.mjs";

const recoveryToken = "synthetic_recovery_token_for_browser_test_1";
const currentPassword = "old short password";
const newPassword = "waves carry the summer notebooks";

async function setup(page: Page, authenticated = false) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let emailVerified = false;
  await page.addInitScript((state) => {
    localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(state));
    localStorage.setItem("dufesh:student-profile:v3:user:legacy-fixture", JSON.stringify(state));
  }, savedState());
  await page.route("**/api/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") requests.push({ path, body: request.postDataJSON() ?? {} });
    if (path === "/api/auth/session") {
      await route.fulfill({ json: {
        authenticated,
        user: authenticated ? { id: "legacy-fixture", username: "legacy-browser", displayName: "旧账号", email: "legacy@example.com", emailVerified } : null,
        login: { credentialsAvailable: true, passwordResetAvailable: true, emailVerificationAvailable: true, wechatAvailable: false },
      } });
    } else if (path === "/api/auth/devices") {
      await route.fulfill({ json: { devices: [] } });
    } else if (path.startsWith("/api/auth/sync")) {
      await route.fulfill({ status: 503, json: { error: "synthetic_offline" } });
    } else if (path === "/api/auth/login") {
      authenticated = true;
      await route.fulfill({ json: { authenticated: true } });
    } else if (path === "/api/auth/email/verification/confirm") {
      emailVerified = true;
      await route.fulfill({ json: { ok: true } });
    } else {
      await route.fulfill({ status: path.endsWith("/request") ? 202 : 200, json: { ok: true } });
    }
  });
  await page.goto("/?view=me");
  await page.getByRole("button", { name: authenticated ? "管理账号" : "登录", exact: true }).click();
  return requests;
}

async function noSensitiveStorage(page: Page) {
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  for (const secret of [currentPassword, newPassword, recoveryToken]) expect(storage).not.toContain(secret);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

for (const width of [390, 1280]) {
  test(`login retains expanded account details at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const requests = await setup(page);
    const form = page.locator(".credential-gateway form");
    await form.getByLabel("用户名或邮箱", { exact: true }).fill("legacy@example.com");
    await form.getByLabel("密码", { exact: true }).fill(currentPassword);
    await form.getByRole("button", { name: "登录并同步", exact: true }).click();
    await expect(page.getByRole("heading", { name: "@legacy-browser", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "收起", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "1 台设备", exact: true })).toBeVisible();
    expect(requests).toEqual([{ path: "/api/auth/login", body: { identifier: "legacy@example.com", password: currentPassword } }]);
    await noSensitiveStorage(page);
  });

  test(`SMTP reset 202 opens manual token entry and clears secrets when leaving at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const requests = await setup(page);
    await page.getByRole("button", { name: "忘记密码？", exact: true }).click();
    const form = page.locator(".credential-gateway form");
    await form.getByLabel("账号邮箱").fill("legacy@example.com");
    await form.getByRole("button", { name: "发送重置邮件", exact: true }).click();
    await expect(form.getByLabel(/^一次性重置码/)).toBeVisible();
    await expect(page.locator(".credential-gateway")).toContainText("已验证邮箱");
    await expect(form.getByLabel(/^一次性重置码/)).toHaveValue("");
    await form.getByLabel(/^一次性重置码/).fill(recoveryToken);
    for (const invalidPassword of ["🌊".repeat(14), "x".repeat(129)]) {
      await form.getByLabel("新密码", { exact: true }).fill(invalidPassword);
      await form.getByRole("button", { name: "保存新密码", exact: true }).click();
      await expect(page.locator(".credential-feedback").last()).toContainText("15–128");
      expect(requests).toHaveLength(1);
    }
    await form.getByLabel("新密码", { exact: true }).fill(newPassword);
    await expect(form.getByLabel("新密码", { exact: true })).toHaveAttribute("autocomplete", "new-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(form.getByLabel("密码", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "忘记密码？", exact: true }).click();
    await page.getByRole("button", { name: "已有重置码", exact: true }).click();
    await expect(form.getByLabel(/^一次性重置码/)).toHaveValue("");
    await form.getByLabel(/^一次性重置码/).fill(recoveryToken);
    await form.getByLabel("新密码", { exact: true }).fill(newPassword);
    await form.getByRole("button", { name: "保存新密码", exact: true }).click();
    await expect(form.getByLabel("密码", { exact: true })).toHaveValue("");
    expect(requests).toEqual([
      { path: "/api/auth/password/reset/request", body: { identifier: "legacy@example.com" } },
      { path: "/api/auth/password/reset/confirm", body: { token: recoveryToken, password: newPassword } },
    ]);
    await noSensitiveStorage(page);
  });

  test(`legacy verification proves current password and accepts a manually pasted mail token at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const requests = await setup(page, true);
    const verification = page.locator(".account-email-verification");
    await verification.getByLabel(/^当前密码/).fill(currentPassword);
    await expect(verification.getByLabel(/^当前密码/)).toHaveAttribute("autocomplete", "current-password");
    await verification.getByRole("button", { name: "发送验证邮件", exact: true }).click();
    await expect(verification.getByLabel(/^邮箱验证令牌/)).toBeVisible();
    await expect(verification.getByLabel(/^邮箱验证令牌/)).toHaveValue("");
    await verification.getByRole("button", { name: "重新发送验证邮件", exact: true }).click();
    await expect(verification.getByLabel(/^当前密码/)).toHaveValue("");
    await verification.getByRole("button", { name: "我已收到验证邮件", exact: true }).click();
    await verification.getByLabel(/^邮箱验证令牌/).fill(recoveryToken);
    await page.getByRole("button", { name: "收起", exact: true }).click();
    await page.getByRole("button", { name: "管理账号", exact: true }).click();
    await expect(verification.getByLabel(/^当前密码/)).toHaveValue("");
    await verification.getByRole("button", { name: "我已收到验证邮件", exact: true }).click();
    await expect(verification.getByLabel(/^邮箱验证令牌/)).toHaveValue("");
    await verification.getByLabel(/^邮箱验证令牌/).fill(recoveryToken);
    await verification.getByRole("button", { name: "完成验证", exact: true }).click();
    await expect(verification).toHaveCount(0);
    expect(requests).toEqual([
      { path: "/api/auth/email/verification/request", body: { password: currentPassword } },
      { path: "/api/auth/email/verification/confirm", body: { token: recoveryToken } },
    ]);
    await noSensitiveStorage(page);
  });
}
