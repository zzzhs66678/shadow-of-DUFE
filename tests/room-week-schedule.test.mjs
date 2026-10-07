import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Load the real TSX without installing a second component-test runtime.
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../app/RoomWeekSchedule.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (name) => name.endsWith(".css")
    ? { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
    : require(name),
  componentModule,
  componentModule.exports,
);
const RoomWeekSchedule = componentModule.exports.default;
const periods = [
  { block: 1, short: "1-2节", time: "08:00-09:30" },
  { block: 2, short: "3-4节", time: "10:00-11:30" },
];
const lesson = (weekday, extra = {}) => ({
  id: `meeting-${weekday}`, title: "同名课程", teacher: "教师甲", weekday,
  block: 1, periodLabel: "1-2节", timeText: "08:00-09:30", ...extra,
});
const render = (props = {}) => renderToStaticMarkup(createElement(RoomWeekSchedule, {
  building: "之远楼", room: "101", date: "2026-10-05", week: 6,
  selectedWeekday: 1, periods, favorite: false,
  onBack() {}, onToggleFavorite() {}, lessons: [], ...props,
}));
const headers = (html) => [...html.matchAll(/role="columnheader">(周.)/g)].map((match) => match[1]);
const workdays = ["周一", "周二", "周三", "周四", "周五"];

test("room timetable defaults to five days, including an entirely empty week", () => {
  const html = render();
  assert.deepEqual(headers(html), workdays);
  assert.match(html, /本周暂无已收录课程/);
  assert.match(html, /aria-colcount="6"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /查看全周/);
  assert.match(html, /返回空教室/);
  assert.match(html, /2026-10-05/);
  assert.match(html, /第 6 教学周/);
  assert.equal((html.match(/role="cell"/g) ?? []).length, periods.length * 5);
});

for (const weekend of [[6], [7], [6, 7]]) {
  test(`only occupied weekend days are added: ${weekend.join(",")}`, () => {
    const html = render({ lessons: weekend.map((day) => lesson(day)) });
    assert.deepEqual(headers(html), [...workdays, ...weekend.map((day) => day === 6 ? "周六" : "周日")]);
    assert.match(html, new RegExp(`aria-colcount="${6 + weekend.length}"`));
    assert.equal((html.match(/<article /g) ?? []).length, weekend.length);
  });
}

for (const selectedWeekday of [6, 7]) {
  test(`selected empty weekend stays visible: ${selectedWeekday}`, () => {
    const html = render({ selectedWeekday });
    const selected = selectedWeekday === 6 ? "周六" : "周日";
    assert.deepEqual(headers(html), [...workdays, selected]);
    assert.match(html, new RegExp(`${selected}<small>所选日期</small>`));
    assert.match(html, new RegExp(`aria-label="${selected}1-2节，无课程"`));
  });
}

test("a selected empty Sunday and an occupied Saturday both remain", () => {
  assert.deepEqual(headers(render({ selectedWeekday: 7, lessons: [lesson(6)] })), [...workdays, "周六", "周日"]);
});

test("same-title meetings stay distinct and all full titles, teachers and times render", () => {
  const title = "跨学科金融风险管理与数据分析专题（全英文教学）";
  const teacher = "教师甲、教师乙、Alexandra Montgomery";
  const lessons = Object.freeze([
    Object.freeze(lesson(1, { id: "separate-section", title, teacher })),
    Object.freeze(lesson(1, { id: "another-section", title, teacher: "教师丙", block: 2 })),
    Object.freeze(lesson(1, { id: "overlapping-section", title: "同一时段另一教学班" })),
    Object.freeze(lesson(7, { title: "", teacher: "", timeText: "" })),
  ]);
  const html = render({ lessons });
  assert.equal((html.match(/<article /g) ?? []).length, 4);
  assert.equal(html.split(title).length - 1, 2);
  assert.ok(html.includes(teacher));
  assert.match(html, /课程名称未提供/);
  assert.match(html, /教师未提供/);
  assert.match(html, /<small>08:00-09:30<\/small>/);
  assert.match(html, /周一1-2节，2 条课程/);
});

test("outside-term dates retain context and back navigation without a misleading timetable", () => {
  const html = render({ week: null, date: "2027-02-01", lessons: [lesson(6)] });
  assert.match(html, /非教学周/);
  assert.match(html, /这天不在本学期内，请返回空教室页换个日期/);
  assert.match(html, /返回空教室/);
  assert.doesNotMatch(html, /role="table"|查看全周|本周暂无已收录课程/);
});

test("room week filtering remains upstream and uses exact effective weeks", () => {
  const parent = readFileSync(new URL("../app/DufeHubV2.tsx", import.meta.url), "utf8");
  assert.match(parent, /const activeThisWeek = [\s\S]*?selectedWeek.state === "active" &&\s*scheduleOccursInWeek\(item, selectedWeek.week\)/);
  assert.match(parent, /<RoomWeekSchedule[\s\S]*?lessons=\{[\s\S]*?\.filter\(activeThisWeek\)/);
  assert.doesNotMatch(source, /slice\(0,\s*\d+\)|line-clamp|text-overflow/);
});
