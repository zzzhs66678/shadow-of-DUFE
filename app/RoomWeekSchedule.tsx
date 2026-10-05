"use client";

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
  const sortedLessons = [...lessons].sort(
    (left, right) =>
      left.weekday - right.weekday ||
      left.block - right.block ||
      left.title.localeCompare(right.title, "zh-CN") ||
      left.id.localeCompare(right.id),
  );

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
        <p>整周课程已展开；手机左右滑动查看。</p>
      </header>

      {week === null ? (
        <p className={styles.outsideTerm}>
          所选日期不在当前学期教学周内。返回空教室页换一个日期再看。
        </p>
      ) : (
        <div
          className={styles.boardViewport}
          role="region"
          aria-label={`${building}${room}第 ${week} 教学周全部课程`}
          tabIndex={0}
        >
          <div className={styles.board} role="table" aria-rowcount={periods.length + 1} aria-colcount={8}>
            <div className={styles.headerRow} role="row">
              <span className={styles.corner} role="columnheader">节次</span>
              {weekdays.map((label, index) => (
                <span
                  className={index + 1 === selectedWeekday ? styles.selectedDay : ""}
                  key={label}
                  role="columnheader"
                >
                  {label}
                  {index + 1 === selectedWeekday && <small>所选日期</small>}
                </span>
              ))}
            </div>

            {periods.map((period) => (
              <div className={styles.periodRow} key={period.block} role="row">
                <header role="rowheader">
                  <strong>{period.short}</strong>
                  <small>{period.time}</small>
                </header>
                {weekdays.map((label, index) => {
                  const weekday = index + 1;
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
      )}

      <p className={styles.disclaimer}>
        仅反映已收录课程，不代表教室开放或预约状态。
      </p>
    </section>
  );
}
