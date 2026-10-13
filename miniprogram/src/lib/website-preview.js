// Read-only preparation for native account sync. These functions never log in,
// perform network requests, persist data, or turn a preview into a cloud write.
// The caller must supply an authenticated account context from the auth client.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function accountContext(value) {
  if (!value || !UUID.test(value.userId || '') || !Number.isSafeInteger(value.epoch) || value.epoch < 0) {
    throw new Error('请先登录网站账号，再读取云端课表。');
  }
  return value;
}
function readTicket(context) {
  const c = accountContext(context);
  return Object.freeze({ userId: c.userId, epoch: c.epoch });
}
function clone(value) {
  const text = JSON.stringify(value);
  if (!text || text.length > 4 * 1024 * 1024) throw new Error('云端内容过大或格式无法读取，已有数据未修改。');
  return JSON.parse(text);
}
function validateSnapshot(snapshot) {
  const s = snapshot?.state;
  if(snapshot?.revision===0 && s===null && snapshot.updatedAt==null)return;
  if (!Number.isSafeInteger(snapshot?.revision) || snapshot.revision < 0 || !s ||
      !Array.isArray(s.plans) || !s.plans.length || s.plans.length > 20 ||
      !Array.isArray(s.activities) || s.activities.length > 500 ||
      !Array.isArray(s.assignments) || s.assignments.length > 1000 ||
      (s.academicSnapshots !== undefined && (!Array.isArray(s.academicSnapshots) || s.academicSnapshots.length > 12)) ||
      !['fall', 'spring'].includes(s.preferredTerm) ||
      !s.plans.every(p => p && typeof p.id === 'string' && p.id && typeof p.name === 'string' &&
        Array.isArray(p.scheduleIds) && p.scheduleIds.length <= 1200 && p.scheduleIds.every(id => typeof id === 'string' && id)) ||
      new Set(s.plans.map(p => p.id)).size !== s.plans.length || !s.plans.some(p => p.id === s.activePlanId)) {
    throw new Error('云端课表格式无法读取，已有数据未修改。');
  }
}
function previewPlan(plan, catalog) {
  const byMeeting = new Map(catalog.schedules.map(m => [m.id, m]));
  const selected = new Set(plan.scheduleIds);
  const meetings = [], missingMeetingIds = [];
  for (const id of selected) {
    const meeting = byMeeting.get(id);
    if (meeting) meetings.push(clone(meeting));
    else missingMeetingIds.push(id);
  }
  const sectionIds = [...new Set(meetings.map(m => m.sectionId))];
  const partialSectionIds = sectionIds.filter(id => catalog.schedules.some(m => m.sectionId === id && !selected.has(m.id)));
  return { id: plan.id, name: plan.name, meetings, missingMeetingIds, partialSectionIds };
}
function acceptSnapshot(ticket, currentContext, snapshot, catalog) {
  const current = accountContext(currentContext), request = accountContext(ticket);
  // The epoch changes on every login/logout/account switch, including A→B→A.
  if (request.userId !== current.userId || request.epoch !== current.epoch) {
    throw new Error('账号已切换，请重新读取云端课表。');
  }
  validateSnapshot(snapshot);
  if (!catalog || !Array.isArray(catalog.schedules)) throw new Error('课程目录尚未准备好。');
  const sourceSnapshot = clone(snapshot);
  if(sourceSnapshot.state===null)return {userId:current.userId,epoch:current.epoch,revision:0,sourceSnapshot,
    activePlanId:null,plans:[],activityCount:0,assignmentCount:0,academicSnapshotCount:0,preferredTerm:null};
  return {
    userId: current.userId, epoch: current.epoch, revision: snapshot.revision,
    sourceSnapshot, activePlanId: sourceSnapshot.state.activePlanId,
    plans: sourceSnapshot.state.plans.map(p => previewPlan(p, catalog)),
    activityCount: sourceSnapshot.state.activities.length,
    assignmentCount: sourceSnapshot.state.assignments.length,
    academicSnapshotCount: (sourceSnapshot.state.academicSnapshots || []).length,
    preferredTerm: sourceSnapshot.state.preferredTerm
  };
}
module.exports = { readTicket, acceptSnapshot };
