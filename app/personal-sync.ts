export type PersonalProfile = {
  entranceYear: number;
  college: string;
  majorId: string;
  className: string;
};

export type PersonalPlan = {
  id: string;
  name: string;
  scheduleIds: string[];
};

export type PersonalActivity = {
  id: string;
  title: string;
  weekday: number;
  block: number;
  location: string;
  notes: string;
  color: "red" | "blue" | "green" | "amber";
};

export type PersonalAssignment = {
  id: string;
  courseId: string;
  title: string;
  dueDate: string;
  notes: string;
  completed: boolean;
};

export type AcademicMeeting = {
  id: string;
  weekday: number;
  periods: number[];
  block: number;
  weeks: number[];
  weekText: string;
  timeText: string;
  campus: string;
  building: string;
  room: string;
};

export type AcademicSection = {
  id: string;
  courseCode: string;
  courseName: string;
  sectionCode: string;
  credits: string;
  property: string;
  category: string;
  assessmentType: string;
  teachers: string[];
  studyMode: string;
  selectionStatus: string;
  meetings: AcademicMeeting[];
};

export type AcademicExam = {
  id: string;
  courseCode: string;
  courseName: string;
  sectionCode: string;
  examType: string;
  date: string;
  startTime: string;
  endTime: string;
  campus: string;
  building: string;
  room: string;
  location: string;
  seat: string;
  examNumber?: string;
  status: string;
};

export type AcademicSnapshot = {
  schemaVersion: 1;
  id: string;
  academicYear: string;
  term: "fall" | "spring";
  termLabel: string;
  importedAt: string;
  sections: AcademicSection[];
  exams: AcademicExam[];
};

export type AcademicTrainingPlanCategory = {
  code: string;
  name: string;
  requiredCredits: number | null;
  earnedCredits?: number | null;
  parentCode?: string | null;
};

export type AcademicTrainingPlanCourse = {
  courseCode: string;
  courseName: string;
  categoryCode: string;
  categoryName: string;
  attribute: "required" | "limited" | "elective" | "unknown";
  credits: number | null;
  completionStatus?: "passed" | "in_progress" | "failed" | "not_taken" | "unknown";
  completedTerm?: string;
  replacementCourseCodes: string[];
};

export type AcademicTrainingPlan = {
  schemaVersion: 1;
  planNumber: string;
  planName: string;
  majorCode: string;
  majorName: string;
  cohortYear: number;
  requiredCredits: number;
  earnedCredits?: number | null;
  categories: AcademicTrainingPlanCategory[];
  courses: AcademicTrainingPlanCourse[];
  importedAt: string;
};

export type PersonalSyncState = {
  profile: PersonalProfile | null;
  skipped: boolean;
  plans: PersonalPlan[];
  activePlanId: string;
  activities: PersonalActivity[];
  assignments: PersonalAssignment[];
  academicSnapshots: AcademicSnapshot[];
  trainingPlan: AcademicTrainingPlan | null;
  favoriteRooms: string[];
  recentRooms: string[];
  preferredTerm: "fall" | "spring";
  theme: "system" | "day" | "night";
};

export type PersonalSyncConflict = {
  scope:
    | "profile"
    | "plan"
    | "activity"
    | "assignment"
    | "academic"
    | "trainingPlan"
    | "settings";
  id?: string;
  local: unknown;
  remote: unknown;
};

export type PersonalSyncMetadata = {
  schemaVersion: 1;
  userId: string;
  revision: number;
  baseState: PersonalSyncState;
  pendingConflicts: PersonalSyncConflict[];
  syncedAt: string;
};

export type PersonalSyncResult = {
  state: PersonalSyncState;
  metadata: PersonalSyncMetadata;
  status: "downloaded" | "uploaded" | "unchanged" | "conflict";
};

type CloudSnapshot = {
  revision: number;
  state: PersonalSyncState;
  conflict?: boolean;
  deduplicated?: boolean;
};

const LEGACY_SYNC_METADATA_KEY = "dufesh:personal-sync:v1";
const SYNC_METADATA_PREFIX = "dufesh:personal-sync:v2:user";

type MetadataStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function syncMetadataKey(userId: string) {
  return `${SYNC_METADATA_PREFIX}:${encodeURIComponent(userId)}`;
}

function unique(values: string[], limit?: number) {
  const result = [...new Set(values)];
  return typeof limit === "number" ? result.slice(0, limit) : result;
}

export function normalizeAcademicTrainingPlan(
  value: unknown,
): AcademicTrainingPlan | null {
  if (!value || typeof value !== "object") return null;
  const plan = value as Partial<AcademicTrainingPlan>;
  const validString = (input: unknown, maximum: number) =>
    typeof input === "string" && input.length > 0 && input.length <= maximum;
  if (
    plan.schemaVersion !== 1 ||
    !validString(plan.planNumber, 100) ||
    !validString(plan.planName, 240) ||
    !validString(plan.majorCode, 80) ||
    !validString(plan.majorName, 160) ||
    !Number.isInteger(plan.cohortYear) ||
    plan.cohortYear! < 2000 ||
    plan.cohortYear! > 2100 ||
    !Number.isFinite(plan.requiredCredits) ||
    plan.requiredCredits! <= 0 ||
    plan.requiredCredits! > 500 ||
    !Array.isArray(plan.categories) ||
    plan.categories.length > 100 ||
    !Array.isArray(plan.courses) ||
    plan.courses.length > 1_500 ||
    typeof plan.importedAt !== "string" ||
    Number.isNaN(Date.parse(plan.importedAt))
  ) {
    return null;
  }
  const categoryCodes = new Set<string>();
  const categories: AcademicTrainingPlanCategory[] = [];
  for (const category of plan.categories) {
    if (
      !category ||
      typeof category !== "object" ||
      !validString(category.code, 80) ||
      !validString(category.name, 160) ||
      (category.requiredCredits !== null &&
        category.requiredCredits !== undefined &&
        (!Number.isFinite(category.requiredCredits) ||
          category.requiredCredits < 0 ||
          category.requiredCredits > 500)) ||
      (category.earnedCredits !== undefined &&
        category.earnedCredits !== null &&
        (!Number.isFinite(category.earnedCredits) ||
          category.earnedCredits < 0 ||
          category.earnedCredits > 500)) ||
      (category.parentCode !== undefined &&
        category.parentCode !== null &&
        !validString(category.parentCode, 80)) ||
      categoryCodes.has(category.code)
    ) {
      return null;
    }
    categoryCodes.add(category.code);
    categories.push({
      code: category.code,
      name: category.name,
      requiredCredits: category.requiredCredits ?? null,
      earnedCredits: category.earnedCredits ?? null,
      parentCode: category.parentCode ?? null,
    });
  }
  if (
    categories.some(
      (category) =>
        category.parentCode === category.code ||
        (category.parentCode != null && !categoryCodes.has(category.parentCode)),
    )
  ) {
    return null;
  }
  const seenCourses = new Set<string>();
  const attributes = new Set(["required", "limited", "elective", "unknown"]);
  const completionStatuses = new Set([
    "passed",
    "in_progress",
    "failed",
    "not_taken",
    "unknown",
  ]);
  const courses: AcademicTrainingPlanCourse[] = [];
  for (const course of plan.courses) {
    if (
      !course ||
      typeof course !== "object" ||
      !validString(course.courseCode, 80) ||
      !validString(course.courseName, 200) ||
      !validString(course.categoryCode, 80) ||
      !validString(course.categoryName, 160) ||
      !attributes.has(course.attribute) ||
      (course.completionStatus !== undefined &&
        !completionStatuses.has(course.completionStatus)) ||
      (course.completedTerm !== undefined &&
        course.completedTerm !== "" &&
        !validString(course.completedTerm, 80)) ||
      (course.credits !== null &&
        (!Number.isFinite(course.credits) ||
          course.credits < 0 ||
          course.credits > 50)) ||
      !Array.isArray(course.replacementCourseCodes) ||
      course.replacementCourseCodes.length > 20 ||
      course.replacementCourseCodes.some(
        (code) => !validString(code, 80),
      )
    ) {
      return null;
    }
    const key = `${course.categoryCode}\u0000${course.courseCode}`;
    if (seenCourses.has(key)) return null;
    seenCourses.add(key);
    courses.push({
      ...course,
      completionStatus: course.completionStatus ?? "unknown",
      completedTerm: course.completedTerm ?? "",
      replacementCourseCodes: unique(course.replacementCourseCodes),
    });
  }
  const earnedCredits =
    plan.earnedCredits === undefined || plan.earnedCredits === null
      ? null
      : Number.isFinite(plan.earnedCredits) &&
          plan.earnedCredits >= 0 &&
          plan.earnedCredits <= 500
        ? plan.earnedCredits
        : Number.NaN;
  if (Number.isNaN(earnedCredits)) return null;
  return {
    schemaVersion: 1,
    planNumber: plan.planNumber!,
    planName: plan.planName!,
    majorCode: plan.majorCode!,
    majorName: plan.majorName!,
    cohortYear: plan.cohortYear!,
    requiredCredits: plan.requiredCredits!,
    earnedCredits,
    categories,
    courses,
    importedAt: plan.importedAt,
  };
}

function normalizeState(state: PersonalSyncState): PersonalSyncState {
  const plans =
    Array.isArray(state.plans) && state.plans.length > 0
      ? state.plans.map((plan) => ({
          ...plan,
          scheduleIds: unique(plan.scheduleIds).sort(),
        }))
      : [{ id: "default", name: "默认课表", scheduleIds: [] }];
  const activePlanId = plans.some((plan) => plan.id === state.activePlanId)
    ? state.activePlanId
    : plans[0].id;

  return {
    profile: state.profile ?? null,
    skipped: Boolean(state.skipped),
    plans,
    activePlanId,
    activities: Array.isArray(state.activities) ? state.activities : [],
    assignments: Array.isArray(state.assignments) ? state.assignments : [],
    academicSnapshots: Array.isArray(state.academicSnapshots)
      ? state.academicSnapshots
          .filter(
            (snapshot) =>
              snapshot?.schemaVersion === 1 &&
              typeof snapshot.id === "string" &&
              (snapshot.term === "fall" || snapshot.term === "spring"),
          )
          .filter(
            (snapshot, index, all) =>
              all.findIndex((item) => item.id === snapshot.id) === index,
          )
          .slice(-12)
      : [],
    trainingPlan: normalizeAcademicTrainingPlan(state.trainingPlan),
    favoriteRooms: unique(state.favoriteRooms ?? [], 100),
    recentRooms: unique(state.recentRooms ?? [], 50),
    preferredTerm: state.preferredTerm === "spring" ? "spring" : "fall",
    theme: ["day", "night"].includes(state.theme) ? state.theme : "system",
  };
}

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeInitialRecords<T extends { id: string }>(
  remote: T[],
  local: T[],
) {
  const result = remote.map((item) => structuredClone(item));
  const remoteIds = new Set(remote.map((item) => item.id));
  for (const item of local) {
    if (!remoteIds.has(item.id)) result.push(structuredClone(item));
  }
  return result;
}

export function mergeInitialPersonalState(
  localInput: PersonalSyncState,
  remoteInput: PersonalSyncState,
): PersonalSyncState {
  const local = normalizeState(localInput);
  const remote = normalizeState(remoteInput);
  const localPlans = new Map(local.plans.map((plan) => [plan.id, plan]));
  const plans = remote.plans.map((plan) => {
    const localPlan = localPlans.get(plan.id);
    return {
      ...structuredClone(plan),
      scheduleIds: unique([
        ...plan.scheduleIds,
        ...(localPlan?.scheduleIds ?? []),
      ]).sort(),
    };
  });
  const remotePlanIds = new Set(remote.plans.map((plan) => plan.id));
  plans.push(
    ...local.plans
      .filter((plan) => !remotePlanIds.has(plan.id))
      .map((plan) => structuredClone(plan)),
  );
  const activePlanId = plans.some(
    (plan) => plan.id === remote.activePlanId,
  )
    ? remote.activePlanId
    : plans.some((plan) => plan.id === local.activePlanId)
      ? local.activePlanId
      : plans[0].id;

  return normalizeState({
    profile: remote.profile ?? local.profile,
    skipped: remote.profile ? remote.skipped : local.skipped,
    plans,
    activePlanId,
    activities: mergeInitialRecords(remote.activities, local.activities),
    assignments: mergeInitialRecords(remote.assignments, local.assignments),
    academicSnapshots: mergeInitialRecords(
      remote.academicSnapshots,
      local.academicSnapshots,
    ),
    trainingPlan: remote.trainingPlan ?? local.trainingPlan,
    favoriteRooms: unique(
      [...remote.favoriteRooms, ...local.favoriteRooms],
      100,
    ),
    recentRooms: unique([...remote.recentRooms, ...local.recentRooms], 50),
    preferredTerm: remote.preferredTerm,
    theme: remote.theme,
  });
}

function mergeRecordSet<T extends { id: string }>(
  scope: "plan" | "activity" | "assignment" | "academic",
  base: T[],
  local: T[],
  remote: T[],
  conflicts: PersonalSyncConflict[],
) {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const ids = new Set([
    ...baseById.keys(),
    ...localById.keys(),
    ...remoteById.keys(),
  ]);
  const result: T[] = [];

  for (const id of ids) {
    const original = baseById.get(id);
    const localItem = localById.get(id);
    const remoteItem = remoteById.get(id);
    const localChanged = !equal(localItem, original);
    const remoteChanged = !equal(remoteItem, original);

    let selected = original;
    if (localChanged && remoteChanged && !equal(localItem, remoteItem)) {
      conflicts.push({
        scope,
        id,
        local: structuredClone(localItem),
        remote: structuredClone(remoteItem),
      });
      selected = remoteItem;
    } else if (localChanged) {
      selected = localItem;
    } else if (remoteChanged) {
      selected = remoteItem;
    }

    if (selected !== undefined) result.push(structuredClone(selected));
  }
  return result;
}

function mergeAtomic<T>(
  scope: "profile" | "trainingPlan" | "settings",
  base: T,
  local: T,
  remote: T,
  conflicts: PersonalSyncConflict[],
) {
  const localChanged = !equal(local, base);
  const remoteChanged = !equal(remote, base);
  if (localChanged && remoteChanged && !equal(local, remote)) {
    conflicts.push({
      scope,
      local: structuredClone(local),
      remote: structuredClone(remote),
    });
    return structuredClone(remote);
  }
  if (localChanged) return structuredClone(local);
  if (remoteChanged) return structuredClone(remote);
  return structuredClone(base);
}

export function mergePersonalStateThreeWay(
  baseInput: PersonalSyncState,
  localInput: PersonalSyncState,
  remoteInput: PersonalSyncState,
) {
  const base = normalizeState(baseInput);
  const local = normalizeState(localInput);
  const remote = normalizeState(remoteInput);
  const conflicts: PersonalSyncConflict[] = [];
  const profileBundle = mergeAtomic(
    "profile",
    { profile: base.profile, skipped: base.skipped },
    { profile: local.profile, skipped: local.skipped },
    { profile: remote.profile, skipped: remote.skipped },
    conflicts,
  );
  const settings = mergeAtomic(
    "settings",
    {
      activePlanId: base.activePlanId,
      favoriteRooms: base.favoriteRooms,
      recentRooms: base.recentRooms,
      preferredTerm: base.preferredTerm,
      theme: base.theme,
    },
    {
      activePlanId: local.activePlanId,
      favoriteRooms: local.favoriteRooms,
      recentRooms: local.recentRooms,
      preferredTerm: local.preferredTerm,
      theme: local.theme,
    },
    {
      activePlanId: remote.activePlanId,
      favoriteRooms: remote.favoriteRooms,
      recentRooms: remote.recentRooms,
      preferredTerm: remote.preferredTerm,
      theme: remote.theme,
    },
    conflicts,
  );
  const trainingPlan = mergeAtomic(
    "trainingPlan",
    base.trainingPlan,
    local.trainingPlan,
    remote.trainingPlan,
    conflicts,
  );

  const merged = normalizeState({
    ...profileBundle,
    plans: mergeRecordSet(
      "plan",
      base.plans,
      local.plans,
      remote.plans,
      conflicts,
    ),
    activities: mergeRecordSet(
      "activity",
      base.activities,
      local.activities,
      remote.activities,
      conflicts,
    ),
    assignments: mergeRecordSet(
      "assignment",
      base.assignments,
      local.assignments,
      remote.assignments,
      conflicts,
    ),
    academicSnapshots: mergeRecordSet(
      "academic",
      base.academicSnapshots,
      local.academicSnapshots,
      remote.academicSnapshots,
      conflicts,
    ),
    trainingPlan,
    ...settings,
  });

  return { state: merged, conflicts };
}

function mutationId() {
  return `sync-${crypto.randomUUID()}`;
}

async function readCloudSnapshot(signal?: AbortSignal) {
  const response = await fetch("/api/auth/sync", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("cloud_sync_read_failed");
  const snapshot = (await response.json()) as CloudSnapshot;
  return { ...snapshot, state: normalizeState(snapshot.state) };
}

async function writeCloudSnapshot(
  baseRevision: number,
  state: PersonalSyncState,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/auth/sync", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mutationId: mutationId(),
      baseRevision,
      clientUpdatedAt: new Date().toISOString(),
      state: normalizeState(state),
    }),
    signal,
  });
  if (response.status === 401) return null;
  if (response.status !== 200 && response.status !== 409) {
    throw new Error("cloud_sync_write_failed");
  }
  const snapshot = (await response.json()) as CloudSnapshot;
  return { ...snapshot, state: normalizeState(snapshot.state) };
}

function metadata(
  userId: string,
  snapshot: CloudSnapshot,
  pendingConflicts: PersonalSyncConflict[] = [],
): PersonalSyncMetadata {
  return {
    schemaVersion: 1,
    userId,
    revision: snapshot.revision,
    baseState: snapshot.state,
    pendingConflicts,
    syncedAt: new Date().toISOString(),
  };
}

export async function synchronizePersonalState({
  userId,
  localState,
  priorMetadata,
  signal,
}: {
  userId: string;
  localState: PersonalSyncState;
  priorMetadata: PersonalSyncMetadata | null;
  signal?: AbortSignal;
}): Promise<PersonalSyncResult | null> {
  const local = normalizeState(localState);
  let remote = await readCloudSnapshot(signal);
  if (!remote) return null;

  if (!priorMetadata || priorMetadata.userId !== userId) {
    const merged =
      remote.revision === 0
        ? local
        : mergeInitialPersonalState(local, remote.state);
    if (equal(merged, remote.state)) {
      return {
        state: remote.state,
        metadata: metadata(userId, remote),
        status: "downloaded",
      };
    }
    const written = await writeCloudSnapshot(
      remote.revision,
      merged,
      signal,
    );
    if (!written) return null;
    if (written.conflict) {
      remote = written;
      const retriedState = mergeInitialPersonalState(local, remote.state);
      const retry = await writeCloudSnapshot(
        remote.revision,
        retriedState,
        signal,
      );
      if (!retry || retry.conflict) {
        throw new Error("cloud_sync_raced_twice");
      }
      return {
        state: retry.state,
        metadata: metadata(userId, retry),
        status: "uploaded",
      };
    }
    return {
      state: written.state,
      metadata: metadata(userId, written),
      status: "uploaded",
    };
  }

  const merged = mergePersonalStateThreeWay(
    priorMetadata.baseState,
    local,
    remote.state,
  );
  if (merged.conflicts.length > 0) {
    return {
      state: merged.state,
      metadata: metadata(userId, remote, merged.conflicts),
      status: "conflict",
    };
  }
  if (equal(merged.state, remote.state)) {
    return {
      state: remote.state,
      metadata: metadata(userId, remote),
      status: equal(local, remote.state) ? "unchanged" : "downloaded",
    };
  }

  const written = await writeCloudSnapshot(
    remote.revision,
    merged.state,
    signal,
  );
  if (!written) return null;
  if (!written.conflict) {
    return {
      state: written.state,
      metadata: metadata(userId, written),
      status: "uploaded",
    };
  }

  const retryMerge = mergePersonalStateThreeWay(
    remote.state,
    merged.state,
    written.state,
  );
  if (retryMerge.conflicts.length > 0) {
    return {
      state: retryMerge.state,
      metadata: metadata(userId, written, retryMerge.conflicts),
      status: "conflict",
    };
  }
  const retry = await writeCloudSnapshot(
    written.revision,
    retryMerge.state,
    signal,
  );
  if (!retry || retry.conflict) throw new Error("cloud_sync_raced_twice");
  return {
    state: retry.state,
    metadata: metadata(userId, retry),
    status: "uploaded",
  };
}

export function loadPersonalSyncMetadata(
  userId: string,
  storage: MetadataStorage = localStorage,
): PersonalSyncMetadata | null {
  try {
    const key = syncMetadataKey(userId);
    const scoped = storage.getItem(key);
    const legacy = scoped === null
      ? storage.getItem(LEGACY_SYNC_METADATA_KEY)
      : null;
    const parsed = JSON.parse(scoped ?? legacy ?? "null") as
      | PersonalSyncMetadata
      | null;
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.userId !== userId ||
      !Number.isSafeInteger(parsed.revision)
    ) {
      return null;
    }
    if (scoped === null && legacy !== null) {
      storage.setItem(key, legacy);
      storage.removeItem(LEGACY_SYNC_METADATA_KEY);
    }
    return {
      ...parsed,
      baseState: normalizeState(parsed.baseState),
      pendingConflicts: Array.isArray(parsed.pendingConflicts)
        ? parsed.pendingConflicts
        : [],
    };
  } catch {
    return null;
  }
}

export function savePersonalSyncMetadata(
  value: PersonalSyncMetadata,
  storage: MetadataStorage = localStorage,
) {
  storage.setItem(syncMetadataKey(value.userId), JSON.stringify(value));
  storage.removeItem(LEGACY_SYNC_METADATA_KEY);
}

export function clearPersonalSyncMetadata(
  userId?: string,
  storage: MetadataStorage = localStorage,
) {
  if (userId) storage.removeItem(syncMetadataKey(userId));
  storage.removeItem(LEGACY_SYNC_METADATA_KEY);
}
