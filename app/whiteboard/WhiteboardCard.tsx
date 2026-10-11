import type { BoardCopy } from "./client";
import { boardDate, boardEventTime, chinaInput } from "./client";
import styles from "./whiteboard.module.css";

export function WhiteboardCard({ item, compact = false, archived = false }: { item: BoardCopy; compact?: boolean; archived?: boolean }) {
  const date = chinaInput(item.startsAt);
  return <div className={styles.board} data-kind={item.kind}>
    <div className={styles.boardTop}><span className={styles.handwritten}>小白板</span><span className={styles.category}>{archived ? "往期" : item.kind === "event" ? "讲座 / 活动" : "留句话"}</span></div>
    <div className={styles.boardContent}>
      {item.kind === "event" && <time className={styles.dateStamp} dateTime={item.startsAt || undefined}><span>{date ? `${Number(date.slice(5, 7))} 月` : "日期"}</span><b>{date ? Number(date.slice(8, 10)) : "—"}</b></time>}
      <div className={styles.copy}>
        {item.title && <h2>{item.title}</h2>}
        {item.kind === "event" && <p className={styles.when}><time dateTime={item.startsAt || undefined}>{boardEventTime(item)}</time><span>{item.location || "地点待定"}</span></p>}
        {item.kind === "event" && item.guest && <p className={styles.guest}>{item.guest}</p>}
        {(!compact || item.kind === "note") && <p className={`${styles.body} ${compact ? styles.excerpt : ""}`}>{item.body || "在这里写下想说的话。"}</p>}
        {!compact && item.guestBio && <details className={styles.bio}><summary>嘉宾简介</summary><p>{item.guestBio}</p></details>}
      </div>
    </div>
    <div className={styles.tray} aria-hidden="true"><i /><i /></div>
  </div>;
}

export function BoardPublishedDate({ value }: { value: string | null }) {
  return value ? <time className={styles.published} dateTime={value}>{boardDate(value, "day")} 写下</time> : null;
}
