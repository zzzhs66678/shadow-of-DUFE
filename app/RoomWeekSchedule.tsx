"use client";

import { useState } from "react";
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
  /** Only this room's meetings active in the selected teaching week. */
  lessons: RoomWeekLesson[];
};

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export default function RoomWeekSchedule(props: RoomWeekScheduleProps) {
  return (
    <RoomWeekScheduleContent
      key={JSON.stringify([
        props.building,
        props.room,
        props.date,
        props.week,
        props.selectedWeekday,
      ])}
      {...props}
    />
  );
}

function RoomWeekScheduleContent({
  building,
  room,
  date,
  week,
  selectedWeekday,
  lessons,
}: RoomWeekScheduleProps) {
  const [activeDay, setActiveDay] = useState(selectedWeekday);
  const [showWholeWeek, setShowWholeWeek] = useState(false);
  const days = weekdays.map((label, index) => ({
    label,
    weekday: index + 1,
    lessons: lessons
      .filter((lesson) => lesson.weekday === index + 1)
      .sort(
        (a, b) =>
          a.block - b.block ||
          a.title.localeCompare(b.title, "zh-CN") ||
          a.id.localeCompare(b.id),
      ),
  }));
  const visibleDays = showWholeWeek
    ? days
    : days.filter((day) => day.weekday === activeDay);

  return (
    <section
      className={styles.schedule}
      id="room-week-schedule"
      aria-labelledby="room-week-title"
    >
      <header className={styles.heading}>
        <div>
          <h3 id="room-week-title">
            {building} {room} <span>· 一周课表</span>
          </h3>
          <p className={styles.weekContext}>
            <time dateTime={date}>{date}</time> 所在周
            <span>
              {week === null ? "非教学周" : `第 ${week} 教学周`}
            </span>
          </p>
        </div>
        {week !== null && (
          <button
            className={styles.weekToggle}
            type="button"
            aria-pressed={showWholeWeek}
            aria-controls="room-week-lessons"
            onClick={() => setShowWholeWeek((show) => !show)}
          >
            显示整周
          </button>
        )}
      </header>

      {week === null ? (
        <p className={styles.outsideTerm}>
          所选日期不在当前学期教学周内。请在上方选择学期内日期，再查看对应课表。
        </p>
      ) : (
        <>
          <div className={styles.dayPicker} role="group" aria-label="按星期查看课程">
            {days.map((day) => (
              <button
                className={styles.dayButton}
                key={day.weekday}
                type="button"
                aria-pressed={!showWholeWeek && activeDay === day.weekday}
                aria-controls="room-week-lessons"
                aria-label={`${day.label}，已收录 ${day.lessons.length} 条课程安排${day.weekday === selectedWeekday ? "，所选日期" : ""}`}
                onClick={() => {
                  setActiveDay(day.weekday);
                  setShowWholeWeek(false);
                }}
              >
                <span>{day.label}</span>
                <small>{day.lessons.length} 条</small>
              </button>
            ))}
          </div>

          <p className={styles.screenReaderOnly} role="status">
            {showWholeWeek
              ? "正在显示整周课程安排"
              : `正在显示${weekdays[activeDay - 1]}，已收录 ${visibleDays[0]?.lessons.length ?? 0} 条课程安排`}
          </p>

          <div
            className={`${styles.days}${showWholeWeek ? ` ${styles.wholeWeek}` : ""}`}
            id="room-week-lessons"
          >
            {visibleDays.map((day) => (
              <section
                className={styles.day}
                key={day.weekday}
                aria-labelledby={`room-week-day-${day.weekday}`}
              >
                <header className={styles.dayHeading}>
                  <h4 id={`room-week-day-${day.weekday}`}>
                    {day.label}
                    {day.weekday === selectedWeekday && <span>所选日期</span>}
                  </h4>
                  <span>{day.lessons.length} 条课程安排</span>
                </header>
                {day.lessons.length ? (
                  <ul className={styles.lessonList}>
                    {day.lessons.map((lesson) => (
                      <li className={styles.lesson} key={lesson.id}>
                        <span className={styles.period}>
                          {lesson.periodLabel || "节次未提供"}
                        </span>
                        <div className={styles.lessonContent}>
                          <strong>{lesson.title || "课程名称未提供"}</strong>
                          <p className={styles.lessonDetails}>
                            <span>{lesson.teacher || "教师未提供"}</span>
                            <span>{lesson.timeText || "周次与时间未提供"}</span>
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.emptyDay}>
                    当日未收录课程，不代表教室空闲。
                  </p>
                )}
              </section>
            ))}
          </div>
        </>
      )}

      <p className={styles.disclaimer}>
        仅反映已收录课程，不代表教室开放或预约状态。
      </p>
    </section>
  );
}
