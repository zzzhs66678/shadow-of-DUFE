import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeInitialPersonalState,
  mergePersonalStateThreeWay,
  type PersonalSyncState,
} from "../app/personal-sync.ts";

function state(): PersonalSyncState {
  return {
    profile: null,
    skipped: false,
    plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
    activePlanId: "default",
    activities: [],
    assignments: [],
    favoriteRooms: [],
    recentRooms: [],
    preferredTerm: "fall",
    theme: "system",
  };
}

test("first login keeps unique local records without replacing cloud records", () => {
  const local = state();
  local.plans[0].scheduleIds = ["schedule-local-default"];
  local.plans.push({
    id: "local-plan",
    name: "蹭课",
    scheduleIds: ["schedule-local"],
  });
  local.activities.push({
    id: "activity-local",
    title: "社团例会",
    weekday: 2,
    block: 4,
    location: "",
    notes: "",
    color: "amber",
  });

  const remote = state();
  remote.plans[0].scheduleIds = ["schedule-cloud"];
  remote.assignments.push({
    id: "assignment-cloud",
    courseId: "course-cloud",
    title: "云端作业",
    dueDate: "2026-08-01",
    notes: "",
    completed: false,
  });

  const merged = mergeInitialPersonalState(local, remote);
  assert.deepEqual(merged.plans[0].scheduleIds, [
    "schedule-cloud",
    "schedule-local-default",
  ]);
  assert.equal(merged.plans[1].id, "local-plan");
  assert.equal(merged.activities[0].id, "activity-local");
  assert.equal(merged.assignments[0].id, "assignment-cloud");
});

test("three-way merge combines changes made on different devices", () => {
  const base = state();
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.activities.push({
    id: "activity-local",
    title: "本地日程",
    weekday: 1,
    block: 1,
    location: "",
    notes: "",
    color: "red",
  });
  remote.assignments.push({
    id: "assignment-remote",
    courseId: "",
    title: "云端任务",
    dueDate: "2026-08-02",
    notes: "",
    completed: false,
  });

  const result = mergePersonalStateThreeWay(base, local, remote);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.state.activities.length, 1);
  assert.equal(result.state.assignments.length, 1);
});

test("three-way merge preserves deletion when the other side is unchanged", () => {
  const base = state();
  base.activities.push({
    id: "activity-delete",
    title: "待删除",
    weekday: 1,
    block: 1,
    location: "",
    notes: "",
    color: "red",
  });
  const local = structuredClone(base);
  local.activities = [];
  const remote = structuredClone(base);

  const result = mergePersonalStateThreeWay(base, local, remote);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.state.activities.length, 0);
});

test("same-record concurrent edits are reported and keep the cloud copy visible", () => {
  const base = state();
  base.assignments.push({
    id: "assignment-shared",
    courseId: "",
    title: "原始标题",
    dueDate: "2026-08-02",
    notes: "",
    completed: false,
  });
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.assignments[0].title = "本地修改";
  remote.assignments[0].title = "另一设备修改";

  const result = mergePersonalStateThreeWay(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].scope, "assignment");
  assert.equal(result.state.assignments[0].title, "另一设备修改");
  assert.equal(
    (result.conflicts[0].local as { title: string }).title,
    "本地修改",
  );
});
