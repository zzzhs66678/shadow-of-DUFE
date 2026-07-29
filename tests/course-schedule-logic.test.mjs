import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractMeetingTimes,
  occursInWeek,
  parseWeeks,
  splitMeetingLocations,
} from "../scripts/course-schedule-logic.mjs";

test("splits every meeting while preserving commas inside week expressions", () => {
  const value =
    "5-8周 星期五 第8-9节,1-4,9-18周 星期五 第1-2节,1-18周 星期一 第1-2节";
  assert.deepEqual(extractMeetingTimes(value), [
    "5-8周 星期五 第8-9节",
    "1-4,9-18周 星期五 第1-2节",
    "1-18周 星期一 第1-2节",
  ]);
  assert.deepEqual(
    splitMeetingLocations(
      "校本部之远楼(5＃)103,校本部之远楼(5＃)407,校本部笃行楼205",
    ),
    [
      "校本部之远楼(5＃)103",
      "校本部之远楼(5＃)407",
      "校本部笃行楼205",
    ],
  );
});

test("keeps 1-9, 9-18 and 1-18 week ranges distinct", () => {
  const firstHalf = parseWeeks("1-9周 星期一 第1-2节");
  const secondHalf = parseWeeks("9-18周 星期一 第1-2节");
  const fullTerm = parseWeeks("1-18周 星期一 第1-2节");

  assert.deepEqual(firstHalf, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(secondHalf, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.equal(fullTerm.length, 18);
  assert.equal(occursInWeek(firstHalf, 10), false);
  assert.equal(occursInWeek(secondHalf, 9), true);
  assert.equal(occursInWeek(fullTerm, 18), true);
});

test("generated data preserves teachers, sections and all meetings", async () => {
  const raw = await readFile(
    new URL("../public/data/course-data.json", import.meta.url),
    "utf8",
  );
  const data = JSON.parse(raw);
  const section = data.schedules.filter(
    (item) =>
      item.title === "税收制度" &&
      item.teacher === "蔡楠" &&
      item.classNames.includes("财政2401"),
  );
  const teachers = new Set(
    data.schedules
      .filter((item) => item.title === "中国税收")
      .map((item) => item.teacher),
  );

  assert.equal(section.length, 2);
  assert.equal(new Set(section.map((item) => item.sectionId)).size, 1);
  assert.deepEqual(
    section.map((item) => [item.weekday, item.periods]),
    [
      [1, [1, 2]],
      [3, [5, 6]],
    ],
  );
  assert.ok(teachers.size > 3);
  assert.equal(data.quality.sourceScheduleRows, 4537);
  assert.equal(data.quality.multiMeetingRows, 831);
  assert.equal(data.schedules.length, 5417);
  assert.ok(
    data.schedules.every(
      (item) =>
        item.sectionId &&
        item.teacher !== undefined &&
        Array.isArray(item.weeks) &&
        item.weeks.length > 0,
    ),
  );
});
