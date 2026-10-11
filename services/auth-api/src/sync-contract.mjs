const ID_PATTERN = /^[A-Za-z0-9:_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ACADEMIC_YEAR_PATTERN = /^20\d{2}-20\d{2}$/;
const COLORS = new Set(["red", "blue", "green", "amber"]);
const TERMS = new Set(["fall", "spring"]);
const THEMES = new Set(["system", "day", "night"]);
const PLAN_COURSE_ATTRIBUTES = new Set([
  "required",
  "limited",
  "elective",
  "unknown",
]);
const PLAN_COURSE_COMPLETION_STATUSES = new Set([
  "passed",
  "in_progress",
  "failed",
  "not_taken",
  "unknown",
]);

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
  const clock = {};
  if (["startTime", "endTime", "date", "repeat"].some((key) => Object.hasOwn(input, key))) {
    if (typeof input.startTime !== "string" || typeof input.endTime !== "string" ||
        !TIME_PATTERN.test(input.startTime) || !TIME_PATTERN.test(input.endTime) ||
        input.endTime <= input.startTime || !["none", "weekly"].includes(input.repeat)) {
      throw invalid(`state.activities[${index}] requires same-day start/end HH:mm and repeat`);
    }
    if (input.date !== undefined) {
      if (typeof input.date !== "string" || !DATE_PATTERN.test(input.date) ||
          input.date < "2000-01-01" || input.date > "2100-12-31" ||
          !Number.isFinite(Date.parse(`${input.date}T00:00:00Z`)) ||
          new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.date ||
          (new Date(`${input.date}T12:00:00Z`).getUTCDay() || 7) !== input.weekday) {
        throw invalid(`state.activities[${index}].date must be a valid date matching weekday`);
      }
      clock.date = input.date;
    } else if (input.repeat === "none") {
      throw invalid(`state.activities[${index}].date is required for one-off events`);
    }
    clock.startTime = input.startTime;
    clock.endTime = input.endTime;
    clock.repeat = input.repeat;
  }
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
    ...clock,
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

function finiteNumber(value, name, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw invalid(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function instant(value, name) {
  const normalized = string(value, name, 40, { empty: false });
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw invalid(`${name} is invalid`);
  return parsed.toISOString();
}

function optionalTime(value, name) {
  const normalized = string(value ?? "", name, 5);
  if (normalized && !TIME_PATTERN.test(normalized)) {
    throw invalid(`${name} is invalid`);
  }
  return normalized;
}

function academicMeeting(value, snapshotIndex, sectionIndex, index) {
  const name = `state.academicSnapshots[${snapshotIndex}].sections[${sectionIndex}].meetings[${index}]`;
  const input = object(value, name);
  const periods = array(input.periods, `${name}.periods`, 14).map(
    (period, periodIndex) =>
      integer(period, `${name}.periods[${periodIndex}]`, 1, 14),
  );
  const weeks = array(input.weeks, `${name}.weeks`, 30).map(
    (week, weekIndex) =>
      integer(week, `${name}.weeks[${weekIndex}]`, 1, 30),
  );
  return {
    id: string(input.id, `${name}.id`, 128, { empty: false, id: true }),
    weekday: integer(input.weekday, `${name}.weekday`, 1, 7),
    periods: [...new Set(periods)].sort((left, right) => left - right),
    block: integer(input.block, `${name}.block`, 1, 4),
    weeks: [...new Set(weeks)].sort((left, right) => left - right),
    weekText: string(input.weekText ?? "", `${name}.weekText`, 120),
    timeText: string(input.timeText ?? "", `${name}.timeText`, 200),
    campus: string(input.campus ?? "", `${name}.campus`, 120),
    building: string(input.building ?? "", `${name}.building`, 160),
    room: string(input.room ?? "", `${name}.room`, 160),
  };
}

function academicSection(value, snapshotIndex, index) {
  const name = `state.academicSnapshots[${snapshotIndex}].sections[${index}]`;
  const input = object(value, name);
  const meetings = uniqueBy(
    array(input.meetings, `${name}.meetings`, 20).map((meeting, meetingIndex) =>
      academicMeeting(meeting, snapshotIndex, index, meetingIndex),
    ),
    "id",
    `${name}.meetings`,
  );
  return {
    id: string(input.id, `${name}.id`, 128, { empty: false, id: true }),
    courseCode: string(input.courseCode ?? "", `${name}.courseCode`, 80),
    courseName: string(input.courseName, `${name}.courseName`, 200, {
      empty: false,
    }),
    sectionCode: string(input.sectionCode ?? "", `${name}.sectionCode`, 80),
    credits: string(input.credits ?? "", `${name}.credits`, 32),
    property: string(input.property ?? "", `${name}.property`, 80),
    category: string(input.category ?? "", `${name}.category`, 80),
    assessmentType: string(
      input.assessmentType ?? "",
      `${name}.assessmentType`,
      80,
    ),
    teachers: stringList(input.teachers ?? [], `${name}.teachers`, 12, 80),
    studyMode: string(input.studyMode ?? "", `${name}.studyMode`, 80),
    selectionStatus: string(
      input.selectionStatus ?? "",
      `${name}.selectionStatus`,
      80,
    ),
    meetings,
  };
}

function academicExam(value, snapshotIndex, index) {
  const name = `state.academicSnapshots[${snapshotIndex}].exams[${index}]`;
  const input = object(value, name);
  const date = string(input.date ?? "", `${name}.date`, 10);
  if (
    date &&
    (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))
  ) {
    throw invalid(`${name}.date is invalid`);
  }
  return {
    id: string(input.id, `${name}.id`, 128, { empty: false, id: true }),
    courseCode: string(input.courseCode ?? "", `${name}.courseCode`, 80),
    courseName: string(input.courseName ?? "", `${name}.courseName`, 200),
    sectionCode: string(input.sectionCode ?? "", `${name}.sectionCode`, 80),
    examType: string(input.examType ?? "", `${name}.examType`, 80),
    date,
    startTime: optionalTime(input.startTime, `${name}.startTime`),
    endTime: optionalTime(input.endTime, `${name}.endTime`),
    campus: string(input.campus ?? "", `${name}.campus`, 120),
    building: string(input.building ?? "", `${name}.building`, 160),
    room: string(input.room ?? "", `${name}.room`, 160),
    location: string(input.location ?? "", `${name}.location`, 300),
    seat: string(input.seat ?? "", `${name}.seat`, 80),
    examNumber: string(input.examNumber ?? "", `${name}.examNumber`, 120),
    status: string(input.status ?? "", `${name}.status`, 80),
  };
}

function academicSnapshot(value, index) {
  const name = `state.academicSnapshots[${index}]`;
  const input = object(value, name);
  if (input.schemaVersion !== 1) {
    throw invalid(`${name}.schemaVersion is unsupported`);
  }
  const academicYear = string(
    input.academicYear,
    `${name}.academicYear`,
    9,
    { empty: false },
  );
  if (!ACADEMIC_YEAR_PATTERN.test(academicYear)) {
    throw invalid(`${name}.academicYear is invalid`);
  }
  if (!TERMS.has(input.term)) throw invalid(`${name}.term is unsupported`);
  const sections = uniqueBy(
    array(input.sections, `${name}.sections`, 120).map((section, sectionIndex) =>
      academicSection(section, index, sectionIndex),
    ),
    "id",
    `${name}.sections`,
  );
  const exams = uniqueBy(
    array(input.exams, `${name}.exams`, 120).map((exam, examIndex) =>
      academicExam(exam, index, examIndex),
    ),
    "id",
    `${name}.exams`,
  );
  const examStatus =
    input.examStatus === undefined
      ? undefined
      : string(input.examStatus, `${name}.examStatus`, 20, { empty: false });
  if (examStatus !== undefined && !["unavailable", "stale"].includes(examStatus)) {
    throw invalid(`${name}.examStatus is unsupported`);
  }
  return {
    schemaVersion: 1,
    id: string(input.id, `${name}.id`, 64, { empty: false, id: true }),
    academicYear,
    term: input.term,
    termLabel: string(input.termLabel, `${name}.termLabel`, 32, {
      empty: false,
    }),
    importedAt: instant(input.importedAt, `${name}.importedAt`),
    sections,
    exams,
    ...(examStatus ? { examStatus } : {}),
  };
}

function trainingPlan(value) {
  if (value === null || value === undefined) return null;
  const name = "state.trainingPlan";
  const input = object(value, name);
  if (input.schemaVersion !== 1) {
    throw invalid(`${name}.schemaVersion is unsupported`);
  }
  const categories = array(input.categories, `${name}.categories`, 100).map(
    (value, index) => {
      const category = object(value, `${name}.categories[${index}]`);
      return {
        code: string(category.code, `${name}.categories[${index}].code`, 80, {
          empty: false,
        }),
        name: string(category.name, `${name}.categories[${index}].name`, 160, {
          empty: false,
        }),
        requiredCredits:
          category.requiredCredits === null ||
          category.requiredCredits === undefined
            ? null
            : finiteNumber(
                category.requiredCredits,
                `${name}.categories[${index}].requiredCredits`,
                0,
                500,
              ),
        earnedCredits:
          category.earnedCredits === null ||
          category.earnedCredits === undefined
            ? null
            : finiteNumber(
                category.earnedCredits,
                `${name}.categories[${index}].earnedCredits`,
                0,
                500,
              ),
        parentCode:
          category.parentCode === null || category.parentCode === undefined
            ? null
            : string(
                category.parentCode,
                `${name}.categories[${index}].parentCode`,
                80,
                { empty: false },
              ),
      };
    },
  );
  uniqueBy(categories, "code", `${name}.categories`);
  const categoryCodes = new Set(categories.map((category) => category.code));
  if (
    categories.some(
      (category) =>
        category.parentCode === category.code ||
        (category.parentCode !== null && !categoryCodes.has(category.parentCode)),
    )
  ) {
    throw invalid(`${name}.categories contains an invalid parent`);
  }
  const seenCourses = new Set();
  const courses = array(input.courses, `${name}.courses`, 1_500).map(
    (value, index) => {
      const course = object(value, `${name}.courses[${index}]`);
      if (!PLAN_COURSE_ATTRIBUTES.has(course.attribute)) {
        throw invalid(`${name}.courses[${index}].attribute is unsupported`);
      }
      const completionStatus = course.completionStatus ?? "unknown";
      if (!PLAN_COURSE_COMPLETION_STATUSES.has(completionStatus)) {
        throw invalid(
          `${name}.courses[${index}].completionStatus is unsupported`,
        );
      }
      const normalized = {
        courseCode: string(
          course.courseCode,
          `${name}.courses[${index}].courseCode`,
          80,
          { empty: false },
        ),
        courseName: string(
          course.courseName,
          `${name}.courses[${index}].courseName`,
          200,
          { empty: false },
        ),
        categoryCode: string(
          course.categoryCode,
          `${name}.courses[${index}].categoryCode`,
          80,
          { empty: false },
        ),
        categoryName: string(
          course.categoryName,
          `${name}.courses[${index}].categoryName`,
          160,
          { empty: false },
        ),
        attribute: course.attribute,
        completionStatus,
        completedTerm: string(
          course.completedTerm ?? "",
          `${name}.courses[${index}].completedTerm`,
          80,
        ),
        credits:
          course.credits === null || course.credits === undefined
            ? null
            : finiteNumber(
                course.credits,
                `${name}.courses[${index}].credits`,
                0,
                50,
              ),
        replacementCourseCodes: stringList(
          course.replacementCourseCodes ?? [],
          `${name}.courses[${index}].replacementCourseCodes`,
          20,
          80,
        ),
      };
      const key = `${normalized.categoryCode}\u0000${normalized.courseCode}`;
      if (seenCourses.has(key)) {
        throw invalid(`${name}.courses contains a duplicate category/course`);
      }
      seenCourses.add(key);
      return normalized;
    },
  );
  return {
    schemaVersion: 1,
    planNumber: string(input.planNumber, `${name}.planNumber`, 100, {
      empty: false,
    }),
    planName: string(input.planName, `${name}.planName`, 240, {
      empty: false,
    }),
    majorCode: string(input.majorCode, `${name}.majorCode`, 80, {
      empty: false,
    }),
    majorName: string(input.majorName, `${name}.majorName`, 160, {
      empty: false,
    }),
    cohortYear: integer(input.cohortYear, `${name}.cohortYear`, 2000, 2100),
    requiredCredits: finiteNumber(
      input.requiredCredits,
      `${name}.requiredCredits`,
      1,
      500,
    ),
    earnedCredits:
      input.earnedCredits === null || input.earnedCredits === undefined
        ? null
        : finiteNumber(
            input.earnedCredits,
            `${name}.earnedCredits`,
            0,
            500,
          ),
    categories,
    courses,
    importedAt: instant(input.importedAt, `${name}.importedAt`),
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
  const academicSnapshots = uniqueBy(
    array(
      state.academicSnapshots ?? [],
      "state.academicSnapshots",
      12,
    ).map(academicSnapshot),
    "id",
    "state.academicSnapshots",
  );
  const normalizedTrainingPlan = trainingPlan(state.trainingPlan);
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
      academicSnapshots,
      trainingPlan: normalizedTrainingPlan,
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
