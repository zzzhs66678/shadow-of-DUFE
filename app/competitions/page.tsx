import type { Metadata } from "next";
import Link from "next/link";
import { competitions, competitionPath, type Competition } from "./catalog";
import styles from "./competitions.module.css";
import { StudyDoodle } from "./StudyDoodle";
import { CompetitionNavigation } from "./CompetitionNavigation";

export const metadata: Metadata = {
  title: "学科考试及竞赛",
  description: "数学、英语和创意设计竞赛的学校通知与备考资料。",
  alternates: { canonical: "/competitions" },
};

export default function CompetitionsPage() {
  const categories: Competition["category"][] = ["数学", "英语", "创意设计"];
  return (
    <>
      <CompetitionNavigation href="/?view=me#competitions-entry" label="返回我的" />
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1><span className={styles.titleChunk}>学科考试</span><span className={styles.titleChunk}>及竞赛</span></h1>
        </div>
        <StudyDoodle className={styles.heroArt} />
      </header>
      <p className={styles.archiveNote}>通知保留原发布日期，报名安排请以学校原文为准。</p>
      <div className={styles.groups}>
        {categories.map(category => {
          const items = competitions.filter(item => item.category === category);
          return (
            <section className={styles.subject} aria-labelledby={`subject-${category}`} key={category}>
              <div className={styles.subjectHeading}>
                <h2 id={`subject-${category}`} className={styles.subjectTitle}>{category}</h2>
                <span className={styles.subjectCount}>{items.length} 项</span>
              </div>
              <ul className={styles.list}>
                {items.map(item => (
                  <li key={item.slug}>
                    <Link className={styles.item} data-subject={item.category} href={competitionPath(item.slug)}>
                      <div className={styles.itemCopy}>
                        <h3>{item.title}</h3>
                        <p>学校通知 · <time dateTime={item.notice.publishedAt}>{item.notice.publishedAt}</time></p>
                      </div>
                      {item.resources.length > 0 && <span className={styles.resourceTag}>试题下载</span>}
                      <span className={styles.arrow} aria-hidden="true">→</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
