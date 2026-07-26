import type { Metadata } from "next";
import { DufeHubV2 } from "./DufeHubV2";

export const metadata: Metadata = {
  title: "东财之影｜课表、空教室与学习资料",
  description:
    "为东北财经大学学生提供个性课表、空教室查询与课程资料索引。",
};

export default function Home() {
  return <DufeHubV2 />;
}
