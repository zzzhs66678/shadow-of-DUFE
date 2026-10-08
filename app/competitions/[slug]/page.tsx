import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findCompetition, competitionPath } from "../catalog";
import styles from "../competitions.module.css";
import { StudyDoodle } from "../StudyDoodle";
import { CompetitionNavigation } from "../CompetitionNavigation";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const item = findCompetition((await params).slug);
  if (!item) return { title: "未找到项目", robots: { index: false } };
  return { title: item.title, alternates: { canonical: competitionPath(item.slug) } };
}

export default async function CompetitionPage({ params }: PageProps) {
  const item = findCompetition((await params).slug);
  if (!item) notFound();
  return (
    <article className={styles.detail} data-subject={item.category}>
      <CompetitionNavigation href="/competitions" label="返回考试及竞赛" />
      <header className={`${styles.hero} ${styles.detailHero}`}>
        <div className={styles.heroCopy}>
          <span className={styles.category}>{item.category}</span>
          <h1>{item.title}</h1>
        </div>
        <StudyDoodle kind={item.category} className={styles.heroArt} />
      </header>
      <section aria-labelledby="notice-title" className={styles.section}>
        <h2 id="notice-title">学校通知</h2>
        <a className={styles.notice} href={item.notice.url} target="_blank" rel="noopener noreferrer">
          <div>
            <h3>{item.notice.title}</h3>
            <p>东北财经大学教务处 · <time dateTime={item.notice.publishedAt}>{item.notice.publishedAt}</time></p>
          </div>
          <span className={styles.noticeAction}>查看原文 <i aria-hidden="true">↗</i></span>
        </a>
      </section>
      <section aria-labelledby="resources-title" className={styles.section}>
        <h2 id="resources-title">备考资料</h2>
        {item.resources.length ? item.resources.map(resource => (
          <div className={styles.resource} key={resource.href}>
            <div>
              <span className={styles.fileType}>ZIP · {(resource.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
              <h3>{resource.name}</h3>
              <p>{resource.description}</p>
            </div>
            <a className={styles.download} href={resource.href} download={resource.filename}>下载试题 <span aria-hidden="true">↓</span></a>
          </div>
        )) : <p className={styles.empty}>暂无资料。</p>}
      </section>
    </article>
  );
}
