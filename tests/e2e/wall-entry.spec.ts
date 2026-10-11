import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { savedState } from "../fixtures/hub-experience.mjs";
test.use({ baseURL: process.env.WALL_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || (process.env.CI ? "http://localhost:3000" : "http://localhost:3107") });

for (const width of [320, 390, 1280]) {
  test(`wall entry preserves source page and remains visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(value => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(value)), savedState());
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/auth/session" ? { authenticated: false } : { items: [], nextCursor: null } }));
    for (const view of ["home", "schedule", "rooms", "catalog", "me"]) {
      await page.goto(`/?view=${view}`);
      const entry = page.locator("#wall-header-entry");
      await expect(entry).toBeVisible();
      await expect.poll(async () => new URL(await entry.getAttribute("href") || "", page.url()).searchParams.get("returnTo")).toBe(`/?view=${view}`);
      expect((await entry.boundingBox())!.y).toBeLessThan(80);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await entry.click();
      await expect(page.getByRole("heading", { name: "东财墙", exact: true })).toBeVisible();
      const label = ({home:"今日",schedule:"课表",rooms:"空教室",catalog:"课程",me:"我的"} as Record<string,string>)[view];
      const back = page.getByRole("link", { name: `← 返回${label}`, exact: true });
      await expect(back).toHaveAttribute("href", `/?view=${view}`);
      await back.click();
      await expect(page).toHaveURL(new RegExp(`view=${view}`));
      await expect(entry).toBeVisible();
    }
    await expect(page.locator("#wall-personal-entry")).toBeVisible();
    const report = await new AxeBuilder({ page }).analyze();
    expect(report.violations.filter(v => ["serious", "critical"].includes(v.impact || ""))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("wall return address rejects external destinations and removes credentials", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { authenticated:false,items:[],nextCursor:null } }));
  await page.goto("/community?returnTo=https%3A%2F%2Fexample.com");
  await expect(page.getByRole("link", { name:"← 返回今日",exact:true })).toHaveAttribute("href","/?view=home");
  await page.goto("/community?returnTo="+encodeURIComponent("/?view=rooms&room-building=之远楼&room-floor=10&room-date=2026-10-11&password=secret&token=private"));
  const href = await page.getByRole("link", { name:"← 返回空教室",exact:true }).getAttribute("href");
  expect(href).toContain("room-floor=10"); expect(href).not.toMatch(/password|token|secret|private/);
});

test("login returns to the wall composer and retains source and timeline", async ({ page }) => {
  let authenticated = false;
  const writes: string[] = [];
  await page.addInitScript(value => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(value)), savedState());
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    const auth = { authenticated, user: authenticated ? { id:"20000000-0000-4000-8000-000000000001",username:"preview",displayName:"演示同学",avatarUrl:null } : undefined };
    return route.fulfill({ json: new URL(route.request().url()).pathname === "/api/auth/session" ? auth : { items:[],nextCursor:null,state:null,unread:0 } });
  });
  const origin = "/?view=rooms&room-building=之远楼&room-floor=10";
  await page.goto("/community?returnTo="+encodeURIComponent(origin));
  const login = page.getByRole("link", { name:"登录",exact:true });
  const expectedOrigin = "/?view=rooms&room-building=%E4%B9%8B%E8%BF%9C%E6%A5%BC&room-floor=10";
  await expect.poll(async () => new URL(new URL(await login.getAttribute("href")||"",page.url()).searchParams.get("wallReturn") || "/", page.url()).searchParams.get("returnTo")).toBe(expectedOrigin);
  await page.getByRole("button", { name:"最新回复",exact:true }).click();
  await expect.poll(async () => new URL(new URL(await login.getAttribute("href")||"",page.url()).searchParams.get("wallReturn") || "/", page.url()).searchParams.get("sort")).toBe("replied");
  await expect.poll(async () => new URL(new URL(await page.getByRole("link", { name:"登录发帖",exact:true }).last().getAttribute("href")||"",page.url()).searchParams.get("wallReturn") || "/",page.url()).searchParams.get("sort")).toBe("replied");
  const target = await login.getAttribute("href");
  authenticated = true;
  await page.goto(target!);
  await expect(page).toHaveURL(/\/community\?sort=replied&returnTo=.*#wall-body$/);
  await expect(page.getByRole("textbox", { name:"帖子正文",exact:true })).toBeVisible();
  await expect(page.getByRole("link", { name:"← 返回空教室",exact:true })).toHaveAttribute("href", "/?view=rooms&room-building=%E4%B9%8B%E8%BF%9C%E6%A5%BC&room-floor=10");
  expect(writes).toEqual([]);
});
