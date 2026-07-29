import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(
  new URL("../app/DufeHubV2.tsx", import.meta.url),
  "utf8",
);
const productStyles = await readFile(
  new URL("../app/product-system.css", import.meta.url),
  "utf8",
);

test("today page keeps the one-glance command deck", () => {
  assert.match(component, /today-command-deck/);
  assert.match(component, /todayAgenda[\s\S]*nextThree/);
  assert.match(component, /campusSuggestion/);
  assert.match(productStyles, /\.now-card/);
  assert.match(productStyles, /\.agenda-glance/);
});

test("course drawer filters and compares teaching sections", () => {
  assert.match(component, /sectionQuery/);
  assert.match(component, /teacherFilter/);
  assert.match(component, /weekFilter/);
  assert.match(component, /buildingFilter/);
  assert.match(component, /conflictFilter/);
  assert.match(component, /compareIds/);
  assert.match(component, /schedulesOverlap/);
  assert.match(component, /scheduleWeeksLabel/);
});

test("mobile timetable offers daily and week views without changing export", () => {
  assert.match(component, /mobileScheduleView/);
  assert.match(component, /mobile-schedule-agenda/);
  assert.match(component, /week-overview-scroll/);
  assert.match(component, /export-canvas/);
  assert.match(productStyles, /\.timetable-panel\.export-canvas \.week-grid/);
});
