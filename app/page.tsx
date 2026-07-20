import type { Metadata } from "next";
import { DufeHub } from "./DufeHub";

export const metadata: Metadata = {
  title: "DUFESH｜东财学习与空间索引",
  description:
    "按学院、专业与年级查课程，按日期和节次寻找可自习教室，并快速进入东财常用服务。",
};

export default function Home() {
  return <DufeHub />;
}
