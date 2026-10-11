import { isSameScheduledMeeting, scheduledMeetingsOverlap, type ScheduledMeeting } from "./schedule-reconciliation.ts";

export type ScheduleConflict<T extends ScheduledMeeting> = {
  meeting: T;
  active: T;
  weekday: number;
  /** null means unknown, never an invented broad block or all-week set. */
  periods: number[] | null;
  weeks: number[] | null;
};

export function knownNumberSet(values: readonly number[] | undefined, maximum: number): number[] | null {
  if (!Array.isArray(values) || !values.length) return null;
  const copy = [...values];
  if (copy.some((value) => !Number.isInteger(value) || value < 1 || value > maximum)) return null;
  return [...new Set(copy)].sort((a, b) => a - b);
}

/** Ask the existing predicate for precise periods, including its strict legacy-text rules.
 * A deliberately impossible display block prevents its unknown-period fallback from
 * masquerading as exact evidence. This keeps a single parser/source of overlap truth.
 */
export function exactMeetingPeriods(meeting: ScheduledMeeting): number[] | null {
  if (meeting.periods !== undefined && meeting.periods?.length !== 0) return knownNumberSet(meeting.periods, 14);
  const withoutWeeks = { ...meeting, weeks: undefined };
  const periods = Array.from({ length: 14 }, (_, index) => index + 1).filter((period) =>
    scheduledMeetingsOverlap(withoutWeeks, {
      courseId: "", term: meeting.term, weekday: meeting.weekday,
      block: Number.NaN, periods: [period],
    }),
  );
  return periods.length ? periods : null;
}

export function scheduleConflictDetails<T extends ScheduledMeeting>(meetings: readonly T[], active: readonly T[]): ScheduleConflict<T>[] {
  const result: ScheduleConflict<T>[] = [];
  const evidence = new Map<T, { periods: number[] | null; weeks: number[] | null }>();
  const read = (item: T) => {
    let value = evidence.get(item);
    if (!value) {
      value = { periods: exactMeetingPeriods(item), weeks: knownNumberSet(item.weeks, 30) };
      evidence.set(item, value);
    }
    return value;
  };
  for (const meeting of meetings) {
    for (const other of active) {
      if ((meeting.id && meeting.id === other.id) || isSameScheduledMeeting(meeting, other)) continue;
      const left = read(meeting);
      const right = read(other);
      if (!scheduledMeetingsOverlap(
        { ...meeting, weeks: left.weeks ?? undefined },
        { ...other, weeks: right.weeks ?? undefined },
      )) continue;
      result.push({
        meeting, active: other, weekday: meeting.weekday,
        periods: left.periods && right.periods ? left.periods.filter((p) => right.periods!.includes(p)) : null,
        weeks: left.weeks && right.weeks ? left.weeks.filter((w) => right.weeks!.includes(w)) : null,
      });
    }
  }
  return result;
}

export function compactNumberSet(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    let end = start;
    while (sorted[index + 1] === end + 1) end = sorted[++index];
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join("、");
}
