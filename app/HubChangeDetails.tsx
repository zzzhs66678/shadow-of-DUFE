"use client";

import type { AcademicChangeSummary } from "./academic-change-summary";
import { compactNumberSet, type ScheduleConflict } from "./schedule-conflicts";
import type { ScheduledMeeting } from "./schedule-reconciliation";
import styles from "./hub-change-details.module.css";

export function AcademicChangeReview({ summary }: { summary: AcademicChangeSummary }) {
  if (!summary.changes.length) return null;
  return <details className={`${styles.review} ${styles.details}`}>
    <summary>教务更新变化（{summary.changes.length} 项）</summary>
    <p>{summary.scopeLabel} · 本页最近一次有变化的更新，与此前同账号、同学期数据比较。手动选课方案未改动。</p>
    {summary.notices.map((notice) => <p key={notice}>{notice}</p>)}
    <ul className={styles.list}>
      {summary.changes.map((change, index) => <li key={index}>
        <strong>{change.area} · {change.kind} · {change.title}</strong>
        <p>{change.identity}{change.fields.length ? ` · ${change.fields.join("、")}` : ""}</p>
        {change.uncertain && <p>缺少唯一对应依据，按新增 / 移除列出；不推断为同一门课或同一场考试。</p>}
        {change.before.length > 0 && <div><b>上次</b><ul>{change.before.map((line, i) => <li key={i}>{line}</li>)}</ul></div>}
        {change.after.length > 0 && <div><b>本次</b><ul>{change.after.map((line, i) => <li key={i}>{line}</li>)}</ul></div>}
      </li>)}
    </ul>
  </details>;
}

type DisplayMeeting = ScheduledMeeting & { title: string; origin?: "catalog" | "academic"; building?: string; room?: string };
export function ScheduleConflictReview({ conflicts }: { conflicts: ScheduleConflict<DisplayMeeting>[] }) {
  if (!conflicts.length) return null;
  return <details className={styles.details}>
    <summary>查看冲突详情（{conflicts.length} 处）</summary>
    <ul className={styles.list}>
      {conflicts.map((conflict, index) => <li key={index}>
        <strong>{conflict.active.title}</strong>
        <p>{conflict.active.origin === "academic" ? "教务导入" : "手动方案"}{conflict.active.teacher ? ` · ${conflict.active.teacher}` : ""}
          {conflict.active.building || conflict.active.room ? ` · ${conflict.active.building ?? ""}${conflict.active.room ?? ""}` : ""}</p>
        <p>{["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][conflict.weekday] || "星期未明确"} · {conflict.periods ? `第${compactNumberSet(conflict.periods)}节` : "节次未明确"} · {conflict.weeks ? `第${compactNumberSet(conflict.weeks)}周` : "有效周未明确"}</p>
        {(!conflict.periods || !conflict.weeks) && <p>信息不完整，可能冲突；未推定具体交集。</p>}
      </li>)}
    </ul>
    <p>仅作提醒，不影响加入，也不会删除现有课程。</p>
  </details>;
}
