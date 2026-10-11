import assert from "node:assert/strict";
import test from "node:test";
import { activityBlock, activityListOrder, activityOccursOn, activityStart, activityTimeLabel, activityTimesOverlap, eventWeekDate, validEventDate, validEventTimes } from "../app/personal-events.ts";
import { mergePersonalStateThreeWay, type PersonalActivity, type PersonalSyncState } from "../app/personal-sync.ts";
import { anonymousPersonalScope, readPersonalStorage, writePersonalStorage } from "../app/personal-storage.ts";

const legacy: PersonalActivity = { id: "legacy", title: "例会", weekday: 7, block: 2, location: "", notes: "", color: "red" };
const clock: PersonalActivity = { ...legacy, id: "clock", date: "2026-10-11", repeat: "none", startTime: "12:05", endTime: "12:45" };
function state(activities: PersonalActivity[]): PersonalSyncState {
  return { profile: null, skipped: true, plans: [{ id: "default", name: "默认", scheduleIds: [] }], activePlanId: "default", activities, assignments: [], academicSnapshots: [], trainingPlan: null, favoriteRooms: [], recentRooms: [], preferredTerm: "fall", theme: "system" };
}
test("clock validation rejects missing, malformed, equal, reversed and cross-day times", () => {
  for (const [start, end] of [["", "12:00"], ["8:00", "12:00"], ["24:00", "24:01"], ["12:60", "13:00"], ["12:00", "12:00"], ["23:00", "01:00"]]) assert.equal(validEventTimes(start, end), false);
  assert.equal(validEventTimes("00:00", "23:59"), true);
  assert.equal(validEventDate("2026-02-29"), false);
  assert.equal(validEventDate("2028-02-29"), true);
  assert.equal(validEventDate("0000-01-01"), false);
  assert.equal(validEventDate("2101-01-01"), false);
});
test("date and repeat transitions include weekends without leaking to other weeks", () => {
  assert.equal(activityOccursOn(clock, "2026-10-11"), true);
  assert.equal(activityOccursOn(clock, "2026-10-18"), false);
  assert.equal(activityOccursOn(legacy, "2026-10-04"), true);
  assert.equal(activityOccursOn({ ...clock, repeat: "weekly" }, "2026-10-04"), false);
  assert.equal(activityOccursOn({ ...clock, repeat: "weekly" }, "2026-10-18"), true);
  assert.equal(activityOccursOn({ ...clock, date: "2026-10-10", weekday: 6 }, "2026-10-10"), true);
  assert.equal(eventWeekDate(7, new Date(2026, 9, 7)), "2026-10-11");
});
test("legacy block labels and clock ordering preserve lunch and evening times", () => {
  assert.equal(activityTimeLabel(legacy), "09:55–11:30");
  assert.equal(activityTimeLabel(clock), "12:05–12:45");
  assert.equal(activityBlock("12:05"), 2);
  assert.equal(activityBlock("23:00"), 4);
  assert.ok(activityStart(legacy) < activityStart(clock));
  assert.equal(activityStart({ block: 3, periods: [6, 7] }), 830);
  assert.ok(activityStart({ ...clock, startTime: "13:40" }) < activityStart({ block: 3, periods: [6, 7] }));
  assert.equal(activityTimesOverlap(legacy, clock), false);
  assert.equal(activityTimesOverlap(clock, { ...clock, startTime: "12:45", endTime: "13:00" }), false);
  assert.equal(activityTimesOverlap(clock, { ...clock, startTime: "12:15" }), true);
  assert.ok(activityListOrder(clock) < activityListOrder({ ...clock, startTime: "12:15" }));
});
test("storage refresh round trips old and new records without dropping clock fields", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const original = state([legacy, clock]);
  writePersonalStorage(storage, anonymousPersonalScope, original);
  assert.deepEqual(readPersonalStorage(storage, anonymousPersonalScope), original);
});
test("three-way merge detects time-only and repeat-only conflicts and retains remote clock", () => {
  const base = state([clock, legacy]);
  const local = state([{ ...clock, startTime: "12:10" }, legacy]);
  const remote = state([{ ...clock, repeat: "weekly" }, legacy]);
  const merged = mergePersonalStateThreeWay(base, local, remote);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].scope, "activity");
  assert.deepEqual(merged.state.activities, remote.activities);
  assert.deepEqual(mergePersonalStateThreeWay(base, local, base).state.activities, local.activities);
  const reordered = state([Object.fromEntries(Object.entries(clock).reverse()) as PersonalActivity, legacy]);
  assert.equal(mergePersonalStateThreeWay(base, local, reordered).conflicts.length, 0);
});
