const ID_PATTERN = /^[A-Za-z0-9:_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COLORS = new Set(["red", "blue", "green", "amber"]);
const TERMS = new Set(["fall", "spring"]);
const THEMES = new Set(["system", "day", "night"]);

function invalid(message) {
  const error = new Error(message);
  error.code = "SYNC_PAYLOAD_INVALID";
  return error;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${name} must be an object`);
  }
  return value;
}

function string(value, name, maxLength, { empty = true, id = false } = {}) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw invalid(`${name} must be a string no longer than ${maxLength}`);
  }
  if (!empty && value.length === 0) {
    throw invalid(`${name} must not be empty`);
  }
  if (id && !ID_PATTERN.test(value)) {
    throw invalid(`${name} contains unsupported characters`);
  }
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") {
    throw invalid(`${name} must be a boolean`);
  }
  return value;
}

function array(value, name, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw invalid(`${name} must be an array with at most ${maxLength} items`);
  }
  return value;
}

function uniqueBy(items, key, name) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw invalid(`${name} contains duplicate ${key}`);
    seen.add(value);
  }
  return items;
}

function stringList(value, name, maxItems, maxLength) {
  const result = array(value, name, maxItems).map((item, index) =>
    string(item, `${name}[${index}]`, maxLength, { empty: false }),
  );
  return [...new Set(result)];
}

function profile(value) {
  if (value === null) return null;
  const input = object(value, "state.profile");
  return {
    entranceYear: integer(
      input.entranceYear,
      "state.profile.entranceYear",
      2000,
      2100,
    ),
    college: string(input.college, "state.profile.college", 120),
    majorId: string(input.majorId, "state.profile.majorId", 120),
    className: string(input.className, "state.profile.className", 120),
  };
}

function plan(value, index) {
  const input = object(value, `state.plans[${index}]`);
  return {
    id: string(input.id, `state.plans[${index}].id`, 128, {
      empty: false,
      id: true,
    }),
    name: string(input.name, `state.plans[${index}].name`, 80, {
      empty: false,
    }),
    scheduleIds: stringList(
      input.scheduleIds,
      `state.plans[${index}].scheduleIds`,
      1200,
      160,
    ),
  };
}

function activity(value, index) {
  const input = object(value, `state.activities[${index}]`);
  if (!COLORS.has(input.color)) {
    throw invalid(`state.activities[${index}].color is unsupported`);
  }
  return {
    id: string(input.id, `state.activities[${index}].id`, 128, {
      empty: false,
      id: true,
    }),
    title: string(input.title, `state.activities[${index}].title`, 120, {
      empty: false,
    }),
    weekday: integer(
      input.weekday,
      `state.activities[${index}].weekday`,
      1,
      7,
    ),
    block: integer(input.block, `state.activities[${index}].block`, 1, 4),
    location: string(
      input.location ?? "",
      `state.activities[${index}].location`,
      200,
    ),
    notes: string(
      input.notes ?? "",
      `state.activities[${index}].notes`,
      4000,
    ),
    color: input.color,
  };
}

function assignment(value, index) {
  const input = object(value, `state.assignments[${index}]`);
  const dueDate = string(
    input.dueDate,
    `state.assignments[${index}].dueDate`,
    10,
    { empty: false },
  );
  if (
    !DATE_PATTERN.test(dueDate) ||
    Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))
  ) {
    throw invalid(`state.assignments[${index}].dueDate is invalid`);
  }
  return {
    id: string(input.id, `state.assignments[${index}].id`, 128, {
      empty: false,
      id: true,
    }),
    courseId: string(
      input.courseId ?? "",
      `state.assignments[${index}].courseId`,
      160,
    ),
    title: string(input.title, `state.assignments[${index}].title`, 160, {
      empty: false,
    }),
    dueDate,
    notes: string(
      input.notes ?? "",
      `state.assignments[${index}].notes`,
      4000,
    ),
    completed: boolean(
      input.completed,
      `state.assignments[${index}].completed`,
    ),
  };
}

export function validateSyncWrite(value) {
  const input = object(value, "body");
  const state = object(input.state, "state");
  if (!Array.isArray(state.plans) || state.plans.length === 0) {
    throw invalid("state.plans must contain at least one plan");
  }
  const plans = uniqueBy(
    array(state.plans, "state.plans", 20).map(plan),
    "id",
    "state.plans",
  );
  const activities = uniqueBy(
    array(state.activities, "state.activities", 500).map(activity),
    "id",
    "state.activities",
  );
  const assignments = uniqueBy(
    array(state.assignments, "state.assignments", 1000).map(assignment),
    "id",
    "state.assignments",
  );
  const activePlanId = string(
    state.activePlanId,
    "state.activePlanId",
    128,
    { empty: false, id: true },
  );
  if (!plans.some((item) => item.id === activePlanId)) {
    throw invalid("state.activePlanId must identify an existing plan");
  }

  const preferredTerm = state.preferredTerm ?? "fall";
  const theme = state.theme ?? "system";
  if (!TERMS.has(preferredTerm)) {
    throw invalid("state.preferredTerm is unsupported");
  }
  if (!THEMES.has(theme)) throw invalid("state.theme is unsupported");

  const mutationId = string(input.mutationId, "mutationId", 128, {
    empty: false,
    id: true,
  });
  if (mutationId.length < 16) {
    throw invalid("mutationId must contain at least 16 characters");
  }

  const clientUpdatedAt = new Date(input.clientUpdatedAt);
  if (
    typeof input.clientUpdatedAt !== "string" ||
    Number.isNaN(clientUpdatedAt.getTime()) ||
    Math.abs(Date.now() - clientUpdatedAt.getTime()) > 31_536_000_000
  ) {
    throw invalid("clientUpdatedAt is invalid");
  }

  return {
    mutationId,
    baseRevision: integer(
      input.baseRevision,
      "baseRevision",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    clientUpdatedAt,
    state: {
      profile: profile(state.profile),
      skipped: boolean(state.skipped, "state.skipped"),
      plans,
      activePlanId,
      activities,
      assignments,
      favoriteRooms: stringList(
        state.favoriteRooms,
        "state.favoriteRooms",
        100,
        160,
      ),
      recentRooms: stringList(
        state.recentRooms,
        "state.recentRooms",
        50,
        160,
      ),
      preferredTerm,
      theme,
    },
  };
}
