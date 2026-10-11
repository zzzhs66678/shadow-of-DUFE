import { scoreCourseSearch, searchText } from "../course-search.ts";

export type SearchableMaterial = {
  name: string;
  courseTitle: string;
  courseIds?: readonly string[];
  teachers?: readonly string[];
  colleges?: readonly string[];
  tags?: readonly string[];
  category?: string;
  kind?: string;
  extension?: string;
  description?: string;
  terms?: readonly string[];
  years?: readonly number[];
};

export type MaterialFilters = {
  query?: string | null;
  course?: string | null;
  teacher?: string | null;
  type?: string | null;
  tag?: string | null;
  term?: string | null;
  year?: string | number | null;
};

// Discovery only: never used to merge materials or identify a teaching section.
export function scoreMaterialSearch(material: SearchableMaterial, input: string): number {
  const query = searchText(input);
  if (!query) return 0;
  const courseScores = (material.courseIds?.length ? material.courseIds : [""]).map((id) =>
    scoreCourseSearch({ id, title: material.courseTitle, teachers: material.teachers,
      college: material.colleges?.join(" ") }, input),
  );
  const nameScore = scoreCourseSearch({ id: "", title: material.name }, input);
  const fields = [material.name, material.courseTitle, ...(material.courseIds ?? []),
    ...(material.teachers ?? []), ...(material.colleges ?? []), ...(material.tags ?? []),
    material.category, material.kind, material.extension, material.description,
    ...(material.terms ?? []), ...(material.years ?? []).map(String)]
    .filter((field): field is string => typeof field === "string").map(searchText);
  let score = Math.max(nameScore, ...courseScores, fields.some((field) => field.includes(query)) ? 200 : -1);
  const tokens = input.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
  if (tokens.length > 1) {
    const scores = tokens.map((token) => scoreMaterialSearch(material, token));
    if (scores.every((value) => value >= 0)) {
      // Keep exact/continuous title matches ahead of multi-field or abbreviated matches.
      score = Math.max(score, 600 + Math.min(...scores) / 100);
    }
  }
  return score;
}

export function matchesMaterialFilters(material: SearchableMaterial, filters: MaterialFilters): boolean {
  const equals = (left: string, right: string) => searchText(left) === searchText(right);
  const has = (values: readonly string[] | undefined, expected?: string | null) =>
    !expected || (values ?? []).some((value) => equals(value, expected));
  const year = Number.parseInt(String(filters.year ?? ""), 10);
  return scoreMaterialSearch(material, (filters.query ?? "").trim().slice(0, 80)) >= 0 &&
    (!filters.course || equals(material.courseTitle, filters.course) || has(material.courseIds, filters.course)) &&
    has(material.teachers, filters.teacher) && has([material.kind ?? ""], filters.type) &&
    has(material.tags, filters.tag) && has(material.terms, filters.term) &&
    (!Number.isFinite(year) || (material.years ?? []).includes(year));
}
