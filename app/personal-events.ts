import type { PersonalActivity } from "./personal-sync";

// Legacy campus blocks remain readable; explicit clock times are authoritative.
export const activityBlockTimes = [
  ["08:00", "09:35"], ["09:55", "11:30"],
  ["13:00", "15:25"], ["18:15", "20:40"],
] as const;
export function clockMinutes(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}
export function validEventTimes(start: string, end: string) {
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return clock.test(start) && clock.test(end) && end > start;
}
export function validEventDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= "2000-01-01" && date <= "2100-12-31" &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
type ClockSlot = Pick<PersonalActivity, "block" | "startTime" | "endTime"> & { periods?: number[] };
const periodClocks = [
  ["08:00", "08:45"], ["08:50", "09:35"],
  ["09:55", "10:40"], ["10:45", "11:30"],
  ["13:00", "13:45"], ["13:50", "14:35"], ["14:40", "15:25"],
  ["18:15", "19:00"], ["19:05", "19:50"], ["19:55", "20:40"],
] as const;
export function activityTimes(item: ClockSlot) {
  const fallback = activityBlockTimes[item.block - 1] ?? activityBlockTimes[0];
  if (!item.startTime && item.periods?.length && item.periods.every((period) => Number.isInteger(period) && period >= 1 && period <= periodClocks.length)) {
    return [periodClocks[Math.min(...item.periods) - 1][0], periodClocks[Math.max(...item.periods) - 1][1]] as const;
  }
  return [item.startTime ?? fallback[0], item.endTime ?? fallback[1]] as const;
}
export function activityTimeLabel(item: PersonalActivity) {
  return activityTimes(item).join("–");
}
export function activityStart(item: ClockSlot) {
  return clockMinutes(activityTimes(item)[0]);
}
export function activityTimesOverlap(left: ClockSlot, right: ClockSlot) {
  const [leftStart, leftEnd] = activityTimes(left);
  const [rightStart, rightEnd] = activityTimes(right);
  return leftStart < rightEnd && rightStart < leftEnd;
}
export function activityBlock(start: string) {
  const minute = clockMinutes(start);
  return minute < 595 ? 1 : minute < 780 ? 2 : minute < 1095 ? 3 : 4;
}
export function activityOccursOn(item: PersonalActivity, date: string) {
  if (item.repeat === "none") return item.date === date;
  const weekday = new Date(`${date}T12:00:00`).getDay() || 7;
  return item.weekday === weekday && (!item.date || date >= item.date);
}
export function eventLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function eventWeekDate(weekday: number, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() - ((date.getDay() || 7) - 1) + weekday - 1);
  return eventLocalDate(date);
}
export function activityListOrder(item: PersonalActivity, now = new Date()) {
  let date = item.date;
  if (item.repeat !== "none") {
    const next = new Date(now);
    next.setDate(next.getDate() + (item.weekday - (next.getDay() || 7) + 7) % 7);
    date = eventLocalDate(next);
    if (item.date && item.date > date) date = item.date;
  }
  return new Date(`${date}T00:00:00`).getTime() + activityStart(item) * 60_000;
}
