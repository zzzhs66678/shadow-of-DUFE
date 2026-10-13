const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const BLOCK_PERIODS = [[1, 2], [3, 4], [5, 6, 7], [8, 9, 10]];
function splitClasses(text) { return String(text || '').split(/[、，,；;]/).map(s => s.trim()).filter(Boolean); }
function normalize(text) { return String(text || '').toLowerCase().replace(/[\s·•—_\-（）()]/g, ''); }
function intersects(a, b) { return a.some(v => b.includes(v)); }
function conflict(a, b) {
  return a.term === b.term && a.weekday === b.weekday && intersects(a.weeks, b.weeks) && intersects(a.periods, b.periods);
}
function formatWeeks(weeks) {
  const values = [...new Set(weeks)].sort((a, b) => a - b), parts = [];
  for (let i = 0; i < values.length; i++) {
    const first = values[i]; let last = first;
    while (values[i + 1] === last + 1) last = values[++i];
    parts.push(first === last ? String(first) : first + '–' + last);
  }
  return parts.join('、') + '周';
}
function groupSections(meetings) {
  const groups = new Map();
  for (const m of meetings) {
    if (!groups.has(m.sectionId)) groups.set(m.sectionId, { id: m.sectionId, courseId: m.courseId,
      term: m.term, title: m.title, teacher: m.teacher, classNames: m.classNames, meetings: [] });
    groups.get(m.sectionId).meetings.push(m);
  }
  return [...groups.values()].map(s => ({ ...s, meetings: s.meetings.sort((a, b) => a.weekday - b.weekday || a.periods[0] - b.periods[0]) }));
}
function classSectionIds(meetings, term, className) {
  if (!className) return [];
  return [...new Set(meetings.filter(m => m.term === term && splitClasses(m.classNames).includes(className)).map(m => m.sectionId))];
}
function dayMeetings(meetings, ids, term, week, weekday) {
  if (!Number.isInteger(week) || week < 1 || week > 18) return [];
  const selected = new Set(ids);
  return meetings.filter(m => selected.has(m.sectionId) && m.term === term && m.weekday === weekday && m.weeks.includes(week))
    .sort((a, b) => a.periods[0] - b.periods[0] || a.title.localeCompare(b.title, 'zh-CN'));
}
function classroomAvailability(meetings, options) {
  const { buildings, building, term, week, weekday, block } = options;
  if (!Number.isInteger(week) || week < 1 || week > 18 || !BLOCK_PERIODS[block - 1]) return [];
  const rooms = new Map();
  for (const m of meetings) {
    if (!m.room || !buildings.includes(m.building) || (building && m.building !== building)) continue;
    const key = JSON.stringify([m.building, m.room]);
    if (!rooms.has(key)) rooms.set(key, { id: key, building: m.building, room: m.room, free: true });
    if (m.term === term && m.weekday === weekday && m.weeks.includes(week) && intersects(m.periods, BLOCK_PERIODS[block - 1])) {
      rooms.get(key).free = false;
    }
  }
  return [...rooms.values()].sort((a, b) => a.building.localeCompare(b.building, 'zh-CN') || a.room.localeCompare(b.room, 'zh-CN', { numeric: true }));
}
function chinaDate(now = new Date()) { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
function dateNumber(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || '')) return NaN;
  const ms = Date.parse(text + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? ms : NaN;
}
function weekdayOf(text) { const n = new Date(dateNumber(text)).getUTCDay(); return n === 0 ? 7 : n; }
function teachingWeek(settings, now = new Date()) {
  if (settings.mode !== 'auto') return { week: settings.week, label: '手动选择', state: 'manual' };
  const start = dateNumber(settings.startDate), today = dateNumber(chinaDate(now));
  if (!Number.isFinite(start)) return { week: null, label: '请设置开学日期', state: 'unset' };
  const week = Math.floor((today - start) / 604800000) + 1;
  if (week < 1) return { week: null, label: '尚未开学', state: 'before' };
  if (week > 18) return { week: null, label: '已超出课程数据的18周', state: 'after' };
  return { week, label: '按开学日期计算', state: 'active' };
}
function meetingView(m) {
  return { ...m, weekdayLabel: WEEKDAYS[m.weekday - 1], weeksLabel: formatWeeks(m.weeks),
    periodLabel: m.periods.join('、') + '节', location: [m.building, m.room].filter(Boolean).join(' ') || '地点待确认' };
}
function weekGrid(meetings, week, term, maximumWeek = 18) {
  const valid = Number.isInteger(week) && week >= 1 && week <= maximumWeek;
  const active = valid ? meetings.filter(m => m.term === term && m.weeks.includes(week)) : [];
  const blocks = BLOCK_PERIODS.map((periods,i) => i === 3 && active.some(m => m.periods.some(p => p > 10)) ? [8,9,10,11,12,13,14] : periods);
  return blocks.map((periods, i) => ({ block: i + 1, label: periods[0] + '–' + periods[periods.length - 1],
    days: WEEKDAYS.map((label, day) => ({ weekday: day + 1, label,
      meetings: active.filter(m => m.weekday === day + 1 && intersects(m.periods, periods)).map(meetingView) })) }));
}
module.exports = { WEEKDAYS, BLOCK_PERIODS, splitClasses, normalize, conflict, formatWeeks, groupSections,
  classSectionIds, dayMeetings, classroomAvailability, chinaDate, dateNumber, weekdayOf, teachingWeek, meetingView, weekGrid };
