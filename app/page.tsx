import type { Metadata } from "next";
import Link from "next/link";
import { DufeHubV2 } from "./DufeHubV2";

export const metadata: Metadata = {
  title: {
    absolute: "东财之影｜课表、空教室与学习资料",
  },
  description:
    "面向东北财经大学学生的课表、空教室、课程资料与个人日程工具。",
  alternates: {
    canonical: "/",
  },
};

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <section className="preload-intro" aria-labelledby="preload-title">
        <div>
          <span>DUFE · STUDENT DESK</span>
          <h1 id="preload-title">东财之影</h1>
          <p>课表、空教室、课程资料和今天的安排。</p>
        </div>
        <nav aria-label="快捷入口">
          <Link href="/?view=schedule">我的课表</Link>
          <Link href="/?view=rooms">空教室</Link>
          <Link href="/?view=catalog">课程与资料</Link>
        </nav>
      </section>
      <DufeHubV2 />
    </>
  );
}
