const { getCatalog } = require('../../lib/catalog');
const domain = require('../../lib/domain');
const planner = require('../../lib/planner');
const campus = require('../../lib/campus-links');
const ui = require('../../lib/ui');
const account = require('../../lib/account');
const cloudView = require('../../lib/cloud-view');
const courseEntry = require('../../lib/course-entry');

// The same individual-period clocks as the published website's personal-events.ts.
const PERIOD_CLOCKS = [['08:00', '08:45'], ['08:50', '09:35'], ['09:55', '10:40'], ['10:45', '11:30'],
  ['13:00', '13:45'], ['13:50', '14:35'], ['14:40', '15:25'], ['18:15', '19:00'], ['19:05', '19:50'], ['19:55', '20:40']];
const PRIVATE_EMPTY = { meetings: [], events: [], tasks: [], exams: [], examCount: 0, examNotice: '', agenda: [], primary: null,
  primaryLabel: '', primaryDateLabel: '', primaryMark: '课', count: 0, hasTimetable: false };
function meetingTime(meeting) {
  const periods = meeting.periods;
  if (!periods?.length || periods.some(p => !Number.isInteger(p) || !PERIOD_CLOCKS[p - 1])) return { blockTime: '', start: null, end: null };
  const startTime = PERIOD_CLOCKS[Math.min(...periods) - 1][0], endTime = PERIOD_CLOCKS[Math.max(...periods) - 1][1];
  return { blockTime: startTime + '–' + endTime, start: planner.timeNumber(startTime), end: planner.timeNumber(endTime) };
}
function viewMeeting(meeting) { return { ...domain.meetingView(meeting), ...meetingTime(meeting) }; }
function meetingOrder(a, b) { return Math.min(...a.periods) - Math.min(...b.periods) || a.id.localeCompare(b.id); }
function weekOn(context, now) {
  const week = domain.teachingWeek(context.settings, now);
  if (context.settings.mode !== 'auto' || context.maximumWeek <= 18 || week.state !== 'after') return week;
  const number = Math.floor((domain.dateNumber(domain.chinaDate(now)) - domain.dateNumber(context.settings.startDate)) / 604800000) + 1;
  return number <= context.maximumWeek ? { week: number, state: 'active', label: '按开学日期计算' } : week;
}
function upcomingMeeting(context, today, nowMinutes, todayMeetings, week) {
  if (week.state === 'manual') return todayMeetings[0] || null;
  if (week.state !== 'active') return null;
  const remaining = todayMeetings.find(meeting => !Number.isFinite(meeting.end) || meeting.end > nowMinutes);
  if (remaining) return remaining;
  for (let offset = 1; offset <= 7; offset++) {
    const date = new Date(domain.dateNumber(today) + offset * 86400000).toISOString().slice(0, 10);
    const futureWeek = weekOn(context, new Date(date + 'T04:00:00Z'));
    if (futureWeek.state !== 'active') continue;
    const day = domain.weekdayOf(date), candidates = context.meetings
      .filter(m => m.term === context.term && m.weekday === day && m.weeks.includes(futureWeek.week)).sort(meetingOrder);
    if (candidates.length) return { ...viewMeeting(candidates[0]), nextDate: date };
  }
  return null;
}
Page({
  data: { ...PRIVATE_EMPTY, week: null, readOnly: false, cloudReady: false, hasTimetable: false },
  onShow() {
    this.unsubscribe?.();
    this.unsubscribe = account.subscribe(() => this.refresh());
    this.refresh();
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (typeof setInterval === 'function') this.clockTimer = setInterval(() => this.refresh(), 60000);
  },
  onHide() { this.stopWatching(); if (this.data.readOnly) this.setData(PRIVATE_EMPTY); },
  onUnload() { this.stopWatching(); if (this.data.readOnly) this.setData(PRIVATE_EMPTY); },
  stopWatching() { this.unsubscribe?.(); this.unsubscribe = null; if (this.clockTimer) clearInterval(this.clockTimer); this.clockTimer = null; },
  refresh() {
    // Clear before reading so a failed refresh or changed source cannot leave another account's rows visible.
    this.setData(PRIVATE_EMPTY);
    ui.safely(() => {
      const current = new Date(Date.now()), date = domain.chinaDate(current), now = new Date(current.getTime() + 8 * 3600000);
      const minutes = now.getUTCHours() * 60 + now.getUTCMinutes(), c = getCatalog(), state = cloudView.read(c);
      const week = weekOn(state, current), day = domain.weekdayOf(date);
      const meetings = week.week ? state.meetings.filter(m => m.term === state.term && m.weekday === day && m.weeks.includes(week.week))
        .sort(meetingOrder).map(viewMeeting) : [];
      const primary = upcomingMeeting(state, date, minutes, meetings, week), summary = cloudView.todaySummary(state, date);
      const todayTasks = state.readOnly ? (state.state?.assignments || []).filter(t => !t.completed && t.dueDate === date) :
        planner.load().items.filter(t => t.kind === 'task' && !t.completed && t.date === date);
      const agenda = [...meetings.map(m => ({ id: m.id, key: 'course-' + m.id, courseId: m.courseId, kind: 'course', kindLabel: '课程',
        title: m.title, time: m.blockTime || m.periodLabel, meta: m.location + ' · ' + (m.teacher || '教师未标注'),
        past: week.state === 'active' && Number.isFinite(m.end) && m.end <= minutes, order: Number.isFinite(m.start) ? m.start : 1440 })),
      ...summary.events.map(e => ({ id: e.id, key: 'event-' + e.id, kind: 'event', kindLabel: '日程', title: e.title,
        time: [e.startTime, e.endTime].filter(Boolean).join('–') || '时间待定', meta: e.location || '未设置地点',
        past: planner.timeNumber(e.endTime) <= minutes, order: Number.isFinite(planner.timeNumber(e.startTime)) ? planner.timeNumber(e.startTime) : 1440 })),
      ...todayTasks.map(t => ({ id: t.id, key: 'task-' + t.id, kind: 'task', kindLabel: '作业', title: t.title, time: '今天截止',
        meta: c.courseById.get(t.courseId)?.title || '未关联课程', past: false, order: 1440 }))].sort((a, b) => a.order - b.order);
      const future = primary?.nextDate;
      this.setData({ date, dateLabel: Number(date.slice(5, 7)) + '月' + Number(date.slice(8)) + '日 星期' + '一二三四五六日'[day - 1],
        clock: now.toISOString().slice(11, 16), timePosition: 4 + Math.max(0, Math.min(1, (minutes - 360) / 960)) * 92,
        weekdayLabel: domain.WEEKDAYS[day - 1], termLabel: state.academic ? state.academicYear + ' ' + (state.academic.termLabel || ui.termLabel(state.term)) : ui.termLabel(state.term),
        week: week.week, weekLabel: week.label, manual: week.state === 'manual' && !state.readOnly,
        primary, primaryLabel: week.state === 'manual' ? '所选周课程' : future ? '下一节课 · ' + domain.WEEKDAYS[primary.weekday - 1] :
          primary && !Number.isFinite(primary.start) ? '今日课程 · 时间待确认' : primary && primary.start <= minutes ? '正在上课' : primary ? '接下来' : '此刻',
        primaryDateLabel: future ? Number(future.slice(5, 7)) + '月' + Number(future.slice(8)) + '日 · ' : '',
        primaryMark: primary ? [...primary.title].slice(0, 2).join('') : '课', count: state.sectionCount,
        hasTimetable: state.sectionCount > 0 || Boolean(state.hasAcademic), readOnly: state.readOnly, cloudReady: state.ready,
        ...summary, ...cloudView.examSummary(state, current), meetings, agenda });
    });
  },
  settings() { wx.navigateTo({ url: this.data.readOnly ? '/pages/account/index' : '/pages/settings/index' }); },
  courses() { courseEntry.setQuery(''); wx.switchTab({ url: '/pages/courses/index' }); },
  search() { courseEntry.setQuery(''); wx.switchTab({ url: '/pages/courses/index' }); },
  classes() { wx.navigateTo({ url: '/pages/classes/index' }); },
  timetable() { wx.switchTab({ url: '/pages/timetable/index' }); },
  rooms() { wx.switchTab({ url: '/pages/rooms/index' }); },
  planner(e) { const kind = e?.currentTarget?.dataset?.kind; wx.navigateTo({ url: '/pages/planner/index' + (['task', 'event'].includes(kind) ? '?kind=' + kind : '') }); },
  account() { wx.navigateTo({ url: '/pages/account/index' }); },
  copy(e) { campus.copy(e.currentTarget.dataset.key); },
  complete(e) { if (this.data.readOnly) return; ui.safely(() => { planner.toggle(e.currentTarget.dataset.id); this.refresh(); }); },
  open(e) {
    const id = e.currentTarget.dataset.id, m = this.data.meetings.find(m => m.id === id) || (this.data.primary?.id === id ? this.data.primary : null);
    if (!m) return;
    if (this.data.readOnly) wx.navigateTo({ url: '/pages/cloud-detail/index?id=' + encodeURIComponent(m.id) + '&term=' + m.term });
    else ui.detail(m.courseId, m.term, m.id);
  },
  agendaOpen(e) { if (e.currentTarget.dataset.kind === 'course') this.open(e); else this.planner(); }
});
