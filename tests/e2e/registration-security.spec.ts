import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`registration code request contains only email and keeps password-manager input at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    await page.route("**/api/auth/**", async (route) => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (request.method() === "POST") requests.push({ path, body: request.postDataJSON() });
      const body = path === "/api/auth/session" ? {
        authenticated: false, deviceId: "browser-fixture", wechat: { available: false },
        login: { credentialsAvailable: true, passwordResetAvailable: true, emailVerificationAvailable: false },
      } : path === "/api/auth/register/challenge" ? {
        ok: true, challengeId: "00000000-0000-4000-8000-000000000022", expiresIn: 300, retryAfter: 60,
      } : { authenticated: true };
      await route.fulfill({ status: path === "/api/auth/register/challenge" ? 202 : path === "/api/auth/register" ? 201 : 200,
        contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/?view=me");
    await expect(page.locator(".me-page")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "选择班级" })).toHaveCount(0);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    const form = page.locator(".credential-gateway form");
    await expect(form).not.toContainText("1–24");
    await expect(form).not.toContainText("8–128");
    expect(await form.getByLabel("用户名").getAttribute("minlength")).toBeNull();
    expect(await form.getByLabel("密码", { exact: true }).getAttribute("maxlength")).toBeNull();
    await form.getByLabel("用户名").fill("海");
    await form.getByLabel("邮箱", { exact: true }).fill("browser-student@example.com");
    await form.getByLabel("密码", { exact: true }).fill("seaWind8");
    await expect(form.getByLabel("密码", { exact: true })).toHaveAttribute("autocomplete", "new-password");
    await form.getByRole("button", { name: "发送验证码", exact: true }).click();
    await expect(form.getByRole("button", { name: /秒后可重发/ })).toBeDisabled();
    expect(requests[0]).toEqual({ path: "/api/auth/register/challenge", body: { email: "browser-student@example.com" } });
    await form.getByLabel(/^邮箱验证码/).fill("246810");
    for (const invalidPassword of ["🌊".repeat(7), "🌊".repeat(129)]) {
      await form.getByLabel("密码", { exact: true }).fill(invalidPassword);
      await expect(form.getByLabel("密码", { exact: true })).toHaveValue(invalidPassword);
      await form.getByRole("button", { name: "创建账号", exact: true }).click();
      await expect(page.locator(".credential-feedback").last()).toContainText("8–128");
      expect(requests).toHaveLength(1);
    }
    await form.getByLabel("密码", { exact: true }).fill("seaWind8");
    await form.getByLabel("昵称使用 momo").check();
    await form.getByRole("button", { name: "创建账号", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].body.challengeId).toBe("00000000-0000-4000-8000-000000000022");
    expect(requests[1].body.code).toBe("246810");
    expect(requests[1].body.password).toBe("seaWind8");
    expect(requests[1].body.username).toBe("海");
    expect(requests[1].body.displayName).toBe("momo");
    await expect(form.getByLabel("密码", { exact: true })).toHaveValue("");
    const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    expect(storage).not.toContain("seaWind8"); expect(storage).not.toContain("246810");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
  });
}
