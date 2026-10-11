import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ stdin: { contents: `
 import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
 import { UserRegistration } from './app/admin/UserRegistration.tsx';
 const root = createRoot(document.getElementById('root'));
 window.openDetails = (expiry) => flushSync(() => root.render(React.createElement(UserRegistration, { key: expiry, userId: '00000000-0000-4000-8000-000000000002', elevatedUntil: expiry,
 onClose: () => root.render(null), onExpired: () => { window.expired = true; root.render(null); } })));
 `, resolveDir: root, loader: "tsx" }, bundle: true, write: false, outfile: "registration-test.js", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
const js = bundle.outputFiles.find(x => x.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(x => x.path.endsWith('.css')).text;
const globalCss = ['globals.css', 'product-system.css', 'red-access-system.css'].map(x => readFileSync(new URL(`../app/${x}`, import.meta.url), 'utf8').replace('@import "tailwindcss";', '')).join('\n');
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
const email = 'long.registration.address.1234567890@example.test';
const registration = { username: '测试用户', displayName: '昵称', email, emailVerified: false, schoolAccount: '20260001', schoolAccountVerified: false, avatarUrl: null, registeredVia: 'credential', createdAt: new Date().toISOString(), lastLoginAt: null, role: 'user', status: 'active', profile: { entranceYear: 2026, college: '会计学院', majorId: '会计学', className: '一班', updatedAt: new Date().toISOString() } };
try {
 for (const width of [320, 390, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://registration.test/**', route => route.request().url().includes('/api/') ? route.fulfill({ json: { registration } }) : route.fulfill({ contentType: 'text/html', body: '<html lang="zh-CN"><head><title>注册资料测试</title></head><body><div id="root"></div></body></html>' }));
  await page.goto('https://registration.test/'); await page.addStyleTag({ content: globalCss + css }); await page.addScriptTag({ content: js });
  await page.evaluate(() => window.openDetails(new Date(Date.now() + 60000).toISOString()));
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await expect(page.getByRole('link', { name: '用邮件应用联系' })).toHaveAttribute('href', `mailto:${encodeURIComponent(email)}`);
  if (process.env.ADMIN_SCREENSHOT_DIR) { mkdirSync(process.env.ADMIN_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.ADMIN_SCREENSHOT_DIR}/registration-${width}.png` }); }
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.openDetails(new Date(Date.now() + 700).toISOString()));
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0); assert.equal(await page.evaluate(() => window.expired), true);
  assert.deepEqual(errors, []); await page.close();
 }
 console.log('Registration browser checks passed: 320/390/1280px, full email, overflow, close, expiry cleanup.');
} finally { await browser.close(); }
