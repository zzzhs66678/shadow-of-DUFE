export const courseWorkspaceTabs = ["mine", "catalog", "teachers", "materials"] as const;
export type CourseWorkspaceTab = (typeof courseWorkspaceTabs)[number];
export type TeacherSearch = { q: string; college: string };
export type WorkspaceMaterialSearch = {
  q?: string; course?: string; teacher?: string; type?: string;
  tag?: string; term?: string; year?: string;
};
export type CourseWorkspaceState = {
  tab: CourseWorkspaceTab;
  query: string;
  teachers: TeacherSearch;
  materials: WorkspaceMaterialSearch;
};

const materialParams = {
  q: "mq", course: "mcourse", teacher: "mteacher", type: "mtype",
  tag: "mtag", term: "mterm", year: "myear",
} as const;

export function readCourseWorkspace(search: string, fallback: CourseWorkspaceTab): CourseWorkspaceState {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const materials = Object.fromEntries(
    Object.entries(materialParams).map(([key, param]) => [key, params.get(param) ?? ""]),
  ) as WorkspaceMaterialSearch;
  return {
    tab: courseWorkspaceTabs.includes(tab as CourseWorkspaceTab) ? tab as CourseWorkspaceTab : fallback,
    query: params.get("cq") ?? "",
    teachers: { q: params.get("tq") ?? "", college: params.get("tcollege") ?? "" },
    materials,
  };
}

/** Own only workspace parameters: preserve the site's view, version and any unrelated state. */
export function courseWorkspaceHref(href: string, state: CourseWorkspaceState): string {
  const url = new URL(href);
  url.searchParams.set("view", "catalog");
  url.searchParams.set("tab", state.tab);
  const fields = {
    cq: state.query, tq: state.teachers.q, tcollege: state.teachers.college,
    ...Object.fromEntries(Object.entries(materialParams).map(([key, param]) => [param, state.materials[key as keyof WorkspaceMaterialSearch]])),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
