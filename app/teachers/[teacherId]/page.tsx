import type { Metadata } from "next";
import { TeacherDetail } from "./TeacherDetail";

type PageProps = {
  params: Promise<{ teacherId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = {
  title: "教师档案详情",
  description: "查看教师的教学班、教材和已公开评价。",
};

export default async function TeacherDetailPage({ params, searchParams }: PageProps) {
  const query = await searchParams;
  const rawReviewQuery = Array.isArray(query.reviewQuery) ? query.reviewQuery[0] : query.reviewQuery;
  const reviewQuery = (rawReviewQuery ?? "").normalize("NFKC").trim().slice(0, 64);
  const rawSort = Array.isArray(query.reviewSort) ? query.reviewSort[0] : query.reviewSort;
  const reviewSort = rawSort === "discussed"
    ? "discussed"
    : rawSort === "relevant" && reviewQuery
      ? "relevant"
      : "latest";
  return <TeacherDetail teacherId={(await params).teacherId} initialReviewQuery={reviewQuery} initialReviewSort={reviewSort} />;
}
