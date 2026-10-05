import {
  anonymousPersonalScope,
  readPersonalStorage,
  userPersonalScope,
} from "./personal-storage";
import type { AcademicSnapshot, AcademicTrainingPlan } from "./personal-sync";

type StoredCourseContext = {
  academicSnapshots?: AcademicSnapshot[];
  trainingPlan?: AcademicTrainingPlan | null;
};

export type PersonalCourseContext = {
  currentCourseCodes: string[];
  currentCourseNames: string[];
  teacherNames: string[];
  planCourseCodes: string[];
  planCourseNames: string[];
};

const emptyContext: PersonalCourseContext = {
  currentCourseCodes: [],
  currentCourseNames: [],
  teacherNames: [],
  planCourseCodes: [],
  planCourseNames: [],
};

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function derivePersonalCourseContext(
  state: StoredCourseContext | null,
): PersonalCourseContext {
  if (!state) return emptyContext;
  const latestSnapshot = [...(state.academicSnapshots ?? [])].sort(
    (left, right) =>
      right.academicYear.localeCompare(left.academicYear) ||
      Date.parse(right.importedAt) - Date.parse(left.importedAt),
  )[0];
  return {
    currentCourseCodes: unique(
      (latestSnapshot?.sections ?? []).map((section) => section.courseCode),
    ),
    currentCourseNames: unique(
      (latestSnapshot?.sections ?? []).map((section) => section.courseName),
    ),
    teacherNames: unique(
      (latestSnapshot?.sections ?? []).flatMap((section) => section.teachers),
    ),
    planCourseCodes: unique(
      (state.trainingPlan?.courses ?? []).map((course) => course.courseCode),
    ),
    planCourseNames: unique(
      (state.trainingPlan?.courses ?? []).map((course) => course.courseName),
    ),
  };
}

export async function loadPersonalCourseContext(): Promise<PersonalCourseContext> {
  try {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const session = response.ok
      ? await response.json() as {
          authenticated?: boolean;
          user?: { id?: string } | null;
        }
      : null;
    const scope = session?.authenticated && session.user?.id
      ? userPersonalScope(session.user.id)
      : anonymousPersonalScope;
    return derivePersonalCourseContext(
      readPersonalStorage<StoredCourseContext>(localStorage, scope),
    );
  } catch {
    return derivePersonalCourseContext(
      readPersonalStorage<StoredCourseContext>(
        localStorage,
        anonymousPersonalScope,
      ),
    );
  }
}
