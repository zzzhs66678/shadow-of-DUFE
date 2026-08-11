import assert from "node:assert/strict";
import test from "node:test";
import { createCourseCatalogId } from "../scripts/course-catalog-id.mjs";

const schedules = [
  {
    id: "fall-C1-01-1",
    sectionId: "fall-C1-01-1",
    term: "fall",
    sourceRow: "2",
    generatedAt: "2026-08-11T00:00:00.000Z",
    courseId: "C1",
    title: "Course one",
    teacher: "Teacher one",
    weekday: 1,
    block: 1,
    periods: [1, 2],
    weeks: [1, 2, 3],
    building: "Zhiyuan Building",
    room: "101",
    classNames: "Test class",
    linked: true,
  },
  {
    id: "fall-C2-01-2",
    sectionId: "fall-C2-01-2",
    term: "fall",
    sourceRow: "3",
    generatedAt: "2026-08-11T00:00:00.000Z",
    courseId: "C2",
    title: "Course two",
    teacher: "",
    weekday: 2,
    block: 2,
    periods: [3, 4],
    weeks: [1, 3],
    building: "Duxing Building",
    room: "201",
    classNames: "",
    linked: false,
  },
];

test("course catalog ID is deterministic and changes with identity facts", () => {
  const first = createCourseCatalogId(schedules);
  const reordered = createCourseCatalogId([schedules[1], schedules[0]]);
  assert.match(first, /^course-v1:[0-9a-f]{64}$/u);
  assert.equal(reordered, first);
  assert.notEqual(
    createCourseCatalogId([
      { ...schedules[0], teacher: "Teacher two" },
      schedules[1],
    ]),
    first,
  );
  assert.notEqual(
    createCourseCatalogId([
      { ...schedules[0], room: "102" },
      schedules[1],
    ]),
    first,
  );
  assert.notEqual(
    createCourseCatalogId([
      { ...schedules[0], weeks: [1, 2] },
      schedules[1],
    ]),
    first,
  );
  assert.equal(
    createCourseCatalogId([
      { ...schedules[0], generatedAt: "2030-01-01T00:00:00.000Z", sourceRow: "999" },
      schedules[1],
    ]),
    first,
  );
});

test("course catalog ID rejects incomplete or duplicate schedules", () => {
  assert.throws(() => createCourseCatalogId([]), /at least one schedule/u);
  assert.throws(
    () => createCourseCatalogId([schedules[0], schedules[0]]),
    /duplicate schedule IDs/u,
  );
});
