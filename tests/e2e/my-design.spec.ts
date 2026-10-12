import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { savedState } from "../fixtures/hub-experience.mjs";

test.use({ timezoneId: "Asia/Shanghai", video: "on" });
async function setup(page: Page) {
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(state => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(state)), savedState());
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (route.request().method() !== "GET") writes.push(path);
    return route.fulfill({ json: path === "/api/auth/session" ? { authenticated: false, login: { credentialsAvailable: true } } : { items: [], nextCursor: null } });
  });
  await page.goto("/?view=me");
  return { errors, writes };
}
async function axe(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations.filter(v => ["serious", "critical"].includes(v.impact || ""))).toEqual([]);
}

test("clearing signed-in local cache reloads cloud records without deleting them", async ({ page }) => {
  const userId = "local-cache-fixture";
  const cloud = { ...savedState({ assignments:[{id:"keep-cloud-task",title:"云端作业保留",courseId:"",notes:"",completed:false,dueDate:"2026-10-20"}] }), preferredTerm:"fall",theme:"system" };
  const writes: Record<string,unknown>[] = [];
  let reads = 0;
  await page.route("**/api/**", async route => {
    const req=route.request(), path=new URL(req.url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if(path==="/api/auth/session") return route.fulfill({json:{authenticated:true,user:{id:userId,username:"cache-user",displayName:"缓存测试",role:"user"},session:{expiresAt:"2099-01-01T00:00:00Z"},login:{credentialsAvailable:true}}});
    if(path==="/api/auth/devices") return route.fulfill({json:{devices:[]}});
    if(path==="/api/auth/sync"){
      if(req.method()==="GET") reads++;
      else writes.push(req.postDataJSON().state);
      return route.fulfill({json:{revision:5,state:cloud,updatedAt:"2026-10-12T00:00:00Z"}});
    }
    return route.fulfill({json:{items:[],nextCursor:null}});
  });
  await page.goto("/?view=me");
  await expect.poll(()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||"{}").assignments?.[0]?.id,`dufesh:student-profile:v3:user:${userId}`)).toBe("keep-cloud-task");
  page.on("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"清除缓存并重新同步",exact:true}).click();
  await expect.poll(()=>reads).toBeGreaterThanOrEqual(2);
  await expect.poll(()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||"{}").assignments?.[0]?.id,`dufesh:student-profile:v3:user:${userId}`)).toBe("keep-cloud-task");
  // Cover the debounced cloud writer as well as the immediate reload.
  await page.waitForTimeout(1800);
  expect(writes.every(state=>Array.isArray(state.assignments)&&state.assignments.some(task=>task.id==="keep-cloud-task"))).toBe(true);
});
async function enter(page: Page) {
  const opener = page.getByRole("button", { name: "进入校园漫游", exact: true });
  await opener.click();
  const gallery = page.getByRole("dialog", { name: "校园漫游", exact: true });
  await expect(gallery).toBeVisible();
  await expect(gallery.locator("[data-gallery-scroll]")).toHaveAttribute("data-motion", /loop|reduced/);
  return { opener, gallery };
}

async function settle(page: Page, slot: number) {
  const gallery = page.getByRole("dialog", { name: "校园漫游", exact: true });
  const photo = gallery.locator(`[data-slot="${slot}"] button`);
  await expect(photo).toHaveAttribute("data-active", "true");
  await expect(gallery.locator("[data-gallery-scroll]")).toHaveAttribute("data-animating", "false");
  await expect(photo).toHaveAttribute("data-active", "true");
  await expect(photo).toHaveCSS("opacity", "1");
}
async function goTo(page: Page, slot: number) {
  const gallery = page.getByRole("dialog", { name: "校园漫游", exact: true });
  if (slot === 0 || slot === 25) {
    await page.keyboard.press(slot === 0 ? "Home" : "End");
  } else if (await gallery.locator("[data-gallery-scroll]").getAttribute("data-motion") === "reduced") {
    await page.keyboard.press("Home"); await settle(page, 0);
    for (let step = 1; step <= slot; step++) {
      await page.keyboard.press("ArrowRight"); await settle(page, step);
    }
  } else {
    // Focus navigation brings an off-screen photograph into view, without a
    // hidden scrubber or a test-only motion API.
    const anchor = slot <= 12 ? 25 : 0;
    await page.keyboard.press(anchor === 0 ? "Home" : "End"); await settle(page, anchor);
    await gallery.locator(`[data-slot="${slot}"] button`).focus();
  }
  await settle(page, slot);
}
async function loaded(image: ReturnType<Page["locator"]>) {
  await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true);
}

for (const width of [320, 390, 768, 1280]) {
  test("My services, scattered gallery, source focus and return at " + width + "px", async ({ page }, info) => {
    test.setTimeout(80000);
    await page.setViewportSize({ width, height: 844 });
    const checks = await setup(page);
    const overview = page.getByRole("region", { name: "个人概况", exact: true });
    await expect(overview).toContainText("尚未设置专业");
    const account = page.locator(".account-center");
    const services = page.locator(".campus-gateway");
    const plugin = page.getByRole("region", { name: "白果云插件", exact: true });
    const competitions = page.getByRole("region", { name: "学科考试及竞赛", exact: true });
    const tribute = page.getByRole("region", { name: "致敬知识分享", exact: true });
    const overviewBox = (await overview.boundingBox())!;
    const accountBox = (await account.boundingBox())!;
    const servicesBox = (await services.boundingBox())!;
    const pluginBox = (await plugin.boundingBox())!;
    expect(accountBox.y).toBeGreaterThanOrEqual(overviewBox.y + overviewBox.height);
    expect((await page.locator("#wall-personal-entry").boundingBox())!.y).toBeGreaterThanOrEqual(accountBox.y + accountBox.height);
    expect(pluginBox.y).toBeGreaterThan(servicesBox.y + servicesBox.height);
    expect(pluginBox.width).toBeCloseTo(servicesBox.width, 0);
    expect(servicesBox.height).toBeLessThanOrEqual(104);
    // Native Chinese/Latin fallback fonts can add one line at 320px. Keep the
    // closed card below 30% of this phone viewport without clipping its copy.
    expect(pluginBox.height).toBeLessThanOrEqual(width === 320 ? 252 : 230);
    await expect(overview).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(account).toHaveCSS("border-left-width", "0px");
    await expect(competitions).toHaveCSS("border-bottom-width", "1px");
    expect((await tribute.boundingBox())!.height).toBeLessThanOrEqual(220);
    const more = tribute.locator("summary");
    const sources = tribute.getByRole("navigation", { name: "了解 Alexandra Elbakyan" });
    await expect(sources).toBeHidden();
    await expect(tribute.getByRole("link", { name: "CC BY 2.0", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("my-top-" + width + ".png") });
    await more.focus(); await page.keyboard.press("Enter");
    await expect(sources.getByRole("link")).toHaveCount(4);
    await expect(sources.getByRole("link", { name: "Nature · 2016 年度人物 ↗", exact: true })).toHaveAttribute("href", "https://www.nature.com/articles/540507a");
    await axe(page);
    await page.keyboard.press("Enter"); await expect(sources).toBeHidden();
    await page.locator(".me-page").screenshot({ path: info.outputPath("my-page-" + width + ".png") });
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByLabel("用户名或邮箱", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "收起", exact: true }).click();
    await services.locator("summary").click(); await expect(services.getByRole("link")).toHaveCount(3);
    await expect(page.getByRole("link", { name: "下载白果云插件 ZIP", exact: true })).toHaveAttribute("href", /releases\/download\/v0\.1\.0\/DUFE-Ginkgo-Downloader-v0\.1\.0\.zip$/);
    await page.locator("details").filter({ has: page.locator("summary", { hasText: "怎么安装" }) }).locator("summary").click();
    await expect(page.getByText("chrome://extensions", { exact: true })).toBeVisible();
    const album = page.getByRole("region", { name: "校园相册", exact: true });
    expect((await album.innerText()).trim()).toBe("");
    await album.scrollIntoViewIfNeeded();
    await expect.poll(() => album.locator("img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await expect.poll(() => album.locator("img").evaluateAll(images => images.every(image => image.getAnimations().every(animation => animation.playState !== "running")))).toBe(true);
    const albumBox = (await album.boundingBox())!;
    expect(albumBox.height).toBeLessThanOrEqual(640);
    expect(albumBox.height).toBeGreaterThanOrEqual(440);
    expect(albumBox.width).toBeCloseTo(servicesBox.width, 0);
    if (width < 760) {
      const main = (await album.locator('[data-slot="0"]').boundingBox())!;
      const side = (await album.locator('[data-slot="1"]').boundingBox())!;
      expect(main.width / albumBox.width).toBeGreaterThan(.7);
      expect(main.x + main.width + 8).toBeLessThan(side.x);
    }
    expect((await page.getByRole("region", { name: "学科考试及竞赛", exact: true }).boundingBox())!.y).toBeLessThan((await album.boundingBox())!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await axe(page); await album.screenshot({ path: info.outputPath("entry-" + width + ".png") });
    const { opener, gallery } = await enter(page);
    const pageTop = await page.evaluate(() => window.scrollY);
    const exit = gallery.getByRole("button", { name: "退出校园漫游" });
    await expect(exit).toBeFocused();
    await expect(gallery.getByRole("heading")).toHaveCount(0);
    await expect(gallery.locator("[data-slot]")).toHaveCount(26);
    const allPhotos = gallery.getByRole("button", { name: "全部照片", exact: true });
    await expect(gallery.getByRole("slider")).toHaveCount(0);
    await expect(gallery.locator("footer")).toHaveCount(0);
    await expect(gallery.locator("header button")).toHaveCount(2);
    const allPhotosBox = (await allPhotos.boundingBox())!;
    const exitBox = (await exit.boundingBox())!;
    expect(allPhotosBox.width).toBeGreaterThanOrEqual(44);
    expect(allPhotosBox.height).toBeGreaterThanOrEqual(44);
    expect(allPhotosBox.y).toBe(exitBox.y);
    expect(allPhotosBox.x + allPhotosBox.width).toBeLessThan(exitBox.x);
    await expect(allPhotos).toBeInViewport();
    await page.keyboard.press("Shift+Tab"); await expect(allPhotos).toBeFocused();
    await page.keyboard.press("Tab"); await expect(exit).toBeFocused();
    await loaded(gallery.getByRole("button", { name: /查看原图：春日樱花/ }).locator("img"));
    await settle(page, 0);
    const mainPhoto = (await gallery.locator("[data-slot='0'] button").boundingBox())!;
    const sidePhoto = (await gallery.locator("[data-slot='1'] button").boundingBox())!;
    if (width === 1280) {
      expect(mainPhoto.height).toBeGreaterThan(844 * .7);
      expect(mainPhoto.y).toBeLessThan(844 * .15);
      expect(sidePhoto.width).toBeGreaterThan(width * .25);
    } else if (width < 760) {
      expect(mainPhoto.width / width).toBeGreaterThan(.72);
      expect(mainPhoto.width / width).toBeLessThan(.85);
      expect(sidePhoto.y - mainPhoto.y - mainPhoto.height).toBeGreaterThan(64);
      expect(sidePhoto.width / width).toBeGreaterThan(.6);
    }
    await axe(page); await gallery.screenshot({ path: info.outputPath("gallery-" + width + ".png") });
    await goTo(page, 11);
    await gallery.screenshot({ path: info.outputPath("middle-" + width + ".png") });
    await goTo(page, 25);
    await loaded(gallery.getByRole("button", { name: /查看原图：雪夜中的东财红亭/ }).locator("img"));
    await gallery.screenshot({ path: info.outputPath("end-" + width + ".png") });
    const source = gallery.getByRole("button", { name: /查看原图：雪夜中的东财红亭/ });
    const galleryTop = await gallery.locator("[data-gallery-scroll]").evaluate(element => Number((element as HTMLElement).dataset.camera));
    await source.click();
    const original = gallery.getByRole("region", { name: "校园照片原图" });
    await loaded(original.getByRole("img")); await expect(original.getByRole("img")).toHaveAttribute("src", /winter-pavilion/);
    await expect(original.getByRole("img")).toHaveCSS("object-fit", "contain");
    await axe(page);
    await page.keyboard.press("Escape"); await expect(original).toHaveCount(0); await settle(page, 25);
    await expect(source).toBeFocused();
    expect(await gallery.locator("[data-gallery-scroll]").evaluate(element => Number((element as HTMLElement).dataset.camera))).toBe(galleryTop);
    await gallery.getByRole("button", { name: "全部照片", exact: true }).click();
    const index = gallery.getByRole("region", { name: "全部校园照片" });
    await expect(index.getByRole("button", { name: /查看第/ })).toHaveCount(26);
    await axe(page);
    const tile = index.getByRole("button", { name: /查看第 3 张/ });
    await tile.click(); await expect(original.getByRole("img")).toHaveAttribute("src", /autumn-avenue/);
    await page.keyboard.press("ArrowRight"); await expect(original.getByRole("img")).toHaveAttribute("src", /spring-magnolia/);
    await page.keyboard.press("Escape"); await expect(original).toHaveCount(0); await expect(tile).toBeFocused();
    await page.keyboard.press("Escape"); await settle(page, 25);
    await exit.click(); await expect(gallery).toHaveCount(0); await expect(opener).toBeFocused();
    await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
    expect(Math.abs(await page.evaluate(() => window.scrollY) - pageTop)).toBeLessThan(2);
    await enter(page); await settle(page, 0); await page.keyboard.press("Escape");
    expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
  });
}

test("all 26 photos lazy-load with full proportions and stay inside the phone viewport", async ({ page }, info) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 }); const checks = await setup(page);
  await expect(page.getByRole("region", { name: "校园相册", exact: true }).locator("img")).toHaveCount(3);
  const { gallery } = await enter(page);
  for (let slot = 0; slot < 26; slot++) {
    if (slot > 0) await page.keyboard.press("ArrowRight");
    await settle(page, slot);
    const active = gallery.locator('button[data-active="true"]');
    await loaded(active.locator("img"));
    const size = await active.boundingBox();
    expect(size!.x).toBeGreaterThanOrEqual(0);
    expect(size!.x + size!.width).toBeLessThanOrEqual(391);
    const ratio = await active.locator("img").evaluate(img => (img as HTMLImageElement).naturalWidth / (img as HTMLImageElement).naturalHeight);
    expect(size!.width / size!.height).toBeCloseTo(ratio, 2);
    const visible = await gallery.locator('[data-gallery-scroll] button[data-visible="true"]').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
    }).sort((a, b) => a.top - b.top));
    for (let index = 1; index < visible.length; index++) expect(visible[index].top - visible[index - 1].bottom).toBeGreaterThan(64);
    expect(await active.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === element;
    })).toBe(true);
    await expect(active.locator("img")).toHaveAttribute("loading", "lazy");
    await expect(active.locator("img")).toHaveCSS("object-fit", "contain");
    await expect(active).toHaveCSS("transition-duration", "0s");
    if ([2, 7, 13, 19].includes(slot)) await gallery.screenshot({ path: info.outputPath("moment-" + slot + "-390.png") });
  }
  await page.keyboard.press("ArrowRight"); await settle(page, 0);
  await page.keyboard.press("ArrowLeft"); await settle(page, 25);

  await page.keyboard.press("Escape"); expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("wheel and touch drive inertial motion without moving the page, rotation retains the photo", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const checks = await setup(page);
  const { gallery } = await enter(page);
  const port = gallery.locator("[data-gallery-scroll]");
  await expect(port).toHaveCSS("touch-action", "pinch-zoom");
  const camera = () => port.evaluate(element => Number((element as HTMLElement).dataset.camera));
  const pageTop = await page.evaluate(() => window.scrollY);
  const before = await camera();
  await page.mouse.move(190, 300); await page.mouse.wheel(0, 1350);
  await expect.poll(camera).toBeGreaterThan(before + 1000);
  await expect(port).toHaveAttribute("data-animating", "false");
  const top = await camera();
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: 620 }] });
  for (const y of [560, 470, 370, 270]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 150, y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await touch.detach();
  await expect.poll(camera).toBeGreaterThan(top + 200);
  await expect(port).toHaveAttribute("data-animating", "false");
  await expect(gallery.getByRole("region", { name: "校园照片原图" })).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageTop);
  await goTo(page, 9);
  await page.setViewportSize({ width: 844, height: 390 }); await settle(page, 9);
  await expect(gallery.getByRole("button", { name: "退出校园漫游" })).toBeInViewport();
  await expect(gallery.getByRole("button", { name: "全部照片", exact: true })).toBeInViewport();
  await axe(page); await page.keyboard.press("Escape"); expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("one short horizontal touch swipe follows the finger and advances a photo on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const checks = await setup(page);
  const { gallery } = await enter(page); await settle(page, 0);
  const port = gallery.locator("[data-gallery-scroll]");
  const camera = () => port.evaluate(element => Number((element as HTMLElement).dataset.camera));
  const initial = await camera(), pageTop = await page.evaluate(() => window.scrollY);
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 245, y: 510 }] });
  for (const x of [225, 205, 175]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 507 }] });
  // Assert motion before release: snapping alone cannot pass this regression.
  await expect.poll(camera).toBeGreaterThan(initial + 100);
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settle(page, 1);
  await expect(gallery.getByRole("region", { name: "校园照片原图" })).toHaveCount(0);

  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 145, y: 510 }] });
  for (const x of [165, 185, 215]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 513 }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touch.detach(); await settle(page, 0);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageTop);
  await expect(gallery.locator("[data-slot]")).toHaveCount(26);
  await page.keyboard.press("Escape");
  expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("a vertical touch gesture on the closed album keeps native page scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const checks = await setup(page);
  const album = page.getByRole("region", { name: "校园相册", exact: true });
  await album.scrollIntoViewIfNeeded();
  const box = (await album.boundingBox())!;
  const y = Math.max(120, Math.min(580, box.y + box.height * .3));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 160, y }] });
  for (const delta of [35, 75, 125]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 162, y: y + delta }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await touch.detach();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(before - 60);
  await expect(page.getByRole("dialog", { name: "校园漫游", exact: true })).toHaveCount(0);
  expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("reduced motion retains short horizontal touch navigation and native vertical scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" }); const checks = await setup(page);
  const { gallery } = await enter(page); await settle(page, 0);
  const port = gallery.locator("[data-gallery-scroll]");
  await expect(port).toHaveCSS("touch-action", "pan-y pinch-zoom");
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 245, y: 510 }] });
  for (const x of [220, 195, 175]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 509 }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await settle(page, 1);
  await expect(gallery.locator('button[data-active="true"]')).toHaveCSS("transform", "none");
  const before = await port.evaluate(element => element.scrollTop);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 155, y: 620 }] });
  for (const y of [575, 520, 470]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 156, y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await touch.detach();
  await expect.poll(() => port.evaluate(element => element.scrollTop)).toBeGreaterThan(before + 70);
  await expect(port).toHaveAttribute("data-animating", "false");
  await page.keyboard.press("Escape");
  expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("reduced motion keeps all 26 originals, without parallax or expansion animation", async ({ page }) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: "reduce" }); const checks = await setup(page);
  const { gallery } = await enter(page);
  await page.keyboard.press("End"); await settle(page, 25);
  await expect(gallery.getByRole("button", { name: /查看原图：雪夜中的东财红亭/ })).toHaveCSS("transform", "none");
  await gallery.getByRole("button", { name: "全部照片", exact: true }).click();
  const index = gallery.getByRole("region", { name: "全部校园照片" });
  for (let number = 1; number <= 26; number++) {
    const tile = index.getByRole("button", { name: new RegExp("查看第 " + number + " 张") });
    await tile.click();
    const original = gallery.getByRole("region", { name: "校园照片原图" });
    await loaded(original.getByRole("img"));
    expect(await original.getByRole("img").evaluate(image => image.getAnimations().length)).toBe(0);
    await page.keyboard.press("Escape"); await expect(original).toHaveCount(0); await expect(tile).toBeFocused();
  }
  await page.keyboard.press("Escape"); await settle(page, 25); await axe(page); await page.keyboard.press("Escape");
  expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("failed photos can be retried and never block exits", async ({ page }) => {
  let fail = true;
  await page.route("**/images/dufe-spring-love-sign.webp", route => fail ? route.abort() : route.continue());
  const checks = await setup(page); const { gallery } = await enter(page);
  const source = gallery.getByRole("button", { name: /查看原图：春日樱花/ });
  await expect(source).toContainText("照片暂时没加载出来"); await source.click();
  const original = gallery.getByRole("region", { name: "校园照片原图" });
  await expect(original.getByRole("button", { name: "重新加载" })).toBeVisible();
  fail = false; await original.getByRole("button", { name: "重新加载" }).click(); await loaded(original.getByRole("img"));
  await page.keyboard.press("Escape"); await expect(original).toHaveCount(0);
  await page.keyboard.press("ArrowRight"); await settle(page, 1);
  await page.keyboard.press("Escape"); await expect(gallery).toHaveCount(0);
  expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("keyboard navigation loops without losing focus and native tab reaches off-screen photos", async ({ page }) => {
  await setup(page); const { gallery } = await enter(page);
  await goTo(page, 25);
  const exit = gallery.getByRole("button", { name: "退出校园漫游" });
  await exit.focus(); await page.keyboard.press("ArrowRight"); await settle(page, 0);
  await expect(exit).toBeFocused();
  const distant = gallery.locator("[data-slot='18'] button");
  await distant.focus(); await settle(page, 18); await expect(distant).toBeInViewport();
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press(index % 2 ? "Shift+Tab" : "Tab");
    expect(await gallery.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
});

test("last index photo returns to its source tile without moving the index", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 }); await setup(page);
  const { gallery } = await enter(page);
  await gallery.getByRole("button", { name: "全部照片", exact: true }).click();
  const index = gallery.getByRole("region", { name: "全部校园照片" });
  const tile = index.getByRole("button", { name: /查看第 26 张/ });
  await tile.scrollIntoViewIfNeeded(); const top = await index.evaluate(element => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await tile.click(); await page.keyboard.press("Escape");
  await expect(gallery.getByRole("region", { name: "校园照片原图" })).toHaveCount(0);
  await expect(tile).toBeFocused(); expect(await index.evaluate(element => element.scrollTop)).toBe(top);
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
});

test("photo expansion morphs from its source and rapid Escape safely returns", async ({ page }, info) => {
  const checks = await setup(page); const { gallery } = await enter(page);
  const source = gallery.getByRole("button", { name: /查看原图：春日樱花/ });
  await loaded(source.locator("img")); await source.click();
  const original = gallery.getByRole("region", { name: "校园照片原图" });
  const image = original.getByRole("img");
  await expect.poll(() => image.evaluate(img => img.getAnimations().length)).toBeGreaterThan(0);
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await expect(original).toHaveCount(0); await expect(source).toBeFocused();
  await source.click(); await loaded(image);
  await expect.poll(() => image.evaluate(img => img.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
  await original.screenshot({ path: info.outputPath("expanded-photo.png") });
  const before = await gallery.locator("[data-gallery-scroll]").evaluate(element => Number((element as HTMLElement).dataset.camera));
  await original.getByRole("button", { name: "回到漫游" }).click(); await expect(original).toHaveCount(0);
  expect(await gallery.locator("[data-gallery-scroll]").evaluate(element => Number((element as HTMLElement).dataset.camera))).toBe(before);
  await expect(source).toBeFocused(); await page.keyboard.press("Escape");
  expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});



test("scroll has measurable inertia, independent speeds, reveal and an uninterrupted loop", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 844 }); const checks = await setup(page);
  const { gallery } = await enter(page); await settle(page, 0);
  const port = gallery.locator("[data-gallery-scroll]");
  await page.mouse.move(640, 350);
  const initialCamera = await port.evaluate(element => Number((element as HTMLElement).dataset.camera));
  const sampling = port.evaluate(async element => {
    const samples: { time: number; camera: number; tops: number[] }[] = [];
    let last = 0;
    for (const time of [0, 100, 300, 750, 1400]) {
      await new Promise(resolve => setTimeout(resolve, time - last)); last = time;
      samples.push({ time, camera: Number((element as HTMLElement).dataset.camera), tops: [...element.querySelectorAll("button")].slice(0, 2).map(photo => photo.getBoundingClientRect().top) });
    }
    return samples;
  });
  await page.mouse.wheel(0, 350);
  const samples = await sampling;
  expect(samples[2].camera - samples[1].camera).toBeGreaterThan(55);
  expect(samples[3].camera - samples[2].camera).toBeGreaterThan(10);
  expect(Math.abs(samples[4].camera - initialCamera - 350)).toBeLessThan(1);
  const fast = Math.abs(samples[2].tops[0] - samples[1].tops[0]);
  const slow = Math.abs(samples[2].tops[1] - samples[1].tops[1]);
  expect(fast / slow).toBeCloseTo(1.3 / .8, 1);
  await info.attach("motion-samples", { body: JSON.stringify(samples, null, 2), contentType: "application/json" });
  await goTo(page, 25);
  const cycle = await port.evaluate(element => Number((element as HTMLElement).dataset.cycle));
  const before = await port.evaluate(element => Number((element as HTMLElement).dataset.camera));
  await page.mouse.wheel(0, cycle);
  await expect(port).toHaveAttribute("data-animating", "false"); await settle(page, 25);
  expect(await port.evaluate(element => Number((element as HTMLElement).dataset.camera))).toBeCloseTo(before + cycle, 0);
  await expect(gallery.locator('button[data-visible="true"]')).not.toHaveCount(0);
  await gallery.screenshot({ path: info.outputPath("after-full-lap.png") });
  await page.keyboard.press("Escape"); expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("My gallery entry responds to both page scroll and pointer, reduced motion stays still", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 }); await setup(page);
  const album = page.getByRole("region", { name: "校园相册", exact: true });
  await album.scrollIntoViewIfNeeded(); await expect(album.locator("button")).toHaveAttribute("data-entered", "true");
  const first = album.locator("[data-slot='0']");
  const before = await first.evaluate(element => getComputedStyle(element).transform);
  await page.mouse.move((await album.boundingBox())!.x + 40, (await album.boundingBox())!.y + 80);
  await expect.poll(() => first.evaluate(element => getComputedStyle(element).transform)).not.toBe(before);
  const pointer = await first.evaluate(element => getComputedStyle(element).transform);
  await page.mouse.move(10, 10); await page.mouse.wheel(0, -180);
  await expect.poll(() => first.evaluate(element => getComputedStyle(element).transform)).not.toBe(pointer);
  await page.emulateMedia({ reducedMotion: "reduce" }); await expect(first).toHaveCSS("transform", "none");
});

test("the whole composition participates in opening and returns even when interrupted", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 844 }); const checks = await setup(page);
  const { gallery } = await enter(page); await settle(page, 0);
  const source = gallery.locator('button[data-active="true"]'); await loaded(source.locator("img"));
  const sourceBox = await source.boundingBox(); await source.click();
  const original = gallery.getByRole("region", { name: "校园照片原图" });
  const image = original.getByRole("img");
  await expect.poll(() => image.evaluate(img => img.getAnimations().some(animation => animation.playState === "running"))).toBe(true);
  await page.waitForTimeout(180); await original.screenshot({ path: info.outputPath("morph-early.png") });
  // Larger thumbnails shorten the zoom. Measure the expanding frame, not the
  // separately scaled inner image, whose crop intentionally eases back to 1.
  const early = await image.locator("..").boundingBox();
  await expect.poll(() => gallery.locator("[data-gallery-scroll] > div").evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(.4);
  await page.waitForTimeout(420); await original.screenshot({ path: info.outputPath("morph-late.png") });
  const late = await image.locator("..").boundingBox(); expect(late!.width).toBeGreaterThan(early!.width + sourceBox!.width * .04);
  expect(sourceBox!.width).toBeLessThan(late!.width);
  await page.keyboard.press("Escape"); await expect(original).toHaveCount(0); await expect(source).toBeFocused();
  await expect(gallery.locator("[data-gallery-scroll] > div")).toHaveCSS("opacity", "1");
  await source.click(); await page.keyboard.press("Escape"); await gallery.getByRole("button", { name: "退出校园漫游" }).click();
  await expect(gallery).toHaveCount(0); expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("reverse input retargets inertia and opening freezes the exact moving source", async ({ page }) => {
  const checks = await setup(page); const { gallery } = await enter(page); await settle(page, 0);
  const port = gallery.locator("[data-gallery-scroll]");
  const camera = () => port.evaluate(element => Number((element as HTMLElement).dataset.camera));
  const initial = await camera(); await page.mouse.move(500, 300);
  await page.mouse.wheel(0, 350); await expect(port).toHaveAttribute("data-animating", "true");
  await page.waitForTimeout(70); await page.mouse.wheel(0, -700);
  await expect(port).toHaveAttribute("data-animating", "false"); expect(await camera()).toBeCloseTo(initial - 350, 0);
  await goTo(page, 0);
  await page.mouse.wheel(0, 240); await page.waitForTimeout(60);
  // A real click can arrive before the scrub stops; freeze the current frame, not its target.
  await gallery.locator("[data-slot='0'] button").evaluate(button => (button as HTMLButtonElement).click());
  const frozen = await camera(); await page.waitForTimeout(1100); expect(await camera()).toBe(frozen);
  await page.keyboard.press("Escape"); await expect(gallery.getByRole("region", { name: "校园照片原图" })).toHaveCount(0);
  expect(await camera()).toBe(frozen); await page.keyboard.press("Escape");
  expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

test("changing reduced motion during a gesture or morph immediately flattens motion", async ({ page }) => {
  await setup(page); const { gallery } = await enter(page);
  const port = gallery.locator("[data-gallery-scroll]");
  await page.mouse.move(500, 300); await page.mouse.wheel(0, 350);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(port).toHaveAttribute("data-motion", "reduced"); await expect(port).toHaveAttribute("data-animating", "false");
  await expect(gallery.locator("[data-slot='0'] button")).toHaveCSS("transform", "none");
  await goTo(page, 9);
  await page.emulateMedia({ reducedMotion: "no-preference" }); await expect(port).toHaveAttribute("data-motion", "loop"); await settle(page, 9);
  await gallery.locator('button[data-active="true"]').click();
  const original = gallery.getByRole("region", { name: "校园照片原图" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => original.getByRole("img").evaluate(image => image.getAnimations().length)).toBe(0);
  await page.keyboard.press("Escape"); await expect(original).toHaveCount(0); await settle(page, 9);
  await page.keyboard.press("Escape");
});

test("campus light follows photographs, glass remains legible and high contrast has a solid fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const checks = await setup(page);
  const { gallery } = await enter(page); await settle(page, 0);
  const atmosphere = gallery.locator("[data-gallery-atmosphere]");
  await expect(atmosphere).toHaveAttribute("aria-hidden", "true");
  const spring = await atmosphere.evaluate(element => getComputedStyle(element).getPropertyValue("--ambient-a"));
  await goTo(page, 2);
  const autumn = await atmosphere.evaluate(element => getComputedStyle(element).getPropertyValue("--ambient-a"));
  expect(autumn).not.toBe(spring);
  const exit = gallery.getByRole("button", { name: "退出校园漫游" });
  await expect(exit).toHaveCSS("backdrop-filter", "blur(18px)");
  await axe(page);
  await page.emulateMedia({ contrast: "more" });
  await expect(atmosphere).toHaveCSS("display", "none");
  await expect(exit).toHaveCSS("backdrop-filter", "none");
  await expect(exit).toHaveCSS("background-color", "rgb(250, 251, 246)");
  await axe(page); await exit.click(); expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
});

