import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPersonalSyncMetadata,
  loadPersonalSyncMetadata,
  loadPersonalSyncRecoveryMetadata,
  mergeBootstrapPersonalState,
  mergeInitialPersonalState,
  mergePersonalStateThreeWay,
  normalizeAcademicTrainingPlan,
  savePersonalSyncMetadata,
  synchronizePersonalState,
  type PersonalSyncMetadata,
  type PersonalSyncState,
  type AcademicTrainingPlan,
} from "../app/personal-sync.ts";
import {
  anonymousPersonalScope,
  isPersonalCloudBootstrapPending,
  migrateLegacyPersonalStorage,
  readPersonalStorage,
  setPersonalCloudBootstrapPending,
  userPersonalScope,
  writePersonalStorage,
} from "../app/personal-storage.ts";

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
    earnedCredits: 96,
    categories: [
      {
        code: "A",
        name: "专业必修课",
        requiredCredits: 80,
        earnedCredits: 52,
        parentCode: null,
      },
      {
        code: "A-1",
        name: "专业基础必修",
        requiredCredits: 20,
        earnedCredits: 18,
        parentCode: "A",
      },
    ],
    courses: [
      {
        courseCode: "31131862",
        courseName: "内部审计",
        categoryCode: "A-1",
        categoryName: "专业基础必修",
        attribute: "required",
        credits: 2,
        completionStatus: "passed",
        completedTerm: "2025-2026学年第二学期",
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

test("training-plan normalization keeps hierarchy, progress, and completion fields", () => {
  const normalized = normalizeAcademicTrainingPlan(plan());
  assert.equal(normalized?.earnedCredits, 96);
  assert.equal(normalized?.categories[1].parentCode, "A");
  assert.equal(normalized?.categories[1].earnedCredits, 18);
  assert.equal(normalized?.courses[0].completionStatus, "passed");
  assert.equal(
    normalized?.courses[0].completedTerm,
    "2025-2026学年第二学期",
  );
});

test("training-plan normalization keeps grouping categories without separate credit rules", () => {
  const source = plan();
  source.categories[1].requiredCredits = null;
  source.categories[1].earnedCredits = null;

  const normalized = normalizeAcademicTrainingPlan(source);

  assert.equal(normalized?.categories[1].requiredCredits, null);
  assert.equal(normalized?.categories[1].earnedCredits, null);
  assert.equal(normalized?.categories[1].parentCode, "A");
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

function populatedState(): PersonalSyncState {
  const value = state();
  value.profile = { entranceYear: 2026, college: "测试学院", majorId: "test-major", className: "test-class" };
  value.plans[0].scheduleIds = ["synthetic-schedule"];
  value.trainingPlan = plan();
  value.academicSnapshots = [{
    schemaVersion: 1,
    id: "2026-2027-fall",
    academicYear: "2026-2027",
    term: "fall",
    termLabel: "第一学期",
    importedAt: "2026-10-11T00:00:00.000Z",
    sections: [{
      id: "synthetic-section", courseCode: "synthetic-course", courseName: "测试课程",
      sectionCode: "01", credits: "2", property: "必修", category: "测试", assessmentType: "考试",
      teachers: ["测试教师"], studyMode: "", selectionStatus: "", meetings: [],
    }],
    exams: [],
  }];
  return value;
}

test("missing account cache after legacy migration downloads without deleting signed-in courses", async (context) => {
  const storage = memoryStorage();
  const original = populatedState();
  const prior = { ...syncMetadata("user-a"), baseState: original };
  storage.setItem("dufesh:student-profile:v2", JSON.stringify(original));
  storage.setItem("dufesh:personal-sync:v1", JSON.stringify(prior));
  migrateLegacyPersonalStorage(storage);
  const local = readPersonalStorage<PersonalSyncState>(storage, userPersonalScope("user-a"));
  const metadata = loadPersonalSyncMetadata("user-a", storage);
  const requests: RequestInit[] = [];
  context.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit = {}) => {
    requests.push(options);
    assert.notEqual(options.method, "PUT");
    return new Response(JSON.stringify({ revision: 3, state: original }));
  });

  const result = await synchronizePersonalState({
    userId: "user-a", localState: local ?? state(), priorMetadata: metadata,
    localStatePresent: local !== null,
  });

  assert.equal(result?.status, "downloaded");
  assert.equal(requests.length, 1);
  assert.deepEqual(result?.state.plans[0].scheduleIds, original.plans[0].scheduleIds);
  assert.equal(result?.state.academicSnapshots[0].sections[0].courseName, "测试课程");
  assert.equal(result?.state.trainingPlan?.planNumber, "P2026");
  assert.equal(readPersonalStorage<PersonalSyncState>(storage, anonymousPersonalScope)?.academicSnapshots.length, 1);
});

test("missing cache with an empty cloud leaves the owned recovery base available without uploading", async (context) => {
  const storage = memoryStorage();
  const prior = { ...syncMetadata("user-a"), baseState: populatedState() };
  savePersonalSyncMetadata(prior, storage);
  context.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit = {}) => {
    assert.notEqual(options.method, "PUT");
    return new Response(JSON.stringify({ revision: 4, state: state() }));
  });
  const result = await synchronizePersonalState({
    userId: "user-a", localState: state(), priorMetadata: prior, localStatePresent: false,
  });
  assert.ok(result);
  savePersonalSyncMetadata(result.metadata, storage);

  assert.equal(loadPersonalSyncMetadata("user-a", storage)?.baseState.academicSnapshots.length, 0);
  assert.equal(loadPersonalSyncRecoveryMetadata("user-a", storage)?.baseState.academicSnapshots.length, 1);
  assert.equal(loadPersonalSyncRecoveryMetadata("user-a", storage)?.baseState.trainingPlan?.planNumber, "P2026");
  assert.equal(loadPersonalSyncRecoveryMetadata("user-b", storage), null);
});

test("an existing cache can still intentionally remove courses through three-way synchronization", async (context) => {
  const original = populatedState();
  const prior = { ...syncMetadata("user-a"), baseState: original };
  const methods: string[] = [];
  context.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit = {}) => {
    methods.push(options.method ?? "GET");
    if (options.method === "PUT") {
      const payload = JSON.parse(options.body as string);
      assert.equal(payload.state.academicSnapshots.length, 0);
      assert.equal(payload.state.trainingPlan, null);
      return new Response(JSON.stringify({ revision: 4, state: payload.state, conflict: false }));
    }
    return new Response(JSON.stringify({ revision: 3, state: original }));
  });
  const result = await synchronizePersonalState({
    userId: "user-a", localState: state(), priorMetadata: prior, localStatePresent: true,
  });

  assert.deepEqual(methods, ["GET", "PUT"]);
  assert.equal(result?.status, "uploaded");
  assert.equal(result?.state.academicSnapshots.length, 0);
});

test("scoped and legacy nonempty synchronization bases survive later empty metadata", () => {
  for (const source of ["dufesh:personal-sync:v1", "dufesh:personal-sync:v2:user:user-a"]) {
    const storage = memoryStorage();
    const prior = { ...syncMetadata("user-a"), baseState: populatedState() };
    storage.setItem(source, JSON.stringify(prior));
    assert.equal(loadPersonalSyncMetadata("user-a", storage)?.revision, 3);
    savePersonalSyncMetadata({ ...syncMetadata("user-a"), revision: 4 }, storage);
    const recovered = loadPersonalSyncRecoveryMetadata("user-a", storage);
    assert.equal(recovered?.revision, 3);
    assert.equal(recovered?.baseState.plans[0].scheduleIds.length, 1);
    assert.equal(recovered?.baseState.trainingPlan?.planNumber, "P2026");
    assert.equal(loadPersonalSyncRecoveryMetadata("user-b", storage), null);
  }
});

test("saving or clearing another account does not discard the legacy owner's synchronization base", () => {
  const storage = memoryStorage();
  const prior = { ...syncMetadata("user-a"), baseState: populatedState() };
  const raw = JSON.stringify(prior);
  storage.setItem("dufesh:personal-sync:v1", raw);
  savePersonalSyncMetadata(syncMetadata("user-b"), storage);
  clearPersonalSyncMetadata("user-b", storage);

  assert.equal(storage.getItem("dufesh:personal-sync:v1"), raw);
  assert.equal(loadPersonalSyncRecoveryMetadata("user-a", storage)?.baseState.academicSnapshots.length, 1);
});

test("account cleanup removes only that account's current and recovery synchronization copies", () => {
  const storage = memoryStorage();
  for (const userId of ["user-a", "user-b"]) {
    savePersonalSyncMetadata({ ...syncMetadata(userId), baseState: populatedState() }, storage);
    savePersonalSyncMetadata({ ...syncMetadata(userId), revision: 4 }, storage);
  }
  clearPersonalSyncMetadata("user-a", storage);

  assert.equal(loadPersonalSyncMetadata("user-a", storage), null);
  assert.equal(loadPersonalSyncRecoveryMetadata("user-a", storage), null);
  assert.equal(loadPersonalSyncMetadata("user-b", storage)?.revision, 4);
  assert.equal(loadPersonalSyncRecoveryMetadata("user-b", storage)?.baseState.academicSnapshots.length, 1);
});

test("empty partial bootstrap defaults preserve the complete cloud course and settings state", () => {
  const cloud = populatedState();
  cloud.plans = [{ id: "cloud-plan", name: "云端主课表", scheduleIds: ["cloud-course"] }];
  cloud.activePlanId = "cloud-plan";
  cloud.preferredTerm = "spring";
  cloud.theme = "night";
  cloud.favoriteRooms = ["cloud-room"];
  cloud.activities = [{ id: "cloud-event", title: "云端日程", weekday: 1, block: 1, location: "", notes: "", color: "red" }];

  const merged = mergeBootstrapPersonalState(state(), cloud);

  assert.deepEqual(merged, cloud);
});

test("partial bootstrap keeps cloud courses while explicit local imports and same-ID records win", () => {
  const cloud = populatedState();
  cloud.plans[0].name = "云端课表名称";
  cloud.activities = [{ id: "same-event", title: "云端旧日程", weekday: 1, block: 1, location: "", notes: "", color: "red" }];
  cloud.assignments = [{ id: "same-task", courseId: "", title: "云端旧作业", dueDate: "2026-10-25", notes: "", completed: false }];
  cloud.preferredTerm = "spring";
  const partial = state();
  partial.plans[0].scheduleIds = ["local-new-course"];
  partial.academicSnapshots = structuredClone(cloud.academicSnapshots);
  partial.academicSnapshots[0].sections[0].courseName = "本机刚导入的新课程";
  partial.academicSnapshots[0].importedAt = "2026-10-12T00:00:00.000Z";
  partial.trainingPlan = plan("本机刚导入的新培养方案");
  partial.activities = [{ ...cloud.activities[0], title: "本机新日程" }];
  partial.assignments = [{ ...cloud.assignments[0], title: "本机新作业", completed: true }];

  const merged = mergeBootstrapPersonalState(partial, cloud);

  assert.deepEqual(merged.plans[0].scheduleIds, ["local-new-course", "synthetic-schedule"]);
  assert.equal(merged.plans[0].name, "云端课表名称");
  assert.equal(merged.academicSnapshots.length, 1);
  assert.equal(merged.academicSnapshots[0].sections[0].courseName, "本机刚导入的新课程");
  assert.equal(merged.trainingPlan?.planName, "本机刚导入的新培养方案");
  assert.equal(merged.activities[0].title, "本机新日程");
  assert.equal(merged.assignments[0].completed, true);
  assert.equal(merged.preferredTerm, "fall");
  assert.equal(cloud.academicSnapshots[0].sections[0].courseName, "测试课程");
});

test("explicit additions survive failed bootstrap, reload, and a later non-destructive cloud merge", async (context) => {
  const storage = memoryStorage();
  const userA = userPersonalScope("user-a"), userB = userPersonalScope("user-b");
  const cloud = populatedState();
  const partial = state();
  partial.activities = [{ id: "offline-event", title: "离线新增日程", weekday: 2, block: 2, location: "", notes: "", color: "blue" }];
  const prior = { ...syncMetadata("user-a"), baseState: cloud };
  let unavailable = true;
  let puts = 0;
  context.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit = {}) => {
    if (unavailable) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    if (options.method === "PUT") {
      puts++;
      const payload = JSON.parse(options.body as string);
      assert.deepEqual(payload.state.plans[0].scheduleIds, cloud.plans[0].scheduleIds);
      assert.equal(payload.state.academicSnapshots[0].sections[0].courseName, "测试课程");
      return new Response(JSON.stringify({ revision: 4, state: payload.state, conflict: false }));
    }
    return new Response(JSON.stringify({ revision: 3, state: cloud }));
  });
  await assert.rejects(synchronizePersonalState({
    userId: "user-a", localState: state(), priorMetadata: prior, localStatePresent: false,
  }), /cloud_sync_read_failed/);
  setPersonalCloudBootstrapPending(storage, userA, true);
  writePersonalStorage(storage, userA, partial);
  const reloaded = readPersonalStorage<PersonalSyncState>(storage, userA)!;
  assert.equal(reloaded.activities[0].title, "离线新增日程");
  assert.equal(readPersonalStorage(storage, userB), null);
  assert.equal(isPersonalCloudBootstrapPending(storage, userB), false);
  unavailable = false;
  const downloaded = await synchronizePersonalState({
    userId: "user-a", localState: reloaded, priorMetadata: prior,
    localStatePresent: !isPersonalCloudBootstrapPending(storage, userA),
  });
  assert.ok(downloaded);
  assert.equal(puts, 0);
  const full = mergeBootstrapPersonalState(reloaded, downloaded.state);
  writePersonalStorage(storage, userA, full);
  setPersonalCloudBootstrapPending(storage, userA, false);
  const uploaded = await synchronizePersonalState({
    userId: "user-a", localState: full, priorMetadata: downloaded.metadata, localStatePresent: true,
  });
  assert.equal(uploaded?.status, "uploaded");
  assert.equal(uploaded?.state.activities[0].title, "离线新增日程");
  assert.equal(puts, 1);
});
