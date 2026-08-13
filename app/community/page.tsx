import type { Metadata } from "next";
import { CommunityHub } from "./CommunityHub";

export const metadata: Metadata = {
  title: "校园回廊",
  description: "东财学生交流课程、学习和校园生活的社区。",
  alternates: { canonical: "/community" },
};

export default function CommunityPage() {
  return (
    <>
      <a className="skip-link" href="#community-feed">跳到校园回廊</a>
      <CommunityHub />
    </>
  );
}
