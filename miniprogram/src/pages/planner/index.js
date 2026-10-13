const planner = require('../../lib/planner');
const domain = require('../../lib/domain');
const { getCatalog } = require('../../lib/catalog');
const store = require('../../lib/store');
const ui = require('../../lib/ui');
const account = require('../../lib/account');
const cloudView = require('../../lib/cloud-view');
function empty(kind = 'task') { return { id: '', kind, title: '', notes: '', date: domain.chinaDate(), completed: false,
  courseId: '', location: '', startTime: '12:00', endTime: '13:00', repeat: 'none', repeatUntil: '' }; }
function makeId() { return 'mini-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
Page({
  data: { rows: [], filter: 'pending', editing: false, draft: empty(), dirty: false, courses: [], courseIndex: 0 },
  onLoad(options) { this.initialKind = ['event', 'task'].includes(options.kind) ? options.kind : ''; },
  onShow() { this.unsubscribe?.();this.unsubscribe=account.subscribe(()=>this.refresh());this.refresh(); if (this.initialKind && !this.data.readOnly) { this.openDraft(empty(this.initialKind)); this.initialKind = ''; } },
  onHide() { this.unsubscribe?.();if(this.data.readOnly)this.setData({rows:[],draft:empty(),editing:false}); },
  refresh() { ui.safely(() => {
    const c=getCatalog(),context=cloudView.read(c),today=domain.chinaDate();
    this.setData({readOnly:context.readOnly});
    if(context.readOnly){
      const state=context.state,rows=state ? [
        ...state.assignments.map(t=>({...t,kind:'task',date:t.dueDate})),
        ...(context.academic?.exams || []).map(e=>({...e,kind:'exam',date:e.date || '',title:e.courseName || e.courseCode,
          location:e.location || [e.campus,e.building,e.room].filter(Boolean).join(' · ') || '考场待定',
          notes:[e.seat ? '座位 '+e.seat : '',e.examNumber ? '考号 '+e.examNumber : ''].filter(Boolean).join(' · ')})),
        ...state.activities.map(e=>({...e,kind:'event',date:e.date || '',
          startTime:e.startTime || ['08:00','09:55','13:00','18:15'][e.block-1],
          endTime:e.endTime || ['09:35','11:30','15:25','20:40'][e.block-1]}))] : [];
      this.courseOptions=[];
      this.setData({examNotice:cloudView.examSummary(context).examNotice,courses:[],editing:false,dirty:false,draft:empty(),rows:rows
        .filter(i=>this.data.filter==='all' || (i.kind==='task' ? !i.completed : i.repeat==='weekly' || !i.date || i.date>=today))
        .sort((a,b)=>a.date.localeCompare(b.date)||(a.startTime||'').localeCompare(b.startTime||''))
        .map(i=>({...i,courseTitle:c.courseById.get(i.courseId)?.title || '',
          dueLabel:i.kind==='task' && !i.completed && i.date<today ? '已逾期' : i.date || '日期待定',
          repeatLabel:i.repeat==='weekly' ? '每'+(domain.WEEKDAYS[(i.weekday||domain.weekdayOf(i.date))-1] || '周') : ''}))});this.protect();return;
    }
    const state = planner.load(), s = store.load(c);
    const courseIds = [...new Set(s.sectionIds.map(id => c.sectionById.get(id)?.courseId).filter(Boolean))];
    this.courseOptions = [{ id: '', title: '不关联课程' }, ...courseIds.map(id => ({ id, title: c.courseById.get(id)?.title || id }))];
    this.setData({ courses: this.courseOptions.map(i => i.title), rows: state.items.filter(i => this.data.filter === 'all' || (i.kind === 'task' ? !i.completed : (i.repeat === 'weekly' ? i.repeatUntil : i.date) >= today))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''))
      .map(i => ({ ...i, courseTitle: c.courseById.get(i.courseId)?.title || '',
        dueLabel: i.kind === 'task' && !i.completed && i.date < today ? '已逾期' : i.date,
        repeatLabel: i.repeat === 'weekly' ? '每周重复至' + i.repeatUntil : '' })) });
  }); },
  filterChange(e) { this.setData({ filter: e.currentTarget.dataset.filter }); this.refresh(); },
  begin(e) {
    if(this.data.readOnly)return;
    const kind = e.currentTarget.dataset.kind === 'event' ? 'event' : 'task';
    const start = () => this.openDraft(empty(kind)); this.guardDiscard(start);
  },
  edit(e) { if(this.data.readOnly)return;ui.safely(() => { const item = planner.load().items.find(i => i.id === e.currentTarget.dataset.id); if (!item) throw new Error('内容已变化，请刷新列表。');
    this.guardDiscard(() => this.openDraft({ ...item })); }); },
  openDraft(draft) { if(this.data.readOnly)return;this.baseline = JSON.stringify(draft); this.setData({ editing: true, draft, dirty: false,
    courseIndex: Math.max(0, (this.courseOptions || []).findIndex(i => i.id === draft.courseId)) }); },
  field(e) { if(this.data.readOnly)return;const name = e.currentTarget.dataset.field; if (!['title', 'notes', 'date', 'location', 'startTime', 'endTime', 'repeatUntil'].includes(name)) return;
    const draft = { ...this.data.draft, [name]: e.detail.value }; this.setData({ draft, dirty: JSON.stringify(draft) !== this.baseline }); this.protect(); },
  courseChange(e) { if(this.data.readOnly)return;const index = Number(e.detail.value), course = this.courseOptions[index]; if (!course) return;
    const draft = { ...this.data.draft, courseId: course.id }; this.setData({ courseIndex: index, draft, dirty: JSON.stringify(draft) !== this.baseline }); this.protect(); },
  repeatChange(e) { if(this.data.readOnly)return;const draft = { ...this.data.draft, repeat: e.detail.value ? 'weekly' : 'none' }; this.setData({ draft, dirty: JSON.stringify(draft) !== this.baseline }); this.protect(); },
  protect() { if (this.data.dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '日程或作业尚未保存。' });
    else if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); },
  guardDiscard(action) { if (!this.data.editing || !this.data.dirty) { action(); return; }
    wx.showModal({ title: '放弃未保存的修改？', content: '已经保存的内容会保留。', success: r => { if (r.confirm) { this.setData({ dirty: false }); this.protect(); action(); } } }); },
  cancel() { this.guardDiscard(() => { this.setData({ editing: false, dirty: false }); this.protect(); }); },
  save() { if(this.data.readOnly)return;ui.safely(() => { const draft = { ...this.data.draft, title: this.data.draft.title.trim(), id: this.data.draft.id || makeId() };
    planner.upsert(draft); this.setData({ editing: false, dirty: false }); this.protect(); this.refresh(); wx.showToast({ title: '已保存', icon: 'success' }); }); },
  toggle(e) { if(this.data.readOnly)return;ui.safely(() => { planner.toggle(e.currentTarget.dataset.id); this.refresh(); }); },
  remove(e) { if(this.data.readOnly)return;const id = e.currentTarget.dataset.id; wx.showModal({ title: '删除这项内容？', content: '删除后无法恢复；每周重复日程会一起删除。',
    success: r => { if (r.confirm && !this.data.readOnly) ui.safely(() => { planner.remove(id);if(this.data.draft.id===id){this.setData({editing:false,dirty:false,draft:empty()});this.protect();} this.refresh(); }); } }); },
  onUnload() { this.unsubscribe?.();if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); }
});
