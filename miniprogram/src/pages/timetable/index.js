const { getCatalog } = require('../../lib/catalog');
const store = require('../../lib/store');
const domain = require('../../lib/domain');
const ui = require('../../lib/ui');
const cloudView = require('../../lib/cloud-view');
const account = require('../../lib/account');
function currentWeek(settings, maximumWeek) {
  if (settings.mode !== 'auto') return domain.teachingWeek(settings);
  const start = domain.dateNumber(settings.startDate);
  if (!Number.isFinite(start)) return domain.teachingWeek(settings);
  const week = Math.floor((domain.dateNumber(domain.chinaDate()) - start) / 604800000) + 1;
  if (week < 1) return { week: null, label: '尚未开学' };
  if (week > maximumWeek) return { week: null, label: '已超出本学期课表周次' };
  return { week, label: '按开学日期计算' };
}
Page({
  data: { days: domain.WEEKDAYS, weekDays: domain.WEEKDAYS.slice(0, 5), dayHeaders: [], showFullWeek: false, weekday: 1, weeks: Array.from({ length: 18 }, (_, i) => '第' + (i + 1) + '周'), weekIndex: 0, meetings: [], grid: [], view: 'week', missing: 0, partial: 0, selectedCount: 0, term: 'fall', termLabel: '上学期', plans: [], planNames: [], readOnly: false, ready: true, academicYear: '' },
  onShow() { this.unsubscribe?.();this.unsubscribe=account.subscribe(()=>this.loadContext());this.loadContext(); },
  onHide() { this.unsubscribe?.();if(this.data.readOnly){this.selectedMeetings=[];this.setData({grid:[],meetings:[],selectedCount:0,plans:[],planNames:[],academicYear:'',missing:0,partial:0});} },
  onUnload() { this.unsubscribe?.(); },
  loadContext() { ui.safely(() => {
    const identity = account.context(),scope = account.websiteSource() && identity ? 'website:'+identity.userId+':'+identity.epoch : 'local';
    if(this.scope !== scope){this.scope=scope;this.queryPlan=null;this.queryTerm=null;this.planning=false;this.hasWeekSelection=false;this.contextTerm=null;}
    this.selectedMeetings=[];this.setData({meetings:[],grid:[],selectedCount:0});
    const c=getCatalog(),ctx=cloudView.read(c,{planId:this.queryPlan,term:this.queryTerm,planning:this.planning}),current=currentWeek(ctx.settings,ctx.maximumWeek);
    const initialWeek=Math.max(0,(current.week || ctx.settings.week || 1)-1),weekIndex=Math.min(this.hasWeekSelection && this.contextTerm===ctx.term ? this.data.weekIndex : initialWeek,ctx.maximumWeek-1);
    this.contextTerm=ctx.term;
    const selectedPlan=ctx.plans.find(p=>p.id===ctx.planId),planningView=!ctx.hasAcademic || this.planning;
    this.setData({term:ctx.term,termLabel:ui.termLabel(ctx.term),weekIndex,
      readOnly:ctx.readOnly,ready:ctx.ready,plans:ctx.plans.map(p=>({id:p.id,name:p.name,count:new Set(p.meetings.map(m=>m.sectionId)).size})),planNames:ctx.plans.map(p=>p.name),planIndex:Math.max(0,ctx.plans.findIndex(p=>p.id===ctx.planId)),
      hasAcademic:ctx.hasAcademic,planning:this.planning,sourceLabel:ctx.readOnly?'网站课表':'本机课表',termIndex:ctx.term==='spring'?1:0,terms:['上学期','下学期'],
      weeks:Array.from({length:ctx.maximumWeek},(_,i)=>'第'+(i+1)+'周'),
      academicYear:ctx.academicYear || '',notice:!ctx.ready?'网站课表尚未读取。':current.week?'':current.label+'，可选择周次查看。',
      missing:planningView?ctx.missing:0,partial:planningView?selectedPlan?.partialSectionIds?.length || 0:0});this.refresh();
  }); },
  refresh() { ui.safely(() => {
    const c = getCatalog(),ctx=cloudView.read(c,{planId:this.queryPlan,term:this.queryTerm,planning:this.planning});
    this.selectedMeetings = ctx.meetings;
    const active=this.selectedMeetings.filter(m=>m.term===this.data.term && m.weeks.includes(this.data.weekIndex+1)),todayWeekday=domain.weekdayOf(domain.chinaDate());
    const visibleDays = domain.WEEKDAYS.map((label, index) => ({ label, weekday: index + 1,today:index+1===todayWeekday })).filter(day => day.weekday <= 5 || this.data.showFullWeek || this.selectedMeetings.some(m => m.term === this.data.term && m.weekday === day.weekday));
    this.setData({ meetings: active.filter(m=>m.weekday===this.data.weekday).sort((a,b)=>a.periods[0]-b.periods[0]).map(domain.meetingView),
      selectedCount: ctx.sectionCount,activeCount:active.length,
      weekDays: visibleDays.map(day => day.label),dayHeaders:visibleDays,
      grid: domain.weekGrid(this.selectedMeetings, this.data.weekIndex + 1, this.data.term,ctx.maximumWeek).map(row => ({ ...row, time: c.periods[row.block - 1]?.time || '', days: row.days.filter(day => visibleDays.some(visible => visible.weekday === day.weekday)).map(day=>({...day,conflict:day.meetings.some((first,index)=>day.meetings.slice(index+1).some(second=>domain.conflict(first,second)))})) })) });
  }); },
  weekChange(e) { const index=Number(e.detail.value);if(!Number.isInteger(index) || index<0 || index>=this.data.weeks.length)return;this.hasWeekSelection=true;this.setData({ weekIndex:index }); this.refresh(); },
  shiftWeek(e) { const step=Number(e.currentTarget.dataset.step),next = this.data.weekIndex + step; if ([-1,1].includes(step) && next >= 0 && next < this.data.weeks.length) { this.hasWeekSelection=true;this.setData({ weekIndex: next }); this.refresh(); } },
  account() { wx.navigateTo({url:'/pages/account/index'}); },
  planChange(e) { const plan=this.data.plans[Number(e.detail.value)];if(!this.data.readOnly || !plan)return;this.queryPlan=plan.id;this.planning=true;this.loadContext(); },
  selectPlan(e) { const plan=this.data.plans.find(p=>p.id===e.currentTarget.dataset.plan);if(!this.data.readOnly || !plan)return;this.queryPlan=plan.id;this.planning=true;this.loadContext(); },
  termChange(e) { const value=Number(e.detail.value);if(!this.data.readOnly || ![0,1].includes(value))return;this.queryTerm=value===1?'spring':'fall';this.loadContext(); },
  modeChange(e) { const mode=e.currentTarget.dataset.mode;if(!this.data.hasAcademic || !['academic','planning'].includes(mode))return;this.planning=mode==='planning';this.loadContext(); },
  toggleWeekends() { this.setData({ showFullWeek: !this.data.showFullWeek }); this.refresh(); },
  dayChange(e) { const weekday=Number(e.currentTarget.dataset.day);if(!Number.isInteger(weekday) || weekday<1 || weekday>7)return;this.setData({ weekday }); this.refresh(); },
  viewChange(e) { const view = e.currentTarget.dataset.view; if (['week', 'day'].includes(view)) this.setData({ view }); },
  settings() { wx.navigateTo({ url: this.data.readOnly ? '/pages/account/index' : '/pages/settings/index' }); },
  classes() { if(!this.data.readOnly)wx.navigateTo({ url: '/pages/classes/index' }); },
  courses() { wx.switchTab({ url: '/pages/courses/index' }); },
  open(e) { const m = (this.selectedMeetings || []).find(m => m.id === e.currentTarget.dataset.id); if (!m)return;
    if(this.data.readOnly)wx.navigateTo({url:'/pages/cloud-detail/index?id='+encodeURIComponent(m.id)+'&term='+this.data.term+'&plan='+encodeURIComponent(this.queryPlan||'')+'&planning='+(this.planning?'1':'0')});
    else ui.detail(m.courseId,m.term,m.id); },
  remove(e) {
    if(this.data.readOnly)return;
    const id = e.currentTarget.dataset.section;
    wx.showModal({ title: '移除教学班？', content: '该教学班的所有上课时段都会从本机课表移除。',
      success: r => { if (r.confirm) ui.safely(() => { store.removeSection(getCatalog(), id); this.refresh(); }); } });
  }
});
