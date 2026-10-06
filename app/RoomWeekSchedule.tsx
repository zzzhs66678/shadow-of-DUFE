"use client";

import { useState, type CSSProperties } from "react";
import styles from "./room-week-schedule.module.css";

export type RoomWeekLesson = {
  id: string;
  title: string;
  teacher: string;
  /** Monday is 1; Sunday is 7, matching the course catalogue. */
  weekday: number;
  block: number;
  periodLabel: string;
  timeText: string;
};

export type RoomWeekScheduleProps = {
  building: string;
  room: string;
  date: string;
  week: number | null;
  selectedWeekday: number;
  periods: Array<{ block: number; short: string; time: string }>;
  favorite: boolean;
  onBack: () => void;
  onToggleFavorite: () => void;
  /** Only this room's meetings active in the selected teaching week. */
  lessons: RoomWeekLesson[];
};

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export default function RoomWeekSchedule({
  building,
  room,
  date,
  week,
  selectedWeekday,
  periods,
  favorite,
  onBack,
  onToggleFavorite,
  lessons,
}: RoomWeekScheduleProps) {
  const [showFullWeek, setShowFullWeek] = useState(false);
  const sortedLessons = [...lessons].sort(
    (left, right) =>
      left.weekday - right.weekday ||
      left.block - right.block ||
      left.title.localeCompare(right.title, "zh-CN") ||
      left.id.localeCompare(right.id),
  );
  // The caller has already filtered by the selected teaching week's exact
  // effective weeks. Never use another week's meetings to reveal a weekend.
  const compactWeekdays = weekdays
    .map((label, index) => ({ label, weekday: index + 1 }))
    .filter(
      ({ weekday }) =>
        weekday <= 5 ||
        weekday === selectedWeekday ||
        sortedLessons.some((lesson) => lesson.weekday === weekday),
    );
  const visibleWeekdays = showFullWeek
    ? weekdays.map((label, index) => ({ label, weekday: index + 1 }))
    : compactWeekdays;

  return (
    <section
      className={styles.schedule}
      id="room-week-schedule"
      aria-labelledby="room-week-title"
    >
      <div className={styles.actions}>
        <button type="button" onClick={onBack}>← 返回空教室</button>
        <button type="button" onClick={onToggleFavorite}>
          {favorite ? "★ 已收藏" : "☆ 设为常用"}
        </button>
      </div>
      <header className={styles.heading}>
        <div>
          <span>教室一周课表</span>
          <h2 id="room-week-title">{building} {room}</h2>
          <p className={styles.weekContext}>
            <time dateTime={date}>{date}</time>
            <span>{week === null ? "非教学周" : `第 ${week} 教学周`}</span>
            {week !== null && <b>{sortedLessons.length} 条课程安排</b>}
          </p>
        </div>
      </header>

      {week === null ? (
        <p className={styles.outsideTerm}>
          所选日期不在当前学期教学周内。返回空教室页换一个日期再看。
        </p>
      ) : (
        <>
          <div className={styles.viewControls}>
            <p>{showFullWeek ? "已显示周一至周日。" : "周末有课或为所选日期时自动显示。"}</p>
            {(compactWeekdays.length < 7 || showFullWeek) && (
              <button
                type="button"
                className={styles.weekToggle}
                aria-controls="room-week-board"
                aria-expanded={showFullWeek}
                onClick={() => setShowFullWeek((value) => !value)}
              >
                {showFullWeek ? "收起空白周末" : "查看全周"}
              </button>
            )}
          </div>
          {sortedLessons.length === 0 && (
            <p className={styles.noLessons}>本周暂无已收录课程。</p>
          )}
          <div
            className={styles.boardViewport}
            role="region"
            aria-label={`${building}${room}第 ${week} 教学周全部课程`}
            tabIndex={0}
          >
            <div
              id="room-week-board"
              className={styles.board}
              style={{ "--room-day-count": visibleWeekdays.length } as CSSProperties}
              role="table"
              aria-rowcount={periods.length + 1}
              aria-colcount={visibleWeekdays.length + 1}
            >
              <div className={styles.headerRow} role="row">
                <span className={styles.corner} role="columnheader">节次</span>
                {visibleWeekdays.map(({ label, weekday }) => (
                  <span
                    className={weekday === selectedWeekday ? styles.selectedDay : ""}
                    key={label}
                    role="columnheader"
                  >
                    {label}
                    {weekday === selectedWeekday && <small>所选日期</small>}
                  </span>
                ))}
              </div>

              {periods.map((period) => (
                <div className={styles.periodRow} key={period.block} role="row">
                  <header role="rowheader">
                    <strong>{period.short}</strong>
                    <small>{period.time}</small>
                  </header>
                  {visibleWeekdays.map(({ label, weekday }) => {
                    const cellLessons = sortedLessons.filter(
                      (lesson) =>
                        lesson.weekday === weekday && lesson.block === period.block,
                    );
                    return (
                      <div
                        className={`${styles.cell}${weekday === selectedWeekday ? ` ${styles.selectedCell}` : ""}`}
                        key={`${period.block}-${weekday}`}
                        role="cell"
                        aria-label={`${label}${period.short}，${cellLessons.length ? `${cellLessons.length} 条课程` : "无课程"}`}
                      >
                        {cellLessons.length ? (
                          cellLessons.map((lesson) => (
                            <article className={styles.lesson} key={lesson.id}>
                              <strong>{lesson.title || "课程名称未提供"}</strong>
                              <span>{lesson.teacher || "教师未提供"}</span>
                              <small>{lesson.timeText || period.time}</small>
                            </article>
                          ))
                        ) : (
                          <span className={styles.emptyCell} aria-hidden="true">—</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <p className={styles.disclaimer}>
        仅反映已收录课程，不代表教室开放或预约状态。
      </p>
    </section>
  );
}
