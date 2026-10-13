const { getCatalog } = require('../../lib/catalog');
const domain = require('../../lib/domain');
const ui = require('../../lib/ui');
Page({
  data: { building: '', room: '', days: [], weeks: Array.from({ length: 18 }, (_, i) => '第' + (i + 1) + '周'), weekIndex: 0, termLabel: '' },
  onLoad(options) { this.term = options.term === 'spring' ? 'spring' : 'fall';
    const week = Number(options.week); this.setData({ building: ui.queryValue(options.building), room: ui.queryValue(options.room),
      weekIndex: Number.isInteger(week) && week >= 1 && week <= 18 ? week - 1 : 0, termLabel: ui.termLabel(this.term) }); this.refresh(); },
  refresh() { const c = getCatalog(); this.meetings = c.schedules.filter(m => m.building === this.data.building && m.room === this.data.room && m.term === this.term && m.weeks.includes(this.data.weekIndex + 1));
    this.setData({ days: domain.WEEKDAYS.map((label, index) => ({ label, weekday: index + 1,
      meetings: this.meetings.filter(m => m.weekday === index + 1).sort((a, b) => a.periods[0] - b.periods[0]).map(domain.meetingView) })) }); },
  weekChange(e) { this.setData({ weekIndex: Number(e.detail.value) }); this.refresh(); },
  open(e) { const meeting = this.meetings.find(m => m.id === e.currentTarget.dataset.id); if (meeting) ui.detail(meeting.courseId, meeting.term, meeting.id); }
});
