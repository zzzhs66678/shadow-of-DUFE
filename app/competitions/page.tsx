import type { Metadata } from "next";
import Link from "next/link";
import { competitions, competitionPath } from "./catalog";
import styles from "./competitions.module.css";
import { StudyDoodle } from "./StudyDoodle";
import { CompetitionNavigation } from "./CompetitionNavigation";

export const metadata: Metadata = {
  title: "学科考试及竞赛",
  description: "数学、英语和创意设计竞赛的学校通知与备考资料。",
  alternates: { canonical: "/competitions" },
};

export default function CompetitionsPage() {
  return (
    <>
      <CompetitionNavigation href="/?view=me#competitions-entry" label="返回我的" />
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1><span className={styles.titleChunk}>学科考试</span><span className={styles.titleChunk}>及竞赛</span></h1>
        </div>
        <StudyDoodle className={styles.heroArt} />
      </header>
      <div className={styles.list}>
        {competitions.map(item => (
          <Link className={styles.item} data-subject={item.category} href={competitionPath(item.slug)} key={item.slug}>
            <StudyDoodle kind={item.category} className={styles.itemArt} />
            <div className={styles.itemCopy}>
              <span className={styles.category}>{item.category}</span>
              <h2>{item.title}</h2>
              <p>学校通知{item.resources.length > 0 && " · 试题下载"}</p>
            </div>
            <span className={styles.arrow} aria-hidden="true">→</span>
          </Link>
        ))}
      </div>
    </>
  );
}
