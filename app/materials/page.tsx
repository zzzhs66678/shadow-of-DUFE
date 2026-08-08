import type { Metadata } from "next";
import { MaterialsExplorer } from "./MaterialsExplorer";

export const metadata: Metadata = {
  title: "课程资料档案",
  description: "按课程、教师、标题、类型、学期和年级检索东财课程资料。",
  alternates: { canonical: "/materials" },
};

export default function MaterialsPage() {
  return (
    <>
      <a className="skip-link" href="#main-content">跳到资料搜索</a>
      <MaterialsExplorer />
    </>
  );
}
