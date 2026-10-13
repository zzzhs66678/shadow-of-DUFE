const { getCatalog } = require('../../lib/catalog');
const store = require('../../lib/store');
const domain = require('../../lib/domain');
const ui = require('../../lib/ui');
Page({
  data: { course: null, sections: [], termLabel: '', focused: false, staleMeeting: false, showAll: false },
  onLoad(options) { this.courseId = ui.queryValue(options.id); this.term = options.term === 'spring' ? 'spring' : 'fall'; this.meetingId = ui.queryValue(options.meeting); },
  onShow() { this.refresh(); },
  refresh() { ui.safely(() => {
    const c = getCatalog(), state = store.load(c);
    const selected = c.schedules.filter(m => state.sectionIds.includes(m.sectionId));
    const sourceMeeting = this.meetingId ? c.schedules.find(m => m.id === this.meetingId && m.courseId === this.courseId && m.term === this.term) : null;
    const sections = c.sections.filter(s => s.courseId === this.courseId && s.term === this.term);
    this.setData({ course: c.courseById.get(this.courseId) || null, termLabel: ui.termLabel(this.term),
      focused: Boolean(this.meetingId), staleMeeting: Boolean(this.meetingId && !sourceMeeting), totalSections: sections.length,
      sections: sections.filter(s => !this.meetingId || (sourceMeeting && (this.data.showAll || s.id === sourceMeeting.sectionId)))
        .sort((a, b) => Number(b.id === sourceMeeting?.sectionId) - Number(a.id === sourceMeeting?.sectionId)).map(s => ({
        ...s, meetings: s.meetings.map(domain.meetingView), added: state.sectionIds.includes(s.id),
        conflicts: [...new Set(selected.filter(m => m.sectionId !== s.id && s.meetings.some(n => domain.conflict(m, n))).map(m => m.title))].join('、')
      })) });
  }); },
  expand() { this.setData({ showAll: !this.data.showAll }); this.refresh(); },
  add(e) {
    const id = e.currentTarget.dataset.id;
    ui.safely(() => {
      // Recompute immediately before saving; never trust an earlier page snapshot.
      const c = getCatalog(), s = c.sectionById.get(id), state = store.load(c);
      if (!s) throw new Error('该教学班未找到，请返回重新查询。');
      if (state.sectionIds.includes(id)) return;
      const conflicts = c.schedules.filter(m => state.sectionIds.includes(m.sectionId) && s.meetings.some(n => domain.conflict(m, n)));
      const persist = () => ui.safely(() => { store.addSections(c, [id]); this.refresh(); wx.showToast({ title: '已加入课表', icon: 'success' }); });
      if (conflicts.length) wx.showModal({ title: '上课时间有冲突', content: '与“' + [...new Set(conflicts.map(m => m.title))].join('、') + '”的有效周和实际节次重叠。仍要加入全部时段吗？', success: r => { if (r.confirm) persist(); } });
      else persist();
    });
  }
});
