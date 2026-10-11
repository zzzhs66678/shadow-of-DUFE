export const meeting = (patch = {}) => ({
  id: "meeting-1", weekday: 1, periods: [1, 2], block: 1,
  weeks: Array.from({ length: 9 }, (_, i) => i + 1), weekText: "1-9周", timeText: "星期一 1-2节",
  campus: "校本部", building: "之远楼", room: "101", ...patch,
});
export const section = (patch = {}) => ({
  id: "section-1", courseCode: "C01", sectionCode: "01", courseName: "测试课程",
  credits: "2", property: "必修", category: "专业", assessmentType: "考试",
  teachers: ["测试教师"], studyMode: "正常", selectionStatus: "选中", meetings: [meeting()], ...patch,
});
export const exam = (patch = {}) => ({
  id: "exam:date-and-room-dependent", courseCode: "C01", sectionCode: "01", courseName: "测试课程", examType: "期末",
  date: "2027-01-08", startTime: "09:00", endTime: "11:00", campus: "校本部", building: "梅园", room: "201",
  location: "校本部 / 梅园 / 201", seat: "18", examNumber: "number", status: "已安排", ...patch,
});
export const snapshot = (patch = {}) => ({
  schemaVersion: 1, id: "2026-2027-fall", academicYear: "2026-2027", term: "fall", termLabel: "第一学期",
  importedAt: "2026-10-09T02:03:04.000Z", sections: [section()], exams: [exam()], ...patch,
});
export const planCourse = (patch = {}) => ({
  courseCode: "C01", courseName: "测试课程", categoryCode: "A", categoryName: "专业必修", attribute: "required",
  credits: 2, completionStatus: "not_taken", completedTerm: "", replacementCourseCodes: [], ...patch,
});
export const trainingPlan = (patch = {}) => ({
  schemaVersion: 1, planNumber: "P26", planName: "测试培养方案", majorCode: "M1", majorName: "测试专业",
  cohortYear: 2026, requiredCredits: 160, categories: [], courses: [planCourse()], importedAt: "2026-10-09T02:03:04.000Z", ...patch,
});
export const baseline = (patch = {}) => ({ owner: "anonymous", schoolAccount: "test-student", snapshot: snapshot(), trainingPlan: trainingPlan(), ...patch });
export const savedState = (patch = {}) => ({
  profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }], activePlanId: "default",
  activities: [], assignments: [], academicSnapshots: [], trainingPlan: null, favoriteRooms: [], recentRooms: [], ...patch,
});
