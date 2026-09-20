// Targeted local browser check: npm run build && npm start, then node tests/ui-refinement.browser.mjs.
// No production requests or writes. Course expectations come from the shipped local catalogue.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const catalogue = JSON.parse(readFileSync(new URL('../public/data/course-data.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
const base = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
try {
  for (const width of [390, 840, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-09-20T10:00:00+08:00') });
    await page.route('**/api/auth/session', route => route.fulfill({ json: { authenticated: false } }));
    await page.addInitScript(() => localStorage.setItem('dufesh:student-profile:v3:anonymous', JSON.stringify({
      profile: null, skipped: true, plans: [{ id: 'default', name: '默认课表', scheduleIds: [] }],
      activePlanId: 'default', activities: [], assignments: [], favoriteRooms: [], recentRooms: [],
    })));
    await page.goto(base);
    const setup = page.getByRole('button', { name: '设置我的课表', exact: true });
    await setup.waitFor();
    assert.equal(await setup.count(), 1);
    assert.ok((await setup.boundingBox()).y < 750, 'primary action should not be below the first screen');
    const description = await page.locator('.now-card > div').boundingBox();
    assert.ok((await page.locator('.now-card > footer').boundingBox()).y >= description.y + description.height - 1, 'actions must not overlap the description');
    assert.equal(await page.locator('.agenda-glance').count(), 0, 'do not repeat an empty daily agenda');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await setup.click();
    await page.getByRole('button', { name: '暂时跳过', exact: true }).waitFor();
    await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
    await page.goto(`${base}/?view=rooms`);
    await page.locator('.floor-rooms-v5 button').first().click();
    await page.getByRole('link', { name: '查看这一周的课表 ↓' }).click();
    const schedule = page.locator('#room-week-schedule');
    await schedule.getByRole('group', { name: '按星期查看课程' }).waitFor();
    assert.equal(await schedule.locator('h4').count(), 1, 'start with one day, not a seven-day wall');
    const [building, room] = (await schedule.locator('h3').innerText()).split(' ');
    const expected = catalogue.schedules.filter(item => item.term === 'fall' && item.building === building && item.room === room && item.weeks.includes(3));
    await schedule.getByRole('button', { name: /^周一，/ }).click();
    assert.equal(await schedule.locator('li').count(), expected.filter(item => item.weekday === 1).length);
    await schedule.getByRole('button', { name: '显示整周', exact: true }).click();
    assert.equal(await schedule.locator('h4').count(), 7);
    assert.equal(await schedule.locator('li').count(), expected.length);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, primaryAction: true, dayAndWeekSwitch: true, lessons: expected.length, noOverflow: true }));
    await page.close();
  }
} finally { await browser.close(); }
