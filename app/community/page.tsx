import type { Metadata } from "next";
import { publicPagePaths } from "../seo";
import { CommunityHub } from "./CommunityHub";

export const metadata: Metadata = {
  title: "东财墙",
  description: "东财学生交流课程、学习和校园生活的社区。",
  alternates: { canonical: publicPagePaths.community },
};

export default function CommunityPage() {
  return (
    <>
      <a className="skip-link" href="#community-feed">跳到东财墙</a>
      <CommunityHub />
    </>
  );
}
