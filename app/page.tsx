import type { Metadata } from "next";
import Link from "next/link";
import { DufeHubV2 } from "./DufeHubV2";
import { absoluteUrl, publicPagePaths, siteDescription, siteName } from "./seo";

export const metadata: Metadata = {
  title: {
    absolute: "东财之影｜课表、空教室与学习资料",
  },
  description: siteDescription,
  verification: {
    other: { "baidu-site-verification": "codeva-vXTtpeLyzP" },
  },
  alternates: {
    canonical: publicPagePaths.home,
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
          <p>{siteDescription}</p>
        </div>
        <nav aria-label="快捷入口">
          <Link href="/?view=schedule">我的课表</Link>
          <Link href="/?view=rooms">空教室</Link>
          <Link href="/?view=catalog">学习档案</Link>
          <Link href="/teachers">教师档案</Link>
          <Link href="/materials">课程资料</Link>
        </nav>
      </section>
      <DufeHubV2 />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          "@id": `${absoluteUrl("/")}#website`,
          name: siteName,
          url: absoluteUrl("/"),
          description: siteDescription,
          inLanguage: "zh-CN",
        }).replace(/</g, "\\u003c") }}
      />
    </>
  );
}
