import type { Metadata } from "next";
import { MaterialsExplorer } from "./MaterialsExplorer";

export const metadata: Metadata = {
  title: "课程资料档案",
  description: "按课程、教师、标题、类型、学期和年级检索东财课程资料。",
  alternates: { canonical: "/materials" },
};

const searchKeys = ["q", "course", "teacher", "type", "tag", "term", "year"] as const;

type MaterialsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function MaterialsPage({ searchParams }: MaterialsPageProps) {
  const params = await searchParams;
  const initialSearch = Object.fromEntries(
    searchKeys.map((key) => {
      const value = params[key];
      return [key, Array.isArray(value) ? value[0] ?? "" : value ?? ""];
    }),
  );

  return (
    <>
      <a className="skip-link" href="#main-content">跳到资料搜索</a>
      <MaterialsExplorer initialSearch={initialSearch} />
    </>
  );
}
