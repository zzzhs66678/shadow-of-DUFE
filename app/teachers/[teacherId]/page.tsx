import type { Metadata } from "next";
import { TeacherDetail } from "./TeacherDetail";

type PageProps = { params: Promise<{ teacherId: string }> };

export const metadata: Metadata = {
  title: "教师档案详情",
  description: "查看教师的教学班、教材和已公开评价。",
};

export default async function TeacherDetailPage({ params }: PageProps) {
  return <TeacherDetail teacherId={(await params).teacherId} />;
}
