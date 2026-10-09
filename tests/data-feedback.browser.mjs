import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ stdin: { contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
  import {DataFeedback} from './app/DataFeedback.tsx';
  import {MyDataFeedback} from './app/feedback/MyDataFeedback.tsx';
  import {AdminDataFeedback} from './app/feedback/AdminDataFeedback.tsx';
  const root=createRoot(document.getElementById('root'));
  window.renderFeedback=(mode='course')=>flushSync(()=>root.render(mode==='admin' ? <AdminDataFeedback key={mode}/> : mode==='mine' ? <MyDataFeedback key={mode}/> : <DataFeedback key={mode} target={mode==='room' ? {type:'room',room:'之远楼|1010'} : mode==='material' ? {type:'material',materialId:'296a21c75a1a00ba39a4'} : {type:'course',courseId:'21040022',meetingId:'fall-21040022-01-1'}}/>));
`, loader: "tsx", resolveDir: root }, bundle: true, write: false, outfile: "data-feedback-test.js", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  // Component-only harness: test link destinations as native anchors, without Next's router runtime.
  plugins: [{ name: "native-test-links", setup(build) {
    build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next/link", namespace: "test-link" }));
    build.onLoad({ filter: /.*/, namespace: "test-link" }, () => ({ contents: "import React from 'react'; export default function Link({href,children,...props}) {return React.createElement('a',{href,...props},children);}", loader: "js", resolveDir: root }));
  } }],
});
const js = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find(file => file.path.endsWith(".css")).text;
const globalCss = ["globals.css", "product-system.css", "red-access-system.css"].map(file => readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8").replace('@import "tailwindcss";', "")).join("\n");
const receipt = { id: "00000000-0000-4000-8000-000000000099", type: "course", courseId: "21040022", meetingId: "fall-21040022-01-1", materialId: null, room: null,
  path: "/?view=courses&course=21040022&meeting=fall-21040022-01-1", message: "此教学班教室与公开信息不一致，请核对。", status: "open", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const browser = await chromium.launch({ channel: process.env.CI ? undefined : "chrome" });
let checks = 0;
try {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors = []; const submissions = []; const updates = [];
    page.on("pageerror", error => errors.push(error.message));
    let anonymous = false, postMode = "failure", adminDenied = false;
    let elevatedUntil = new Date(Date.now() + 120000).toISOString();
    let current = { ...receipt };
    const logs = [];
    await page.route("https://feedback.test/**", async route => {
      const req = route.request(); const url = new URL(req.url());
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="zh-CN"><head><title>反馈专项测试</title></head><body><div id="root"></div></body></html>' });
      if (url.pathname === "/api/auth/data-feedback/session") return route.fulfill({ status: anonymous ? 401 : 200, json: anonymous ? { error: "authentication_required" } : { authenticated: true } });
      if (req.method() === "POST") {
        submissions.push(req.postDataJSON());
        if (postMode === "failure") return route.fulfill({ status: 503, json: { error: "service_unavailable" } });
        if (postMode === "invalid") return route.fulfill({ json: { ok: true } });
        return route.fulfill({ status: 201, json: { feedback: { ...receipt, ...req.postDataJSON() }, created: true } });
      }
      if (url.pathname.startsWith("/api/admin/")) {
        if (adminDenied) return route.fulfill({ status: 403, json: { error: "admin_mfa_required" } });
        if (req.method() === "PATCH") {
          const data = req.postDataJSON(); updates.push(data);
          logs.push({ id: String(logs.length + 1), fromStatus: current.status, toStatus: data.status, version: current.version + 1, note: data.note, createdAt: new Date().toISOString() });
          current = { ...current, status: data.status, version: current.version + 1 };
          return route.fulfill({ json: { feedback: current, elevatedUntil } });
        }
        if (url.pathname.endsWith(receipt.id)) return route.fulfill({ json: { feedback: { ...current, actions: logs }, elevatedUntil } });
        return route.fulfill({ json: { items: url.searchParams.get("status") === current.status ? [current] : [], nextCursor: null, elevatedUntil } });
      }
      return route.fulfill({ status: anonymous ? 401 : 200, json: anonymous ? { error: "authentication_required" } : { items: [current], nextCursor: null } });
    });
    await page.goto("https://feedback.test/?password=not-to-submit#cookie-not-to-submit");
    await page.addStyleTag({ content: globalCss + css }); await page.addScriptTag({ content: js });
    assert.deepEqual(errors, []);
    // Deliberately poison ambient storage/cookies: the feedback flow must never read them.
    await page.evaluate(() => {
      Storage.prototype.getItem = () => { throw new Error("feedback read personal storage"); };
      Object.defineProperty(document, "cookie", { get() { throw new Error("feedback read cookie"); } });
      window.renderFeedback();
    });
    await page.getByRole("button", { name: "课程信息：反馈问题" }).click();
    await expect(page.getByRole("textbox")).toBeEnabled();
    await page.getByRole("textbox").fill(receipt.message);
    assert.equal(submissions.length, 0);
    await page.getByRole("button", { name: "提交反馈", exact: true }).focus(); await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "课程信息：反馈问题" })).toBeFocused();
    await page.getByRole("button", { name: "课程信息：反馈问题" }).click();
    await expect(page.getByRole("textbox")).toBeEnabled(); await page.getByRole("textbox").fill(receipt.message);
    await page.getByRole("button", { name: "提交反馈", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("未能确认结果"); await expect(page.getByText("反馈已收到", { exact: true })).toHaveCount(0);
    assert.equal(submissions.length, 1); assert.deepEqual(Object.keys(submissions[0]).sort(), ["type", "courseId", "meetingId", "materialId", "room", "path", "message", "requestKey"].sort());
    assert.equal(JSON.stringify(submissions[0]).includes("not-to-submit"), false);
    postMode = "invalid"; await page.getByRole("button", { name: "提交反馈", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("未能确认结果"); assert.equal(submissions[1].requestKey, submissions[0].requestKey);
    postMode = "success"; await page.getByRole("button", { name: "提交反馈", exact: true }).click();
    await expect(page.getByText("反馈已收到", { exact: true })).toBeVisible(); assert.equal(submissions[2].requestKey, submissions[0].requestKey);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const violations = (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.filter(v => ["serious", "critical"].includes(v.impact));
    assert.deepEqual(violations.map(v => v.id), []);
    if (process.env.FEEDBACK_SCREENSHOT_DIR) { mkdirSync(process.env.FEEDBACK_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.FEEDBACK_SCREENSHOT_DIR}/receipt-${width}.png` }); }
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    anonymous = true; await page.getByRole("button", { name: "课程信息：反馈问题" }).click();
    await expect(page.getByRole("link", { name: "去登录" })).toHaveAttribute("href", "/?view=me#account-center-title");
    await expect(page.getByRole("button", { name: "提交反馈", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); anonymous = false;
    for (const type of ["room", "material"]) {
      await page.evaluate(type => window.renderFeedback(type), type);
      await page.getByRole("button", { name: /反馈问题/u }).click();
      await expect(page.getByRole("textbox")).toBeEnabled(); await page.getByRole("textbox").fill("公开信息需要核对");
      await page.getByRole("button", { name: "提交反馈", exact: true }).click();
      await expect(page.getByText("反馈已收到", { exact: true })).toBeVisible(); assert.equal(submissions.at(-1).type, type);
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => window.renderFeedback("mine"));
    await expect(page.getByText(receipt.message, { exact: true })).toBeVisible();
    anonymous = true; await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByRole("link", { name: "去登录" })).toBeVisible(); await expect(page.getByText(receipt.message, { exact: true })).toHaveCount(0);
    anonymous = false; adminDenied = true; await page.evaluate(() => window.renderFeedback("admin"));
    await expect(page.getByRole("alert")).toContainText("二次验证"); await expect(page.getByText(receipt.message, { exact: true })).toHaveCount(0);
    adminDenied = false; await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByRole("button", { name: "查看与处理", exact: true }).click();
    await expect(page.getByRole("region", { name: "反馈详情" })).toBeVisible();
    await page.getByRole("textbox").fill("核对原始公开记录后已修正。");
    assert.equal(updates.length, 0); await page.getByRole("button", { name: "标为已处理", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("处理记录已保存");
    await page.getByRole("combobox").selectOption("resolved"); await page.getByRole("button", { name: "查看与处理", exact: true }).click();
    await expect(page.getByRole("region", { name: "反馈详情" }).getByRole("listitem")).toContainText("核对原始公开记录后已修正。");
    assert.equal(updates[0].version, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const adminViolations = (await new AxeBuilder({ page }).analyze()).violations.filter(v => ["serious", "critical"].includes(v.impact));
    assert.deepEqual(adminViolations.map(v => v.id), []);
    if (process.env.FEEDBACK_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FEEDBACK_SCREENSHOT_DIR}/admin-${width}.png`, fullPage: true });
    elevatedUntil = new Date(Date.now() + 1000).toISOString(); await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("验证已过期");
    await expect(page.getByText(receipt.message, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "反馈详情" })).toHaveCount(0);
    assert.deepEqual(errors, []); await context.close(); checks++;
  }
  console.log(`Feedback browser checks passed at ${checks} widths: explicit submit, focus/Escape, login, no ambient secrets, retries, real receipts, owner clearing, MFA/expiry, resolution log, overflow and axe.`);
} finally { await browser.close(); }
