import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPersonalSyncMetadata,
  loadPersonalSyncMetadata,
  mergeInitialPersonalState,
  mergePersonalStateThreeWay,
  normalizeAcademicTrainingPlan,
  savePersonalSyncMetadata,
  type PersonalSyncMetadata,
  type PersonalSyncState,
  type AcademicTrainingPlan,
} from "../app/personal-sync.ts";

function state(): PersonalSyncState {
  return {
    profile: null,
    skipped: false,
    plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
    activePlanId: "default",
    activities: [],
    assignments: [],
    academicSnapshots: [],
    trainingPlan: null,
    favoriteRooms: [],
    recentRooms: [],
    preferredTerm: "fall",
    theme: "system",
  };
}

function plan(name = "2026级审计学培养方案"): AcademicTrainingPlan {
  return {
    schemaVersion: 1,
    planNumber: "P2026",
    planName: name,
    majorCode: "120207",
    majorName: "审计学",
    cohortYear: 2026,
    requiredCredits: 160,
    categories: [
      { code: "A", name: "专业必修课", requiredCredits: 80 },
    ],
    courses: [
      {
        courseCode: "31131862",
        courseName: "内部审计",
        categoryCode: "A",
        categoryName: "专业必修课",
        attribute: "required",
        credits: 2,
        replacementCourseCodes: [],
      },
    ],
    importedAt: "2026-10-04T01:02:03.000Z",
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

test("first login keeps the cloud training plan as one verified snapshot", () => {
  const local = state();
  const remote = state();
  local.trainingPlan = plan("本机旧方案");
  remote.trainingPlan = plan("云端新方案");

  const merged = mergeInitialPersonalState(local, remote);
  assert.equal(merged.trainingPlan?.planName, "云端新方案");
});

test("malformed local training-plan data is discarded instead of reaching the UI", () => {
  assert.equal(
    normalizeAcademicTrainingPlan({
      ...plan(),
      courses: [{ ...plan().courses[0], courseCode: "" }],
    }),
    null,
  );
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

test("concurrent training-plan imports report one atomic conflict", () => {
  const base = state();
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.trainingPlan = plan("本机方案");
  remote.trainingPlan = plan("另一设备方案");

  const result = mergePersonalStateThreeWay(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].scope, "trainingPlan");
  assert.equal(result.state.trainingPlan?.planName, "另一设备方案");
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

function syncMetadata(userId: string): PersonalSyncMetadata {
  return {
    schemaVersion: 1,
    userId,
    revision: 3,
    baseState: state(),
    pendingConflicts: [],
    syncedAt: "2026-08-07T00:00:00.000Z",
  };
}

test("sync metadata is isolated by user and account cleanup is scoped", () => {
  const storage = memoryStorage();
  savePersonalSyncMetadata(syncMetadata("user-a"), storage);
  savePersonalSyncMetadata(syncMetadata("user-b"), storage);

  assert.equal(loadPersonalSyncMetadata("user-a", storage)?.userId, "user-a");
  assert.equal(loadPersonalSyncMetadata("user-b", storage)?.userId, "user-b");

  clearPersonalSyncMetadata("user-a", storage);
  assert.equal(loadPersonalSyncMetadata("user-a", storage), null);
  assert.equal(loadPersonalSyncMetadata("user-b", storage)?.userId, "user-b");
});

test("legacy metadata migrates only when it belongs to the active user", () => {
  const storage = memoryStorage();
  storage.setItem(
    "dufesh:personal-sync:v1",
    JSON.stringify(syncMetadata("user-a")),
  );

  assert.equal(loadPersonalSyncMetadata("user-b", storage), null);
  assert.equal(storage.getItem("dufesh:personal-sync:v1") !== null, true);
  assert.equal(loadPersonalSyncMetadata("user-a", storage)?.userId, "user-a");
  assert.equal(storage.getItem("dufesh:personal-sync:v1"), null);
});
