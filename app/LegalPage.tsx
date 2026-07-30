import Link from "next/link";
import type { ReactNode } from "react";

export function LegalPage({
  eyebrow,
  title,
  updated = "2026年7月30日",
  children,
}: {
  eyebrow: string;
  title: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <main className="legal-page">
      <header className="legal-topbar">
        <Link href="/" aria-label="返回东财之影首页">
          东财之影
        </Link>
        <span>个人非经营性网站</span>
      </header>
      <article className="legal-document">
        <header>
          <span>{eyebrow}</span>
          <h1>{title}</h1>
          <p>更新日期：{updated}</p>
        </header>
        <div className="legal-content">{children}</div>
      </article>
      <nav className="legal-nav" aria-label="法律与隐私">
        <Link href="/privacy">隐私政策</Link>
        <Link href="/terms">用户协议</Link>
        <Link href="/account/delete">账号注销</Link>
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noreferrer"
        >
          辽ICP备2026016653号-1
        </a>
      </nav>
    </main>
  );
}
