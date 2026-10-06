// Isolated, real React + CSS browser regression. No app server, deployment,
// catalogue mutation or writes outside optional screenshots are needed.
// node tests/room-week-schedule.browser.mjs
// ROOM_WEEK_SCREENSHOT_DIR may point to an existing artifact directory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import RoomWeekSchedule from "./app/RoomWeekSchedule.tsx";
      const root = createRoot(document.getElementById("root"));
      window.backCount = 0;
      window.favoriteCount = 0;
      window.renderRoomSchedule = (props) => flushSync(() => root.render(
        React.createElement(RoomWeekSchedule, {
          ...props,
          onBack: () => window.backCount++,
          onToggleFavorite: () => window.favoriteCount++,
        })
      ));
    `,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true, write: false, outfile: "room-week-test.js", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const moduleCss = bundle.outputFiles.find((file) => file.path.endsWith(".css")).text;
// Include the current app cascade read-only, without Tailwind's build directive.
const globalCss = ["globals.css", "product-system.css", "red-access-system.css"]
  .map((name) => readFileSync(join(root, "app", name), "utf8").replace('@import "tailwindcss";', ""))
  .join("\n");
const catalogue = JSON.parse(readFileSync(join(root, "public/data/course-data.json"), "utf8"));
const baseProps = {
  building: "之远楼", room: "101", date: "2026-10-05", week: 6, selectedWeekday: 1,
  periods: catalogue.periods, favorite: false, lessons: [],
};
const lesson = (weekday, extra = {}) => {
  const period = catalogue.periods.find((item) => item.block === extra.block) ?? catalogue.periods[0];
  return {
    id: `meeting-${weekday}`, title: "国际金融理论与政策（双语教学）", teacher: "王老师、Alexandra Montgomery",
    weekday, block: period.block, periodLabel: period.short, timeText: period.time, ...extra,
  };
};
const workdays = ["周一", "周二", "周三", "周四", "周五"];
const browser = await chromium.launch({ channel: process.env.CI ? undefined : "chrome" });
let checks = 0;

async function checkLayout(page, props, days) {
  const schedule = page.locator("#room-week-schedule");
  await expect(schedule.getByRole("columnheader")).toHaveCount(days.length + 1);
  await expect(schedule.getByRole("table")).toHaveAttribute("aria-colcount", String(days.length + 1));
  assert.deepEqual(await schedule.getByRole("columnheader").allTextContents(), [
    "节次", ...days.map((label) => label + (label === ["", ...workdays, "周六", "周日"][props.selectedWeekday] ? "所选日期" : "")),
  ]);
  await expect(schedule.locator("article")).toHaveCount(props.lessons.length);
  for (const item of props.lessons) {
    await expect(schedule.locator("article strong").filter({ hasText: item.title })).not.toHaveCount(0);
    await expect(schedule.locator("article span").filter({ hasText: item.teacher })).not.toHaveCount(0);
  }
  const clipped = await schedule.evaluate((element) => {
    const violations = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) violations.push("page overflow");
    for (const node of element.querySelectorAll("[role=region], [role=table], [role=cell], article, article > *, h2, [role=columnheader]")) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (node.scrollWidth > node.clientWidth + 1) violations.push(`horizontal: ${node.tagName} ${node.textContent}`);
      if (node.scrollHeight > node.clientHeight + 1) violations.push(`vertical: ${node.tagName} ${node.textContent}`);
      if (rect.left < -1 || rect.right > innerWidth + 1) violations.push(`outside viewport: ${node.tagName}`);
      if (style.textOverflow === "ellipsis" || !["none", "", "0"].includes(style.webkitLineClamp)) violations.push(`truncated: ${node.tagName}`);
    }
    return violations;
  });
  assert.deepEqual(clipped, []);
  checks++;
}

try {
  for (const width of [320, 390, 680, 840, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body class="hub-v2"><main id="root" class="page-wrap rooms-page living-spaces rooms-v5 room-week-focus"></main></body></html>');
    await page.addStyleTag({ content: `* { box-sizing: border-box; } body { margin: 0; } ${globalCss}\n${moduleCss}` });
    await page.addScriptTag({ content: script });
    const render = async (props) => {
      await page.evaluate((value) => window.renderRoomSchedule(value), props);
      await page.evaluate(() => document.fonts.ready);
    };
    const shots = process.env.ROOM_WEEK_SCREENSHOT_DIR;
    const screenshot = async (name) => {
      if (shots && [390, 1280].includes(width)) await page.screenshot({ path: join(shots, `room-week-${width}-${name}.png`), fullPage: true });
    };
    let props = { ...baseProps, lessons: [lesson(1), lesson(1, { id: "second-section", title: "同一时段的另一教学班", teacher: "李老师" }), lesson(5, { block: catalogue.periods.at(-1).block })] };
    await render(props);
    await checkLayout(page, props, workdays);
    await screenshot("five-days");
    const expand = page.getByRole("button", { name: "查看全周", exact: true });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expand.focus();
    await page.keyboard.press("Enter");
    const collapse = page.getByRole("button", { name: "收起空白周末", exact: true });
    await expect(collapse).toBeFocused();
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await checkLayout(page, props, [...workdays, "周六", "周日"]);
    await screenshot("full-week");
    await collapse.click();
    await checkLayout(page, props, workdays);

    for (const weekend of [[6], [7], [6, 7]]) {
      props = { ...baseProps, lessons: [...baseProps.periods.map((period) => lesson(1, { id: `block-${period.block}`, block: period.block })), ...weekend.map((day) => lesson(day))] };
      await render(props);
      await checkLayout(page, props, [...workdays, ...weekend.map((day) => day === 6 ? "周六" : "周日")]);
      if (weekend.length === 1) {
        await page.getByRole("button", { name: "查看全周", exact: true }).click();
        await checkLayout(page, props, [...workdays, "周六", "周日"]);
        await page.getByRole("button", { name: "收起空白周末", exact: true }).click();
        await checkLayout(page, props, [...workdays, weekend[0] === 6 ? "周六" : "周日"]);
      }
      if (weekend.length === 2) await screenshot("occupied-weekends");
    }
    for (const day of [6, 7]) {
      props = { ...baseProps, selectedWeekday: day, date: day === 6 ? "2026-10-10" : "2026-10-11" };
      await render(props);
      await checkLayout(page, props, [...workdays, day === 6 ? "周六" : "周日"]);
      await expect(page.getByText("本周暂无已收录课程。")).toBeVisible();
      await page.getByRole("button", { name: "查看全周", exact: true }).click();
      await checkLayout(page, props, [...workdays, "周六", "周日"]);
      await page.getByRole("button", { name: "收起空白周末", exact: true }).click();
      await checkLayout(page, props, [...workdays, day === 6 ? "周六" : "周日"]);
    }
    // Prop changes must re-evaluate weekends; no stale columns from earlier weeks.
    props = { ...baseProps, week: 10, date: "2026-11-02", lessons: [lesson(2)] };
    await render(props);
    await checkLayout(page, props, workdays);
    await expect(page.getByText("第 10 教学周", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /设为常用/ }).click();
    await page.getByRole("button", { name: /返回空教室/ }).click();
    assert.deepEqual(await page.evaluate(() => [window.backCount, window.favoriteCount]), [1, 1]);
    await render({ ...props, favorite: true, week: null });
    await expect(page.getByRole("button", { name: /已收藏/ })).toBeVisible();
    await expect(page.getByText(/所选日期不在当前学期教学周内/)).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "查看全周", exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, adaptiveColumns: true, fullText: true, noOverflow: true, selectedWeekendPreserved: true }));
    await page.close();
  }
  console.log(`Room timetable browser checks passed: ${checks}`);
} finally {
  await browser.close();
}
