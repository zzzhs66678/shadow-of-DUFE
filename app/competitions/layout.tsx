import styles from "./competitions.module.css";

export default function CompetitionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <a className="skip-link" href="#main-content">跳到正文</a>
      <main className={styles.content} id="main-content">{children}</main>
    </div>
  );
}
