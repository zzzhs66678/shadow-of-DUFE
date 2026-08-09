import type { Metadata } from "next";
import { TeacherExplorer } from "./TeacherExplorer";

export const metadata: Metadata = {
  title: "教师档案",
  description: "按姓名和学院查找东财教师，查看教学班、教材和已公开评价。",
  alternates: { canonical: "/teachers" },
};

export default function TeachersPage() {
  return (
    <>
      <a className="skip-link" href="#main-content">跳到教师搜索</a>
      <TeacherExplorer />
    </>
  );
}
