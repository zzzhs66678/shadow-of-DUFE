const { getCatalog } = require('../../lib/catalog');
const domain = require('../../lib/domain');
const store = require('../../lib/store');
const ui = require('../../lib/ui');
Page({
  data: { terms: ['上学期', '下学期'], termIndex: 0, weeks: Array.from({ length: 18 }, (_, i) => '第' + (i + 1) + '周'),
    weekIndex: 0, days: domain.WEEKDAYS, dayIndex: 0, buildings: [], buildingIndex: 0, blocks: [], blockIndex: 0, rows: [], count: 0, more: false },
  onShow() { ui.safely(() => {
    const c = getCatalog(), s = store.load(c), current = domain.teachingWeek(s.terms[s.term]);
    this.setData({ termIndex: s.term === 'fall' ? 0 : 1, weekIndex: (current.week || s.terms[s.term].week) - 1,
      dayIndex: domain.weekdayOf(domain.chinaDate()) - 1, buildings: ['全部教学楼', ...c.buildings],
      blocks: c.periods.map(p => p.short + ' · ' + p.time) }); this.search();
  }); },
  change(e) { const field = e.currentTarget.dataset.field; if (!['termIndex', 'weekIndex', 'dayIndex', 'buildingIndex', 'blockIndex'].includes(field)) return; this.setData({ [field]: Number(e.detail.value) }); this.search(); },
  search() { ui.safely(() => {
    const c = getCatalog(), d = this.data;
    this.results = domain.classroomAvailability(c.schedules, { buildings: c.buildings,
      building: d.buildingIndex ? d.buildings[d.buildingIndex] : '', term: d.termIndex === 0 ? 'fall' : 'spring',
      week: d.weekIndex + 1, weekday: d.dayIndex + 1, block: d.blockIndex + 1 }).filter(room => room.free);
    this.visible = 40; this.render();
  }); },
  render() { this.setData({ rows: this.results.slice(0, this.visible), count: this.results.length, more: this.visible < this.results.length }); },
  more() { this.visible += 40; this.render(); },
  onReachBottom() { if (this.data.more) this.more(); },
  open(e) { const room = this.data.rows.find(r => r.id === e.currentTarget.dataset.id); if (room) wx.navigateTo({
    url: '/pages/room-detail/index?building=' + encodeURIComponent(room.building) + '&room=' + encodeURIComponent(room.room) +
      '&term=' + (this.data.termIndex === 0 ? 'fall' : 'spring') + '&week=' + (this.data.weekIndex + 1) }); }
});
