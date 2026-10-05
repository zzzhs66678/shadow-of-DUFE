import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createAcademicConnector,
  findTimetableCallbackPath,
  findTrainingPlanDetailPath,
  parseExamHtml,
  parseTimetableHtml,
  parseTimetableJson,
  parseTrainingPlanCompletionHtml,
  parseTrainingPlanDetail,
  parseTrainingPlanProfile,
  parseWeeks,
} from "../services/auth-api/src/academic-access.mjs";

const timetableHtml = `<!doctype html>
<html><body>
  <nav>2026-2027学年第一学期 第5周</nav>
  <table><tr><th>节次/时间</th><th>星期一</th></tr></table>
  <table>
    <thead><tr>
      <th>课程号</th><th>课程名</th><th>课序号</th><th>学分</th>
      <th>课程属性</th><th>课程类别</th><th>考试类型</th><th>教师</th>
      <th>修读方式</th><th>选课状态</th><th>时间</th><th>地点</th>
    </tr></thead>
    <tbody>
      <tr>
        <td>31131862</td><td>内部审计</td><td>01</td><td>2</td>
        <td>必修</td><td>专业必修</td><td>考试</td><td>姜博*</td>
        <td>正常</td><td>选中</td>
        <td>1-9周 / 星期一 / 1-2节<br>10-18周 / 星期三 / 5-7节</td>
        <td>校本部 / 之远楼 / (5＃)516<br>校本部 / 笃行楼 / 403</td>
      </tr>
      <tr>
        <td>51132062</td><td>数字化管理会计</td><td>02</td><td>2</td>
        <td>限选</td><td>专业选修</td><td>考试</td><td>谭袁月* 宋淑琴</td>
        <td>正常</td><td>抽中</td>
        <td>2-18 周 / 星期四 / 8-9节</td>
        <td>校本部 / 播慧楼 / J4-3</td>
      </tr>
    </tbody>
  </table>
</body></html>`;

const rowspanTimetableHtml = `<!doctype html>
<html><body>
  <div>2026-2027学年第一学期</div>
  <table class="layout"><tr><td>
    <table class="curriculum">
      <thead><tr>
        <th>序号</th><th>课程号</th><th>课程名</th><th>课序号</th>
        <th>学分</th><th>课程属性</th><th>考试类型</th><th>教师</th>
        <th>修读方式</th><th>选课状态</th><th>周次</th><th>星期</th>
        <th>节次</th><th>节数</th><th>校区</th><th>教学楼</th><th>教室</th>
      </tr></thead>
      <tbody>
        <tr>
          <td rowspan=2>1</td><td rowspan=2>31131862</td>
          <td rowspan=2>内部审计</td><td rowspan=2>01</td><td rowspan=2>2</td>
          <td rowspan=2>必修</td><td rowspan=2>考试</td><td rowspan=2>姜博*</td>
          <td rowspan=2>正常</td><td rowspan=2>选中</td>
          <td>1-9周</td><td>1</td><td>1</td><td>2</td>
          <td>校本部</td><td>之远楼</td><td>(5＃)516</td>
        </tr>
        <tr>
          <td>10-18周</td><td>星期三</td><td>5</td><td>3</td>
          <td>校本部</td><td>笃行楼</td><td>403</td>
        </tr>
        <tr>
          <td>2</td><td>51132062</td><td>数字化管理会计</td><td>02</td><td>2</td>
          <td>限选</td><td>考试</td><td>谭袁月* 宋淑琴</td>
          <td>正常</td><td>抽中</td><td>全周</td><td>四</td><td>8-9节</td><td>2</td>
          <td>校本部</td><td>播慧楼</td><td>J4-3</td>
        </tr>
      </tbody>
    </table>
  </td></tr></table>
</body></html>`;

const examHtml = `<!doctype html>
<html><body>
  <div>2026-2027 第一学期</div>
  <table>
    <tr><th>课程编号</th><th>课程名称</th><th>课序号</th><th>考试类型</th><th>考试时间</th><th>考场</th><th>座位号</th><th>考号</th><th>状态</th></tr>
    <tr><td>31131862</td><td>内部审计</td><td>01</td><td>期末</td><td>2027年01月08日 09:00-11:00</td><td>校本部 / 梅园 / 201</td><td>18</td><td>20260001</td><td>已安排</td></tr>
  </table>
</body></html>`;

const timetableShellHtml = `<!doctype html>
<html><body>
  <div>2026-2027学年第一学期</div>
  <table><tr><th>节次</th><th>星期一</th><th>星期二</th><th>星期三</th></tr></table>
  <table><tr><th>课程号</th><th>课序号</th><th>课程名</th><th>学分</th><th>教师</th><th>必修</th><th>考试类型</th><th>时间</th><th>地点</th></tr></table>
  <script>const url = "/student/courseSelect/thisSemesterCurriculum/token-a/ajaxStudentSchedule/curr/callback";</script>
</body></html>`;

const timetablePayload = {
  allUnits: 4,
  dateList: [
    {
      programPlanCode: "2026-2027-1-1",
      selectCourseList: [
        {
          id: {
            executiveEducationPlanNumber: "2026-2027-1-1",
            coureNumber: "31131862",
            coureSequenceNumber: "01",
          },
          courseName: "内部审计",
          unit: 2,
          attendClassTeacher: "姜博*",
          coursePropertiesName: "必修",
          courseCategoryName: "专业必修",
          examTypeName: "考试",
          studyModeName: "正常",
          selectCourseStatusName: "选中",
          timeAndPlaceList: [
            {
              classWeek: "111111111000000000000000",
              weekDescription: "1-9周",
              classDay: 1,
              classSessions: 1,
              continuingSession: 2,
              campusName: "校本部",
              teachingBuildingName: "之远楼",
              classroomName: "516",
            },
            {
              classWeek: "000000000111111111000000",
              weekDescription: "10-18周",
              classDay: 3,
              classSessions: 5,
              continuingSession: 3,
              campusName: "校本部",
              teachingBuildingName: "笃行楼",
              classroomName: "403",
            },
          ],
        },
        {
          id: {
            executiveEducationPlanNumber: "2026-2027-1-1",
            coureNumber: "51132062",
            coureSequenceNumber: "02",
          },
          courseName: "数字化管理会计",
          unit: 2,
          attendClassTeacher: "谭袁月* 宋淑琴",
          timeAndPlaceList: [
            {
              classWeek: "011111111111111111000000",
              weekDescription: "2-18周",
              classDay: 4,
              classSessions: 8,
              continuingSession: 2,
              campusName: "校本部",
              teachingBuildingName: "播慧楼",
              classroomName: "J4-3",
            },
          ],
        },
      ],
    },
  ],
};

const examCardsHtml = `<!doctype html><html><body>
  <div class="widget-box widget-color-blue">
    <div class="widget-header"><h5 class="widget-title smaller">（ 31131862-01 ）内部审计</h5></div>
    <div class="widget-main">
      考试名称:&nbsp;期末考试<br>
      考试时间:&nbsp;2027-01-08 星期五 09:00-11:00<br>
      地点:&nbsp;校本部 梅园 201<br>
      座位号:&nbsp;18<br>
      准考证号:&nbsp;20260001<br>
    </div>
  </div>
</body></html>`;

const planProfileHtml = `<!doctype html><html><body>
  <div class="profile-info-name">年级</div><div class="profile-info-value">2024级</div>
  <div class="profile-info-name">专业</div><div class="profile-info-value">会计学</div>
  <input value="P2024" id="zx">
  <script>const url = "/student/rollManagement/project/plan-token/P2024/1/detail";</script>
</body></html>`;

const planProfileWithoutVisibleFieldsHtml = `<!doctype html><html><body>
  <input value="P2024" id="zx">
  <script>const url = "../rollManagement/project/plan-token/P2024/1/detail";</script>
</body></html>`;

const planProfileWithDynamicDetailHtml = `<!doctype html><html><body>
  <input value="student-token" id="studentPlanId">
  <input value="P2024" id="zx">
  <script>
    const studentPlanId = document.getElementById("studentPlanId").value;
    const planNumber = $("#zx").val();
    const url = "../rollManagement/project/" + studentPlanId + "/" + planNumber + "/1/detail";
  </script>
</body></html>`;

const planDetailPayload = {
  title: "培养方案",
  jhFajhb: {
    fajhh: "P2024",
    famc: "2024级会计学专业培养方案",
    zyh: "120203K",
    zym: "会计学",
    nj: "2024",
    yqzxf: 160,
  },
  treeList: [
    { id: "A", pId: "0", name: "专业必修课", info1: "/plan/category/A" },
    { id: "A-1", pId: "A", name: "内部审计 必修", info1: "/plan/course/@31131862", xf: 2 },
    { id: "B", pId: "0", name: "专业选修课", info1: "/plan/category/B" },
    { id: "B-1", pId: "B", name: "数字化管理会计 限选", info1: "/plan/course/@51132062", xf: 2 },
  ],
};

const planCategoryPayloads = new Map([
  ["A", { kz: { id: { kzh: "A" }, kzm: "专业必修课", zsxf: 80 } }],
  ["B", { kz: { id: { kzh: "B" }, kzm: "专业选修课", zsxf: 20 } }],
]);

const planCompletionHtml = `<!doctype html><html><body>
  <ul id="treeDemo" class="ztree"></ul>
  <script>
    var zNodes = ${JSON.stringify([
      {
        id: "A",
        pId: "R0",
        flagType: "001",
        name: "专业必修课(最低修读学分:80,通过学分:10)",
        zsxf: "80",
        yxxf: "10",
      },
      {
        id: "A-1",
        pId: "A",
        flagType: "002",
        name: "专业基础必修",
      },
      {
        id: "A-C1",
        pId: "A-1",
        flagType: "kch",
        flagId: "31131862",
        name: "<i></i>&nbsp;[31131862]内部审计[2学分,2026-2027学年第一学期](已修读及格,79.0(正常))",
      },
      {
        id: "B",
        pId: "R0",
        flagType: "001",
        name: "专业选修课(最低修读学分:20,通过学分:0)",
        zsxf: "20",
        yxxf: "0",
      },
      {
        id: "B-C1",
        pId: "B",
        flagType: "kch",
        flagId: "51132062",
        name: "[51132062]数字化管理会计[2学分]",
      },
    ])};
    $.fn.zTree.init($("#treeDemo"), {}, zNodes);
  </script>
</body></html>`;

const casLoginHtml = `<!doctype html>
<html><head><title>统一身份认证中心</title></head><body>
  <form method="post" action="">
    <input type="hidden" name="fingerprint" value="">
    <input type="text" name="username" value="">
    <input type="hidden" name="password" value="">
    <input type="hidden" name="verify_token" value="">
    <input type="hidden" name="verify_code" value="">
    <input type="hidden" name="__token__" value="csrf-test-token">
  </form>
  <script>
    key = CryptoJS.enc.Utf8.parse('12793ff634e57cd59df06598e3be5482'.substr(0,16));
  </script>
</body></html>`;

const sliderToken = "testslider".repeat(4);

const sliderChallenge = JSON.stringify({
  code: 1,
  data: {
    token: sliderToken,
    bg: "data:image/png;base64,iVBORw0KGgo=",
    block: "data:image/png;base64,iVBORw0KGgo=",
  },
});

test("week parser preserves ranges and odd/even week sets", () => {
  assert.deepEqual(parseWeeks("1-9周"), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parseWeeks("9-18周"), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual(parseWeeks("1-8周(单周)"), [1, 3, 5, 7]);
  assert.deepEqual(parseWeeks("1-8周上"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parseWeeks("前八周"), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("timetable parser keeps teaching sections and multiple meetings", () => {
  const parsed = parseTimetableHtml(timetableHtml);
  assert.equal(parsed.term.id, "2026-2027-fall");
  assert.equal(parsed.sections.length, 2);
  assert.deepEqual(parsed.sections[0].teachers, ["姜博"]);
  assert.equal(parsed.sections[0].meetings.length, 2);
  assert.deepEqual(parsed.sections[0].meetings[0].periods, [1, 2]);
  assert.deepEqual(parsed.sections[0].meetings[0].weeks, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(parsed.sections[0].meetings[1].block, 3);
  assert.equal(parsed.sections[0].meetings[1].room, "403");
  assert.deepEqual(parsed.sections[1].teachers, ["谭袁月", "宋淑琴"]);
});

test("timetable parser expands rowspans and separate meeting columns", () => {
  const parsed = parseTimetableHtml(rowspanTimetableHtml);
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].courseName, "内部审计");
  assert.equal(parsed.sections[0].meetings.length, 2);
  assert.deepEqual(parsed.sections[0].meetings[0].periods, [1, 2]);
  assert.deepEqual(parsed.sections[0].meetings[1].periods, [5, 6, 7]);
  assert.equal(parsed.sections[0].meetings[1].weekday, 3);
  assert.equal(parsed.sections[0].meetings[1].room, "403");
  assert.equal(parsed.sections[1].meetings.length, 1);
  assert.deepEqual(parsed.sections[1].meetings[0].weeks, [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  ]);
  assert.deepEqual(parsed.sections[1].teachers, ["谭袁月", "宋淑琴"]);
});

test("timetable JSON parser follows the official dynamic callback and keeps every meeting", () => {
  assert.equal(
    findTimetableCallbackPath(timetableShellHtml),
    "/student/courseSelect/thisSemesterCurriculum/token-a/ajaxStudentSchedule/curr/callback",
  );
  const term = parseTimetableHtml(timetableHtml).term;
  const parsed = parseTimetableJson(timetablePayload, term);
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].courseCode, "31131862");
  assert.equal(parsed.sections[0].sectionCode, "01");
  assert.equal(parsed.sections[0].meetings.length, 2);
  assert.deepEqual(parsed.sections[0].meetings[0].weeks, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parsed.sections[0].meetings[1].periods, [5, 6, 7]);
  assert.deepEqual(parsed.sections[1].teachers, ["谭袁月", "宋淑琴"]);
});

test("timetable JSON parser fails closed when identifiers or meetings are malformed", () => {
  const term = parseTimetableHtml(timetableHtml).term;
  assert.throws(
    () => parseTimetableJson({ dateList: [{ selectCourseList: [{ courseName: "同名课" }] }] }, term),
    { code: "ACADEMIC_TIMETABLE_FORMAT_CHANGED" },
  );
  assert.throws(
    () => parseTimetableJson({ data: [] }, term),
    { code: "ACADEMIC_TIMETABLE_FORMAT_CHANGED" },
  );
});

test("timetable parser rejects false success when no meeting was decoded", () => {
  const html = timetableHtml.replace(
    /1-9周 \/ 星期一 \/ 1-2节<br>10-18周 \/ 星期三 \/ 5-7节|2-18 周 \/ 星期四 \/ 8-9节/gu,
    "待安排",
  );
  assert.throws(() => parseTimetableHtml(html), (error) => {
    assert.equal(error.code, "ACADEMIC_TIMETABLE_FORMAT_CHANGED");
    assert.equal(error.diagnostic.parseReason, "meetings_not_decoded");
    assert.equal(error.diagnostic.headerMode, "combined");
    assert.equal(error.diagnostic.sectionCount, 2);
    assert.deepEqual(error.diagnostic.timePatterns, ["?"]);
    return true;
  });
});

test("exam parser accepts combined date/time and location fields", () => {
  const term = parseTimetableHtml(timetableHtml).term;
  const exams = parseExamHtml(examHtml, term);
  assert.equal(exams.length, 1);
  assert.equal(exams[0].date, "2027-01-08");
  assert.equal(exams[0].startTime, "09:00");
  assert.equal(exams[0].endTime, "11:00");
  assert.equal(exams[0].building, "梅园");
  assert.equal(exams[0].seat, "18");
  assert.equal(exams[0].examNumber, "20260001");
});

test("exam parser accepts the official timeline card layout", () => {
  const term = parseTimetableHtml(timetableHtml).term;
  const exams = parseExamHtml(examCardsHtml, term);
  assert.equal(exams.length, 1);
  assert.equal(exams[0].courseCode, "31131862");
  assert.equal(exams[0].sectionCode, "01");
  assert.equal(exams[0].courseName, "内部审计");
  assert.equal(exams[0].examType, "期末考试");
  assert.equal(exams[0].date, "2027-01-08");
  assert.equal(exams[0].startTime, "09:00");
  assert.equal(exams[0].endTime, "11:00");
  assert.equal(exams[0].seat, "18");
  assert.equal(exams[0].examNumber, "20260001");
});

test("training plan parser preserves groups, identifiers, credits, and course attributes", () => {
  assert.equal(
    findTrainingPlanDetailPath(planProfileHtml, "P2024"),
    "/student/rollManagement/project/plan-token/P2024/1/detail",
  );
  const profile = parseTrainingPlanProfile(planProfileHtml);
  const plan = parseTrainingPlanDetail(
    planDetailPayload,
    profile,
    planCategoryPayloads,
    "2026-10-04T01:02:03.000Z",
  );
  assert.equal(plan.planNumber, "P2024");
  assert.equal(plan.majorName, "会计学");
  assert.equal(plan.requiredCredits, 160);
  assert.equal(plan.categories.length, 2);
  assert.deepEqual(plan.courses, [
    {
      courseCode: "31131862",
      courseName: "内部审计",
      categoryCode: "A",
      categoryName: "专业必修课",
      attribute: "required",
      credits: 2,
      replacementCourseCodes: [],
    },
    {
      courseCode: "51132062",
      courseName: "数字化管理会计",
      categoryCode: "B",
      categoryName: "专业选修课",
      attribute: "limited",
      credits: 2,
      replacementCourseCodes: [],
    },
  ]);
});

test("training plan completion parser reads the complete inline course tree", () => {
  const profile = parseTrainingPlanProfile(planProfileHtml);
  const plan = parseTrainingPlanCompletionHtml(
    planCompletionHtml,
    planDetailPayload,
    profile,
    "2026-10-04T01:02:03.000Z",
  );
  assert.deepEqual(plan.categories, [
    {
      code: "A",
      name: "专业必修课",
      requiredCredits: 80,
      earnedCredits: 10,
      parentCode: null,
    },
    {
      code: "A-1",
      name: "专业基础必修",
      requiredCredits: null,
      earnedCredits: null,
      parentCode: "A",
    },
    {
      code: "B",
      name: "专业选修课",
      requiredCredits: 20,
      earnedCredits: 0,
      parentCode: null,
    },
  ]);
  assert.equal(plan.earnedCredits, 10);
  assert.deepEqual(plan.courses, [
    {
      courseCode: "31131862",
      courseName: "内部审计",
      credits: 2,
      completedTerm: "2026-2027学年第一学期",
      completionStatus: "passed",
      categoryCode: "A-1",
      categoryName: "专业基础必修",
      attribute: "required",
      replacementCourseCodes: [],
    },
    {
      courseCode: "51132062",
      courseName: "数字化管理会计",
      credits: 2,
      completedTerm: "",
      completionStatus: "not_taken",
      categoryCode: "B",
      categoryName: "专业选修课",
      attribute: "elective",
      replacementCourseCodes: [],
    },
  ]);
});

test("training plan completion parser uses stable course ids across decorated labels", () => {
  const profile = parseTrainingPlanProfile(planProfileHtml);
  const decorated = planCompletionHtml
    .replace(
      "[31131862]内部审计[2学分,2026-2027学年第一学期](已修读及格,79.0(正常))",
      "【31131862】内部审计【2<span>学</span><b>分</b>，2026-2027学年第一学期】（已修读及格）",
    )
    .replace(
      "[51132062]数字化管理会计[2学分]",
      "[51132062]数字化管理会计[2 学 分]",
    );
  const plan = parseTrainingPlanCompletionHtml(
    decorated,
    planDetailPayload,
    profile,
    "2026-10-05T03:00:00.000Z",
  );
  assert.equal(plan.courses.length, 2);
  assert.equal(plan.courses[0].courseCode, "31131862");
  assert.equal(plan.courses[0].completedTerm, "2026-2027学年第一学期");
  assert.equal(plan.courses[0].completionStatus, "passed");
  assert.equal(plan.courses[1].courseCode, "51132062");
  assert.equal(plan.courses[1].completionStatus, "not_taken");
});

test("training plan completion parser rejects display codes that disagree with stable ids", () => {
  try {
    parseTrainingPlanCompletionHtml(
      planCompletionHtml.replace("[31131862]内部审计", "[99999999]内部审计"),
      planDetailPayload,
      parseTrainingPlanProfile(planProfileHtml),
      "2026-10-05T03:00:00.000Z",
    );
    assert.fail("expected the mismatched stable course id to be rejected");
  } catch (error) {
    assert.equal(error.code, "ACADEMIC_PLAN_FORMAT_CHANGED");
    assert.equal(error.diagnostic.parseReason, "plan_course_code_mismatch");
    assert.equal(error.diagnostic.courseIndex, 0);
    assert.equal(error.diagnostic.hasStableCourseCode, true);
    assert.equal(error.diagnostic.displayedCodeLength, 8);
    assert.equal("courseCode" in error.diagnostic, false);
    assert.equal("courseName" in error.diagnostic, false);
  }
});

test("training plan completion parser reports only anonymous row shape diagnostics", () => {
  try {
    parseTrainingPlanCompletionHtml(
      planCompletionHtml.replace(
        "[31131862]内部审计[2学分,2026-2027学年第一学期]",
        "内部审计",
      ),
      planDetailPayload,
      parseTrainingPlanProfile(planProfileHtml),
      "2026-10-05T03:00:00.000Z",
    );
    assert.fail("expected the malformed course row to be rejected");
  } catch (error) {
    assert.equal(error.code, "ACADEMIC_PLAN_FORMAT_CHANGED");
    assert.equal(error.diagnostic.parseReason, "plan_course_pattern_invalid");
    assert.equal(error.diagnostic.courseIndex, 0);
    assert.equal(error.diagnostic.bracketGroupCount, 0);
    assert.equal(error.diagnostic.hasCreditMarker, false);
    assert.equal("raw" in error.diagnostic, false);
    assert.equal("courseCode" in error.diagnostic, false);
    assert.equal("courseName" in error.diagnostic, false);
  }
});

test("training plan completion parser rejects a non-credit unit", () => {
  assert.throws(
    () =>
      parseTrainingPlanCompletionHtml(
        planCompletionHtml.replace("[2学分,", "[2课时,"),
        planDetailPayload,
        parseTrainingPlanProfile(planProfileHtml),
        "2026-10-05T03:00:00.000Z",
      ),
    { code: "ACADEMIC_PLAN_FORMAT_CHANGED" },
  );
});

test("training plan completion parser preserves real zero-credit courses", () => {
  const plan = parseTrainingPlanCompletionHtml(
    planCompletionHtml.replace("[2学分,", "[0学分,"),
    planDetailPayload,
    parseTrainingPlanProfile(planProfileHtml),
    "2026-10-05T03:00:00.000Z",
  );
  assert.equal(plan.courses[0].credits, 0);
});

test("training plan completion parser treats zero as a real category id when present", () => {
  const html = `<!doctype html><html><body><script>
    var zNodes = ${JSON.stringify([
      {
        id: "0",
        pId: "ROOT",
        flagType: "001",
        name: "通识教育必修课课组(最低修读学分:47,通过学分:47.0)",
        zsxf: "47",
        yxxf: "47",
      },
      {
        id: "course-1",
        pId: "0",
        flagType: "kch",
        name: "[10000001]大学语文[2学分,2025-2026学年第一学期](已修读及格)",
      },
    ])};
  </script></body></html>`;
  const plan = parseTrainingPlanCompletionHtml(
    html,
    planDetailPayload,
    parseTrainingPlanProfile(planProfileHtml),
    "2026-10-05T02:15:00.000Z",
  );
  assert.equal(plan.categories[0].code, "0");
  assert.equal(plan.courses.length, 1);
  assert.equal(plan.courses[0].categoryCode, "0");
  assert.equal(plan.courses[0].courseName, "大学语文");
  assert.throws(
    () =>
      parseTrainingPlanCompletionHtml(
        html.replace('"pId":"0"', '"pId":"missing-category"'),
        planDetailPayload,
        parseTrainingPlanProfile(planProfileHtml),
        "2026-10-05T02:15:00.000Z",
      ),
    { code: "ACADEMIC_PLAN_FORMAT_CHANGED" },
  );
});

test("training plan completion parser takes major identity from school metadata", () => {
  const detail = structuredClone(planDetailPayload);
  detail.jhFajhb.fajhh = "P2024-ECON";
  detail.jhFajhb.famc = "2024级经济统计学专业培养方案";
  detail.jhFajhb.zyh = "020102";
  detail.jhFajhb.zym = "经济统计学";
  detail.jhFajhb.yqzxf = 155;
  const plan = parseTrainingPlanCompletionHtml(
    planCompletionHtml,
    detail,
    parseTrainingPlanProfile(
      planProfileWithoutVisibleFieldsHtml.replaceAll("P2024", "P2024-ECON"),
    ),
    "2026-10-04T01:02:03.000Z",
  );
  assert.equal(plan.planNumber, "P2024-ECON");
  assert.equal(plan.majorCode, "020102");
  assert.equal(plan.majorName, "经济统计学");
  assert.equal(plan.requiredCredits, 155);
  assert.equal(plan.courses.length, 2);
});

test("training plan completion parser fails closed on malformed course rows", () => {
  const profile = parseTrainingPlanProfile(planProfileHtml);
  assert.throws(
    () =>
      parseTrainingPlanCompletionHtml(
        planCompletionHtml.replace(
          "[31131862]内部审计[2学分,2026-2027学年第一学期]",
          "内部审计",
        ),
        planDetailPayload,
        profile,
        "2026-10-04T01:02:03.000Z",
      ),
    { code: "ACADEMIC_PLAN_FORMAT_CHANGED" },
  );
});

test("training plan parser accepts profile pages that leave identity to plan metadata", () => {
  const profile = parseTrainingPlanProfile(planProfileWithoutVisibleFieldsHtml);
  assert.equal(profile.majorName, "");
  assert.equal(profile.cohortYear, null);
  assert.equal(
    profile.detailPath,
    "../rollManagement/project/plan-token/P2024/1/detail",
  );
  const plan = parseTrainingPlanDetail(
    planDetailPayload,
    profile,
    planCategoryPayloads,
    "2026-10-04T01:02:03.000Z",
  );
  assert.equal(plan.majorName, "会计学");
  assert.equal(plan.cohortYear, 2024);
});

test("training plan detail path resolves safe DOM and jQuery value expressions", () => {
  assert.equal(
    findTrainingPlanDetailPath(planProfileWithDynamicDetailHtml, "P2024"),
    "../rollManagement/project/student-token/P2024/1/detail",
  );
});

test("training plan detail path resolves jQuery attributes and template literals", () => {
  const html = `<!doctype html><html><body>
    <input value="student-token" id="studentPlanId">
    <input value="P2024" id="zx">
    <script>
      const url = \`/student/rollManagement/project/\${$("#studentPlanId").attr("value")}/\${document.querySelector("#zx").value}/detail?mode=1\`;
    </script>
  </body></html>`;
  assert.equal(
    findTrainingPlanDetailPath(html, "P2024"),
    "/student/rollManagement/project/student-token/P2024/detail?mode=1",
  );
});

test("training plan detail path rejects ambiguous callbacks", () => {
  const html = `<!doctype html><html><body>
    <input value="P2024" id="zx">
    <script>
      const primary = "/student/rollManagement/project/a/P2024/1/detail";
      const secondary = "/student/rollManagement/project/b/P2024/1/detail";
    </script>
  </body></html>`;
  assert.equal(findTrainingPlanDetailPath(html, "P2024"), null);
});

test("training plan detail path selects the primary plan callback", () => {
  const html = `<!doctype html><html><body>
    <input value="P2024" id="zx">
    <script>
      const primary = "/student/rollManagement/project/token/P2024/1/detail";
      const secondary = "/student/rollManagement/project/token/P2024/2/detail";
    </script>
  </body></html>`;
  assert.equal(
    findTrainingPlanDetailPath(html, "P2024"),
    "/student/rollManagement/project/token/P2024/1/detail",
  );
});

test("training plan detail path deduplicates relative and root variants", () => {
  const html = `<!doctype html><html><body>
    <input value="P2024" id="zx">
    <script>
      const relative = "../rollManagement/project/token/P2024/1/detail";
      const root = "/student/rollManagement/project/token/P2024/1/detail";
    </script>
  </body></html>`;
  assert.equal(
    findTrainingPlanDetailPath(html, "P2024"),
    "/student/rollManagement/project/token/P2024/1/detail",
  );
});

test("training plan detail path does not execute arbitrary JavaScript", () => {
  const html = `<!doctype html><html><body>
    <input value="P2024" id="zx">
    <script>
      const url = "/student/rollManagement/project/" + stealCookies() + "/" + zx + "/1/detail";
    </script>
  </body></html>`;
  assert.equal(findTrainingPlanDetailPath(html, "P2024"), null);
});

test("exam parser distinguishes an explicit empty result from an unknown page", () => {
  const term = parseTimetableHtml(timetableHtml).term;
  assert.deepEqual(
    parseExamHtml("<html><body>暂无考试安排</body></html>", term),
    [],
  );
  assert.throws(
    () => parseExamHtml("<html><body>登录状态失效</body></html>", term),
    { code: "ACADEMIC_EXAM_FORMAT_CHANGED" },
  );
});

function rsaChallengeXml() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const modulus = Buffer.from(
    jwk.n.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((jwk.n.length + 3) % 4),
    "base64",
  ).toString("hex");
  return `<?xml version="1.0"?><Auth><ErrorCode>1</ErrorCode><CSRF_RAND_CODE>123456789</CSRF_RAND_CODE><RSA_ENCRYPT_KEY>${modulus}</RSA_ENCRYPT_KEY><RSA_ENCRYPT_EXP>65537</RSA_ENCRYPT_EXP></Auth>`;
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

function trainingPlanResponse(url, completionHtml = planCompletionHtml) {
  if (url.pathname === "/student/rollManagement/rollInfo/index") {
    return response(planProfileHtml);
  }
  if (url.pathname === "/student/rollManagement/project/plan-token/P2024/1/detail") {
    return response(JSON.stringify(planDetailPayload), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (url.pathname === "/student/integratedQuery/planCompletion/index") {
    return response(completionHtml);
  }
  if (url.pathname === "/plan/category/A") {
    return response(JSON.stringify(planCategoryPayloads.get("A")));
  }
  if (url.pathname === "/plan/category/B") {
    return response(JSON.stringify(planCategoryPayloads.get("B")));
  }
  return null;
}

test("connector performs encrypted login and imports both official pages", async () => {
  const challenge = rsaChallengeXml();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ parsed, options });
    if (parsed.pathname === "/por/login_auth.csp") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("svpn_name"), "20260001");
      assert.notEqual(form.get("svpn_password"), "test-password");
      assert.ok(!String(options.body).includes("test-password"));
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>", {
        headers: { "set-cookie": "SVPNCOOKIE=session; Path=/" },
      });
    }
    if (parsed.pathname === "/student/courseSelect/thisSemesterCurriculum/index") {
      assert.match(options.headers.Cookie, /SVPNCOOKIE=session/u);
      return response(timetableShellHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (parsed.pathname.includes("ajaxStudentSchedule")) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-Requested-With"], "XMLHttpRequest");
      assert.equal(new URLSearchParams(options.body).toString(), "");
      return response(JSON.stringify(timetablePayload), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(parsed);
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({
    fetchImpl,
    now: () => Date.parse("2026-09-28T01:02:03.000Z"),
  });
  const result = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(result.status, "imported");
  assert.equal(result.snapshot.id, "2026-2027-fall");
  assert.equal(result.snapshot.sections.length, 2);
  assert.equal(result.snapshot.exams.length, 1);
  assert.equal(result.trainingPlan.courses.length, 2);
  assert.equal(result.snapshot.importedAt, "2026-09-28T01:02:03.000Z");
  assert.equal(requests.length, 9);
});

test("connector keeps verified timetable and exams when only the plan is invalid", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>", {
        headers: { "set-cookie": "SVPNCOOKIE=session; Path=/" },
      });
    }
    if (parsed.pathname === "/student/courseSelect/thisSemesterCurriculum/index") {
      return response(timetableShellHtml);
    }
    if (parsed.pathname.includes("ajaxStudentSchedule")) {
      return response(JSON.stringify(timetablePayload), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(
      parsed,
      planCompletionHtml.replace("[31131862]内部审计[2学分,", "内部审计[2学分,"),
    );
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({
    fetchImpl,
    now: () => Date.parse("2026-09-28T01:02:03.000Z"),
  });
  const result = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(result.status, "partial_imported");
  assert.equal(result.snapshot.sections.length, 2);
  assert.equal(result.snapshot.exams.length, 1);
  assert.equal(result.trainingPlan, null);
  assert.equal(result.warning, "academic_plan_format_changed");
  assert.equal(result.planError.diagnostic.parseReason, "plan_course_pattern_invalid");
  assert.equal(connector.pendingCount(), 0);
});

test("connector uses the official single-bound-phone SMS endpoints", async () => {
  const challenge = rsaChallengeXml();
  const paths = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === "/por/login_auth.csp") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
        { headers: { "set-cookie": "SVPNCOOKIE=session; Path=/" } },
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/post_sms.csp") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("phone_number"), "");
      assert.equal(form.get("phone_index"), "0");
      return response("<Auth><ErrorCode>1</ErrorCode><SmsSendInterval>60</SmsSendInterval></Auth>");
    }
    if (parsed.pathname === "/por/login_sms1.csp") {
      const code = new URLSearchParams(options.body).get("svpn_inputsms");
      return response(
        code === "123456"
          ? "<Auth><ErrorCode>20021</ErrorCode><TwfID>authenticated-session</TwfID></Auth>"
          : "<Auth><ErrorCode>20012</ErrorCode></Auth>",
      );
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) {
      assert.match(options.headers.Cookie, /TWFID=authenticated-session/u);
      return response(timetableHtml);
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(parsed);
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(started.status, "sms_required");
  assert.equal(started.maskedPhone, "138****0000");
  assert.equal(connector.pendingCount(), 1);
  await assert.rejects(
    connector.verifySms({
      transactionId: started.transactionId,
      code: "654321",
      principalKey: "device:test",
    }),
    { code: "ACADEMIC_SMS_INVALID" },
  );
  assert.equal(connector.pendingCount(), 1);
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
  assert.ok(paths.includes("/por/post_sms.csp"));
  assert.ok(paths.includes("/por/login_sms1.csp"));
  assert.ok(!paths.includes("/por/get_sms.csp"));
  assert.ok(!paths.includes("/por/login_sms2.csp"));
  assert.equal(connector.pendingCount(), 0);
});

test("connector follows school WebVPN resource redirects after SMS login", async () => {
  const challenge = rsaChallengeXml();
  const redirectedHost = "202-199-165-193.vpn.dufe.edu.cn:8118";
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") return response(challenge);
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/post_sms.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms1.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><TwfID>authenticated-session</TwfID></Auth>",
      );
    }
    if (
      parsed.hostname === "zhjw-dufe-edu-cn.vpn.dufe.edu.cn" &&
      parsed.pathname.includes("thisSemesterCurriculum")
    ) {
      return response("", {
        status: 302,
        headers: {
          location: `http://${redirectedHost}${parsed.pathname}`,
        },
      });
    }
    if (
      parsed.host === redirectedHost &&
      parsed.pathname.includes("thisSemesterCurriculum")
    ) {
      return response(timetableHtml);
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(parsed);
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
  assert.equal(completed.snapshot.sections.length, 2);
});

test("connector completes the school CAS slider step before importing", async () => {
  const challenge = rsaChallengeXml();
  const ssoHost = "sso-dufe-edu-cn.vpn.dufe.edu.cn:8118";
  const timetablePath = "/student/courseSelect/thisSemesterCurriculum/index";
  const serviceUrl = `http://zhjw-dufe-edu-cn.vpn.dufe.edu.cn:8118${timetablePath}`;
  let casSubmissions = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const cookies = String(options.headers?.Cookie ?? "");
    if (parsed.pathname === "/por/login_auth.csp") return response(challenge);
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/post_sms.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms1.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode><TwfID>vpn-session</TwfID></Auth>");
    }
    if (parsed.host === ssoHost && parsed.pathname === "/auth/cas/login") {
      if ((options.method ?? "GET") === "POST") {
        casSubmissions += 1;
        const form = new URLSearchParams(options.body);
        assert.equal(form.get("username"), "20260001");
        assert.equal(form.get("password"), "R6ANtscKUJD0ksbUwLNNDw==");
        assert.ok(!String(options.body).includes("test-password"));
        assert.equal(form.get("verify_token"), sliderToken);
        assert.match(form.get("verify_code"), /^11[67]$/u);
        assert.equal(form.get("__token__"), "csrf-test-token");
        assert.match(form.get("fingerprint"), /^[a-f0-9]{32}$/u);
        if (form.get("verify_code") === "116") {
          return response(casLoginHtml);
        }
        return response("", {
          status: 302,
          headers: {
            location: serviceUrl,
            "set-cookie": "SSO_SESSION=ready; Path=/",
          },
        });
      }
      return response(casLoginHtml, {
        headers: { "set-cookie": "SSO_PRE=session; Path=/" },
      });
    }
    if (parsed.host === ssoHost && parsed.pathname === "/auth/widget") {
      assert.equal(options.method, "POST");
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("width"), "280");
      assert.equal(form.get("height"), "155");
      assert.equal(form.get("block_size"), "80");
      return response(sliderChallenge, {
        headers: { "content-type": "application/json" },
      });
    }
    if (parsed.pathname === timetablePath) {
      if (/SSO_SESSION=ready/u.test(cookies)) {
        return response(timetableHtml, {
          headers: { "set-cookie": "ACADEMIC_SESSION=ready; Path=/" },
        });
      }
      return response("", {
        status: 302,
        headers: {
          location: `http://${ssoHost}/auth/cas/login?service=${encodeURIComponent(serviceUrl)}`,
        },
      });
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(parsed);
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  const prompted = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(prompted.status, "sso_verification_required");
  assert.equal(prompted.challenge.width, 280);
  assert.equal(prompted.challenge.pieceWidth, 80);
  assert.equal(prompted.challenge.maxOffset, 240);
  assert.match(prompted.challenge.backgroundImage, /^data:image\/png;base64,/u);
  assert.equal(connector.pendingCount(), 1);

  const retried = await connector.verifySso({
    transactionId: started.transactionId,
    verifyCode: "116",
    principalKey: "device:test",
  });
  assert.equal(retried.status, "sso_verification_required");
  assert.equal(retried.verificationFailed, true);
  assert.equal(connector.pendingCount(), 1);

  const completed = await connector.verifySso({
    transactionId: started.transactionId,
    verifyCode: "117",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
  assert.equal(completed.snapshot.sections.length, 2);
  assert.equal(completed.snapshot.exams.length, 1);
  assert.equal(casSubmissions, 2);
  assert.equal(connector.pendingCount(), 0);
});

test("connector rejects external redirects and retains verified SMS sessions for retry", async () => {
  const challenge = rsaChallengeXml();
  let timetableAttempts = 0;
  let smsVerificationAttempts = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") return response(challenge);
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/post_sms.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms1.csp") {
      smsVerificationAttempts += 1;
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) {
      timetableAttempts += 1;
      if (timetableAttempts === 1) {
        return response("", {
          status: 302,
          headers: { location: "https://attacker.example/capture" },
        });
      }
      return response(timetableHtml);
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(parsed);
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  await assert.rejects(
    connector.verifySms({
      transactionId: started.transactionId,
      code: "123456",
      principalKey: "device:test",
    }),
    (error) => {
      assert.equal(error.code, "ACADEMIC_UNTRUSTED_REDIRECT");
      assert.equal(error.stage, "timetable_fetch");
      assert.equal(error.retryable, true);
      assert.equal(
        error.diagnostic.redirectFromOrigin,
        "http://zhjw-dufe-edu-cn.vpn.dufe.edu.cn:8118",
      );
      assert.equal(
        error.diagnostic.redirectToOrigin,
        "https://attacker.example",
      );
      assert.equal(error.diagnostic.redirectStatus, 302);
      return true;
    },
  );
  assert.equal(connector.pendingCount(), 1);
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
  assert.equal(smsVerificationAttempts, 1);
  assert.equal(connector.pendingCount(), 0);
});

test("connector accepts the official redirect-range auth completion codes", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response("<Auth><ErrorCode>40001</ErrorCode><TwfID>redirect-session</TwfID></Auth>");
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) {
      return response(timetableHtml);
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(parsed);
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const completed = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
});

test("connector requests a phone only when the school account has none", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") return response(challenge);
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode><USER_PHONE></USER_PHONE></Auth>");
    }
    if (parsed.pathname === "/por/get_sms.csp") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("phone_number"), "13800000000");
      assert.equal(form.get("phone_index"), "0");
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms2.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) return response(timetableHtml);
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(parsed);
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(started.status, "sms_destination_required");
  assert.equal(started.destination, "enter");
  assert.deepEqual(started.phoneOptions, []);
  const sent = await connector.sendSms({
    transactionId: started.transactionId,
    phone: "13800000000",
    principalKey: "device:test",
  });
  assert.equal(sent.status, "sms_required");
  assert.equal(sent.maskedPhone, "138****0000");
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
});

test("connector lets users choose among multiple school phone records", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") return response(challenge);
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>139****1111;138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/get_sms.csp") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("phone_number"), "138****0000");
      assert.equal(form.get("phone_index"), "1");
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms2.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) return response(timetableHtml);
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    const plan = trainingPlanResponse(parsed);
    if (plan) return plan;
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(started.status, "sms_destination_required");
  assert.equal(started.destination, "choose");
  assert.deepEqual(started.phoneOptions, [
    { index: 0, label: "139****1111" },
    { index: 1, label: "138****0000" },
  ]);
  await connector.sendSms({
    transactionId: started.transactionId,
    phoneIndex: "1",
    principalKey: "device:test",
  });
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
});

test("connector maps invalid school credentials without retaining a transaction", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp" || parsed.pathname === "/public/psw_config") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    return response(
      "<Auth><ErrorCode>20004</ErrorCode><Message>Invalid username or password!</Message></Auth>",
    );
  };
  const connector = createAcademicConnector({ fetchImpl });
  await assert.rejects(
    connector.start({
      username: "invalid",
      password: "invalid",
      principalKey: "device:test",
    }),
    { code: "ACADEMIC_INVALID_CREDENTIALS" },
  );
  assert.equal(connector.pendingCount(), 0);
});
