const account = require('./account');
const store = require('./store');
const planner = require('./planner');
const domain = require('./domain');
const release = require('../data/release');
function deriveCloud(preview, options = {}) {
  if(preview.sourceSnapshot.state===null){const term=options.term || 'fall';return {source:'website',readOnly:true,ready:true,emptyWebsiteState:true,
    term,meetings:[],plans:[],hasAcademic:false,academicYear:'',missing:0,maximumWeek:18,sectionCount:0,state:null,
    settings:{mode:'auto',week:1,startDate:release.semesterStartDates?.[term] || ''}};}
  const state = preview.sourceSnapshot.state, term = options.term || state.preferredTerm;
  const plan = preview.plans.find(p => p.id === (options.planId || state.activePlanId));
  if (!plan) throw new Error('该课表方案未找到，请重新读取。');
  const snapshots = (state.academicSnapshots || []).filter(s => s.term === term)
    .sort((a,b) => b.academicYear.localeCompare(a.academicYear) || Date.parse(b.importedAt) - Date.parse(a.importedAt));
  const academic = snapshots[0];
  let meetings = plan.meetings.filter(m => m.term === term).map(m => ({...m,origin:'manual'}));
  if (academic && !options.planning) {
    meetings = academic.sections.flatMap(section => section.meetings.map((m,index) => ({...m,
      sectionId:section.id,meetingIndex:index,term:academic.term,courseId:'academic:'+section.courseCode+':'+section.sectionCode,
      courseCode:section.courseCode,sectionCode:section.sectionCode,title:section.courseName,teacher:section.teachers.join(' / '),
      building:[m.campus,m.building].filter(Boolean).join(' · '),classNames:section.sectionCode,origin:'academic'})));
  }
  return {source:'website',readOnly:true,ready:true,term,meetings,planId:plan.id,plans:preview.plans,
    hasAcademic:Boolean(academic),academic,academicYear:academic?.academicYear || '',missing:plan.missingMeetingIds.length,
    maximumWeek:Math.max(18,...meetings.flatMap(m => m.weeks)),sectionCount:new Set(meetings.map(m => m.sectionId)).size,
    state,settings:{mode:'auto',week:1,startDate:release.semesterStartDates?.[term] || ''}};
}
function read(catalog, options = {}) {
  if (account.websiteSource()) {
    const preview = account.getCloud();
    if (preview) return deriveCloud(preview, options);
    return {source:'website',readOnly:true,ready:false,term:'fall',meetings:[],sectionCount:0,missing:0,
      maximumWeek:18,plans:[],settings:{mode:'manual',week:1,startDate:''}};
  }
  const state = store.load(catalog), term = state.term;
  return {source:'local',readOnly:false,ready:true,term,meetings:catalog.schedules.filter(m => state.sectionIds.includes(m.sectionId)),
    sectionCount:state.sectionIds.filter(id => catalog.sectionById.get(id)?.term === term).length,
    missing:state.sectionIds.filter(id => !catalog.sectionById.has(id)).length,maximumWeek:18,plans:[],settings:state.terms[term]};
}
function todaySummary(context,date) {
  if (!context.readOnly) return planner.todaySummary(planner.load(),date);
  const state = context.state;
  if (!state) return {events:[],tasks:[]};
  const events = state.activities.filter(e => e.repeat === 'none' ? e.date === date :
    e.weekday === domain.weekdayOf(date) && (!e.date || date >= e.date)).map(e => ({...e,
      startTime:e.startTime || ['08:00','09:55','13:00','18:15'][e.block-1],endTime:e.endTime || ['09:35','11:30','15:25','20:40'][e.block-1]}));
  const tasks = state.assignments.filter(t => !t.completed).sort((a,b) => a.dueDate.localeCompare(b.dueDate)).slice(0,3)
    .map(t => ({...t,date:t.dueDate,dueLabel:t.dueDate < date ? '已逾期' : t.dueDate === date ? '今天截止' : t.dueDate+'截止'}));
  return {events,tasks};
}
function examSummary(context,now=new Date()) {
  const academic=context.readOnly ? context.academic : null;
  if(!academic)return {exams:[],examCount:0,examNotice:''};
  if(academic.examStatus)return {exams:[],examCount:0,examNotice:academic.examStatus==='stale' ? '考试沿用上次数据，请在官网确认最新安排。' : '考试安排尚未同步，请在官网更新。'};
  const clock=new Date(now.getTime()+8*3600000).toISOString(),date=clock.slice(0,10),time=clock.slice(11,16);
  const exams=[...(academic.exams || [])].filter(e=>!e.date || e.date>date || (e.date===date && (!e.endTime || e.endTime>=time)))
    .sort((a,b)=>(a.date||'9999-12-31').localeCompare(b.date||'9999-12-31') || (a.startTime||'23:59').localeCompare(b.startTime||'23:59'))
    .map(e=>({...e,title:e.courseName || e.courseCode,dateLabel:e.date ? Number(e.date.slice(5,7))+'月'+Number(e.date.slice(8))+'日' : '日期待定',
      timeLabel:[e.startTime,e.endTime].filter(Boolean).join('–') || '时间待定',
      locationLabel:e.location || [e.campus,e.building,e.room].filter(Boolean).join(' · ') || '考场待定'}));
  return {exams:exams.slice(0,2),examCount:exams.length,examNotice:''};
}
module.exports = { read, deriveCloud, todaySummary, examSummary };
