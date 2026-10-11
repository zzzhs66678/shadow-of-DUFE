"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import styles from "./competitions.module.css";
import { StudyDoodle } from "./StudyDoodle";

export function CompetitionsGateway() {
  const entryRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (window.location.hash !== "#competitions-entry") return;
    const frame = requestAnimationFrame(() => {
      entryRef.current?.scrollIntoView({ block: "center", behavior: "instant" });
      entryRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section className={styles.gateway} id="competitions-entry" aria-labelledby="competitions-entry-title">
      <Link ref={entryRef} className={styles.gatewayLink} href="/competitions" aria-label="查看学科考试及竞赛">
        <span className={styles.gatewayStamp} aria-hidden="true"><StudyDoodle className={styles.gatewayArt} /></span>
        <div className={styles.gatewayCopy}>
          <h2 id="competitions-entry-title">学科考试及竞赛</h2>
          <p>学校通知 · 备考资料</p>
        </div>
        <span className={styles.gatewayArrow} aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
