import Link from "next/link";
import styles from "./competitions.module.css";

export function CompetitionNavigation({ href, label }: { href: string; label: string }) {
  return (
    <nav className={styles.topbar} aria-label="考试及竞赛导航">
      <Link className={styles.back} href={href}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="m10 5-7 7 7 7M3 12h18" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
      </Link>
      <span className={styles.wordmark}>东财之影</span>
    </nav>
  );
}
