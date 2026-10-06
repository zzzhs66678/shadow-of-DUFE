import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const snapshot = {
  schemaVersion: 1,
  id: "2026-2027-fall",
  academicYear: "2026-2027",
  term: "fall",
  termLabel: "第一学期",
  importedAt: "2026-09-28T02:03:04.000Z",
  sections: [
    {
      id: "academic-section:test",
      courseCode: "31131862",
      courseName: "内部审计",
      sectionCode: "01",
      credits: "2",
      property: "必修",
      category: "专业必修",
      assessmentType: "考试",
      teachers: ["姜博"],
      studyMode: "正常",
      selectionStatus: "选中",
      meetings: [
        {
          id: "academic-meeting:monday",
          weekday: 1,
          periods: [1, 2],
          block: 1,
          weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9],
          weekText: "1-9周",
          timeText: "1-9周 / 星期一 / 1-2节",
          campus: "校本部",
          building: "之远楼",
          room: "516",
        },
        {
          id: "academic-meeting:wednesday",
          weekday: 3,
          periods: [5, 6, 7],
          block: 3,
          weeks: [10, 11, 12, 13, 14, 15, 16, 17, 18],
          weekText: "10-18周",
          timeText: "10-18周 / 星期三 / 5-7节",
          campus: "校本部",
          building: "笃行楼",
          room: "403",
        },
      ],
    },
  ],
  exams: [
    {
      id: "academic-exam:test",
      courseCode: "31131862",
      courseName: "内部审计",
      sectionCode: "01",
      examType: "期末",
      date: "2027-01-08",
      startTime: "09:00",
      endTime: "11:00",
      campus: "校本部",
      building: "梅园",
      room: "201",
      location: "校本部 / 梅园 / 201",
      seat: "18",
      examNumber: "20260001",
      status: "已安排",
    },
  ],
};

const trainingPlan = {
  schemaVersion: 1,
  planNumber: "P2026",
  planName: "2026级审计学专业培养方案",
  majorCode: "120207",
  majorName: "审计学",
  cohortYear: 2026,
  requiredCredits: 160,
  earnedCredits: 96,
  categories: [
    {
      code: "A",
      name: "专业必修课",
      requiredCredits: 80,
      earnedCredits: 58,
      parentCode: null,
    },
    {
      code: "A-1",
      name: "专业基础必修",
      requiredCredits: 20,
      earnedCredits: 18,
      parentCode: "A",
    },
    {
      code: "B",
      name: "专业选修课",
      requiredCredits: 20,
      earnedCredits: 6,
      parentCode: null,
    },
  ],
  courses: [
    {
      courseCode: "31131862",
      courseName: "内部审计",
      categoryCode: "A-1",
      categoryName: "专业基础必修",
      attribute: "required",
      credits: 2,
      completionStatus: "passed",
      completedTerm: "2025-2026学年第二学期",
      replacementCourseCodes: [],
    },
    {
      courseCode: "NO-CURRENT-OFFERING",
      courseName: "审计专题",
      categoryCode: "B",
      categoryName: "专业选修课",
      attribute: "limited",
      credits: 2,
      completionStatus: "not_taken",
      completedTerm: "",
      replacementCourseCodes: [],
    },
  ],
  importedAt: "2026-09-28T02:03:04.000Z",
};

test("old selections reconcile with imports without deleting stored plans; timetable remains readable", async ({ page }) => {
  const catalog = JSON.parse(readFileSync("public/data/course-data.json", "utf8"));
  const manual = catalog.schedules.find((item: { term: string; weekday: number; teacher: string }) => item.term === "fall" && item.weekday < 6 && item.teacher);
  const sectionCode = manual.sectionId.split("-")[2];
  const imported = { ...snapshot, sections: [{ ...snapshot.sections[0],
    courseCode: manual.courseId, sectionCode, courseName: manual.title, teachers: [manual.teacher],
    meetings: [{ ...snapshot.sections[0].meetings[0], weekday: manual.weekday, block: manual.block,
      periods: manual.periods, weeks: manual.weeks, building: manual.building, room: manual.room, timeText: manual.timeText }],
  }], exams: [] };
  const seed = { profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [manual.id] }],
    activePlanId: "default", activities: [], assignments: [], academicSnapshots: [imported], trainingPlan,
    favoriteRooms: [], recentRooms: [] };
  await page.addInitScript((state) => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(state)), seed);
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.goto("/?view=schedule");
  await expect(page.locator(".academic-schedule-card")).toHaveCount(1);
  await expect(page.locator(".draggable-schedule")).toHaveCount(0);
  const card = page.locator(".academic-schedule-card");
  await expect(card.getByText(manual.teacher, { exact: true })).toBeVisible();
  await expect(card.getByText(`${manual.building}${manual.room}`, { exact: true })).toBeVisible();
  expect(await card.locator("small").first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => {
    const grid = document.querySelector(".week-grid")!;
    const plan = document.querySelector('[data-testid="training-plan-window"]')!;
    return Boolean(grid.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await expect(page.locator(".week-grid .day-head")).toHaveCount(5);
  await page.getByRole("button", { name: "显示完整七天" }).click();
  await expect(page.locator(".week-grid .day-head")).toHaveCount(7);
  await page.getByRole("button", { name: "隐藏空白周末" }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("dufesh:student-profile:v3:anonymous")!).plans[0].scheduleIds)).toEqual([manual.id]);
  await page.locator(".week-grid").screenshot({ path: ".codex_tmp/personal-timetable-390.png" });
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".campus-suggestion")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "找空教室", exact: true })).toBeVisible();
});

test("official timetable excludes preselected courses; planning preserves them without changing today's lessons", async ({ page }) => {
  const catalog = JSON.parse(readFileSync("public/data/course-data.json", "utf8"));
  const manual = catalog.schedules.find((item: { term: string; weekday: number; courseId: string; weeks: number[] }) =>
    item.term === "fall" && item.weekday === 2 && item.weeks?.includes(6) && item.courseId !== snapshot.sections[0].courseCode);
  const seed = { profile: null, skipped: true,
    plans: [{ id: "default", name: "默认课表", scheduleIds: [manual.id] }], activePlanId: "default",
    activities: [], assignments: [], academicSnapshots: [{ ...snapshot, exams: [] }], trainingPlan,
    favoriteRooms: [], recentRooms: [] };
  await page.clock.install({ time: new Date("2026-10-06T00:00:00+08:00") });
  await page.addInitScript((state) => {
    if (!localStorage.getItem("dufesh:student-profile:v3:anonymous")) {
      localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(state));
    }
  }, seed);
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.goto("/?view=schedule");
  await expect(page.getByRole("button", { name: "教务课表", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".academic-schedule-card")).toHaveCount(2);
  await expect(page.locator(".draggable-schedule")).toHaveCount(0);
  await page.getByRole("button", { name: "＋ 添加作业", exact: true }).click();
  await expect(page.locator('select[name="assignment-course"] option[value="31131862"]')).toHaveText("内部审计");
  await page.getByRole("dialog", { name: "添加作业" }).getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".timetable-panel").screenshot({ path: ".codex_tmp/official-only-timetable.png" });
  await page.getByRole("button", { name: /手动选课/ }).click();
  await expect(page.locator(".draggable-schedule")).toHaveCount(1);
  await expect(page.locator(".draggable-schedule strong")).toHaveText(manual.title);
  await expect(page.getByText("含手动课程，不计入今日上课提醒。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".today-page").getByText(manual.title, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("dufesh:student-profile:v3:anonymous")!).plans[0].scheduleIds)).toEqual([manual.id]);
  await page.goto("/?view=schedule");
  await expect(page.locator(".draggable-schedule")).toHaveCount(0);
  // Removing the import for this isolated fixture restores the untouched legacy timetable.
  await page.evaluate(() => {
    const key = "dufesh:student-profile:v3:anonymous";
    const state = JSON.parse(localStorage.getItem(key)!);
    state.academicSnapshots = [];
    localStorage.setItem(key, JSON.stringify(state));
  });
  await page.reload();
  await expect(page.locator(".draggable-schedule")).toHaveCount(1);
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".today-page").getByText(manual.title, { exact: true }).first()).toBeVisible();
});

test("teaching-class shortcuts point to existing reviews and exact course materials", async ({ page }) => {
  const catalog = JSON.parse(readFileSync("public/data/course-data.json", "utf8"));
  const manual = catalog.schedules.find((item: { term: string; weekday: number; teacher: string }) => item.term === "fall" && item.weekday < 6 && item.teacher);
  await page.addInitScript((id) => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({
    profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [id] }],
    activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
  })), manual.id);
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: false } }));
  const teacherId = "11111111-1111-4111-8111-111111111111";
  await page.route("**/api/teachers/by-schedule?*", (route) => route.fulfill({ json: {
    items: [{ id: teacherId, displayName: manual.teacher, reviewCount: 3 }],
  } }));
  await page.route("**/data/resource-manifest.json", (route) => route.fulfill({ json: { materials: [
    { id: "real-course", courseTitle: manual.title, courseIds: [manual.courseId], name: "课程资料", kind: "PDF", extension: ".pdf", sizeBytes: 500,
      description: "", previewable: false, previewUrl: "", downloadUrl: "/resources/test.pdf" },
    { id: "same-name", courseTitle: manual.title, courseIds: ["ANOTHER-CODE"], name: "同名的其他课程", kind: "PDF", extension: ".pdf", sizeBytes: 500,
      description: "", previewable: false, previewUrl: "", downloadUrl: "/resources/another.pdf" },
  ] } }));
  await page.goto("/?view=schedule");
  await page.locator(".schedule-card-main").first().click();
  const shortcuts = page.locator(".teaching-section-links").first();
  await shortcuts.scrollIntoViewIfNeeded();
  await expect(shortcuts.getByRole("link", { name: "学生评价 · 3" })).toHaveAttribute("href", `/teachers/${teacherId}#teacher-reviews-title`);
  await expect(shortcuts.getByRole("link", { name: "学习资料 · 1" })).toHaveAttribute("href", `/materials?course=${manual.courseId}`);
  await expect(page.getByText("同名的其他课程", { exact: true })).toHaveCount(0);
  await page.locator(".course-drawer").screenshot({ path: ".codex_tmp/course-shortcuts-390.png" });
});

test("expired academic transactions return to a fresh login form", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.route("**/api/auth/academic/connect", (route) =>
    route.fulfill({
      json: {
        status: "sms_required",
        transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
        maskedPhone: "138****0000",
      },
    }),
  );
  await page.route("**/api/auth/academic/sms", (route) =>
    route.fulfill({
      status: 410,
      json: {
        error: "academic_transaction_expired",
        stage: "plan_parse",
      },
    }),
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "打开课程中心", exact: true })
    .click();
  await page
    .getByRole("button", { name: "导入教务数据", exact: true })
    .click();
  await page.getByLabel("教务账号").fill("20260001");
  await page.getByLabel("教务密码").fill("school-password");
  await page.getByRole("button", { name: "登录并自动导入" }).click();
  await page.getByRole("textbox", { name: "短信验证码" }).fill("123456");
  await page.getByRole("button", { name: "验证并完成导入" }).click();

  await expect(page.getByRole("heading", { name: "导入教务数据" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "本次教务登录已经超时，请重新连接。",
  );
  await expect(page.getByLabel("教务密码")).toHaveValue("");
});

test("verified timetable and exams remain visible when the training plan alone fails", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.route("**/api/auth/academic/connect", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      username: "20260001",
      password: "school-password",
    });
    await route.fulfill({
      json: {
        status: "partial_imported",
        snapshot,
        trainingPlan: null,
        warning: "academic_plan_format_changed",
      },
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "打开课程中心", exact: true })
    .click();
  await page
    .getByRole("button", { name: "导入教务数据", exact: true })
    .click();
  await page.getByLabel("教务账号").fill("20260001");
  await page.getByLabel("教务密码").fill("school-password");
  await page.getByRole("button", { name: "登录并自动导入" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "2026-2027 第一学期：1 门课、1 项考试、培养方案本次未更新",
  );
  await expect(page.getByRole("region", { name: "教务数据状态" })).toContainText(
    "1 门课 · 1 项考试",
  );
  await expect(page.getByRole("region", { name: "下一场考试" })).toContainText(
    "内部审计",
  );
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.getByRole("region", { name: "最近考试" })).toContainText(
    "内部审计",
  );

  await page
    .getByRole("button", { name: "我的课表", exact: true })
    .click();
  await expect(page.locator(".academic-schedule-card")).toHaveCount(2);
  await expect(page.locator(".academic-exam-list article")).toHaveCount(1);
  await expect(page.getByText("导入后可查看待选课程与已修学分")).toBeVisible();
  await expect(page.getByTestId("training-plan-window")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("an exam refresh failure keeps the previous exams but labels them stale", async ({
  page,
}) => {
  let importCount = 0;
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.route("**/api/auth/academic/connect", async (route) => {
    importCount += 1;
    await route.fulfill({
      json:
        importCount === 1
          ? { status: "imported", snapshot, trainingPlan }
          : {
              status: "partial_imported",
              snapshot: {
                ...snapshot,
                importedAt: "2026-10-06T11:17:10.000Z",
                exams: [],
                examStatus: "unavailable",
              },
              trainingPlan,
              warning: "academic_exam_format_changed",
            },
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "打开课程中心", exact: true }).click();
  await page.getByRole("button", { name: "导入教务数据", exact: true }).click();
  await page.getByLabel("教务账号").fill("20260001");
  await page.getByLabel("教务密码").fill("school-password");
  await page.getByRole("button", { name: "登录并自动导入" }).click();
  await expect(page.getByRole("region", { name: "下一场考试" })).toContainText(
    "内部审计",
  );

  await page
    .getByRole("region", { name: "教务数据状态" })
    .getByRole("button", { name: "更新教务数据", exact: true })
    .click();
  await page.getByLabel("教务账号").fill("20260001");
  await page.getByLabel("教务密码").fill("school-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "更新教务数据", exact: true })
    .click();

  await expect(page.getByRole("status")).toContainText("考试沿用上次数据");
  await expect(page.getByRole("region", { name: "教务数据状态" })).toContainText(
    "考试未更新",
  );
  await expect(page.getByRole("region", { name: "下一场考试" })).toHaveCount(0);
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "考试安排未同步" }),
  ).toContainText("本次未更新");
  await expect(page.getByRole("region", { name: "最近考试" })).toHaveCount(0);

  const stored = await page.evaluate(() => {
    const value = localStorage.getItem("dufesh:student-profile:v3:anonymous");
    return value ? JSON.parse(value).academicSnapshots[0] : null;
  });
  expect(stored.examStatus).toBe("stale");
  expect(stored.exams).toHaveLength(1);
});

test("official timetable and exams import through SMS and school verification", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.route("**/api/auth/academic/connect", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      username: "20260001",
      password: "school-password",
    });
    await route.fulfill({
      json: {
        status: "sms_destination_required",
        transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
        destination: "enter",
        phoneOptions: [],
      },
    });
  });
  await page.route("**/api/auth/academic/sms/send", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
      phone: "13800000000",
    });
    await route.fulfill({
      json: {
        status: "sms_required",
        transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
        maskedPhone: "138****0000",
      },
    });
  });
  await page.route("**/api/auth/academic/sms", async (route) => {
    const body = route.request().postDataJSON();
    if (!("code" in body)) {
      expect(body).toEqual({
        transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
      });
      await route.fulfill({
        json: { status: "imported", snapshot, trainingPlan },
      });
      return;
    }
    expect(body).toEqual({
      transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
      code: "123456",
    });
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZK0cAAAAASUVORK5CYII=";
    await route.fulfill({
      json: {
        status: "sso_verification_required",
        transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
        challenge: {
          backgroundImage: image,
          pieceImage: image,
          width: 280,
          height: 155,
          pieceWidth: 80,
          maxOffset: 240,
        },
      },
    });
  });
  await page.route("**/api/auth/academic/sso", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
      verifyCode: "117",
    });
    await route.fulfill({
      status: 502,
      json: {
        error: "academic_format_changed",
        retryable: true,
        stage: "timetable_parse",
      },
    });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "打开课程中心", exact: true })
    .click();
  await page
    .getByRole("button", { name: "导入教务数据", exact: true })
    .click();
  const dialogA11y = await new AxeBuilder({ page })
    .include(".academic-import-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    dialogA11y.violations.filter(
      ({ impact }) => impact === "critical" || impact === "serious",
    ),
  ).toEqual([]);

  await page.getByLabel("教务账号").fill("20260001");
  await page.getByLabel("教务密码").fill("school-password");
  await page.getByRole("button", { name: "登录并自动导入" }).click();
  await page.getByLabel("手机号").fill("13800000000");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await page.getByRole("textbox", { name: "短信验证码" }).fill("123456");
  await page.getByRole("button", { name: "验证并完成导入" }).click();
  await expect(page.getByRole("heading", { name: "完成学校验证" })).toBeVisible();
  await page.getByRole("slider", { name: "拖动拼图图块" }).fill("117");
  await page.getByRole("button", { name: "验证并完成导入" }).click();
  await expect(
    page.getByRole("heading", { name: "继续读取教务数据" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "学校调整了课表页面",
  );
  await expect(page.getByRole("alert")).toContainText(
    "学校登录仍有效",
  );
  await page.getByRole("button", { name: "直接重试读取" }).click();

  await expect(page.getByRole("region", { name: "教务数据状态" })).toContainText(
    "1 门课 · 1 项考试",
  );
  await expect(page.getByRole("region", { name: "下一场考试" })).toContainText(
    "内部审计",
  );
  await page.getByRole("button", { name: "今天", exact: true }).click();
  const examNotice = page.getByRole("region", { name: "最近考试" });
  await expect(examNotice).toContainText("内部审计");
  await expect(examNotice).toContainText("梅园");
  await expect(examNotice).toContainText("座位");
  await expect(examNotice).toContainText("18");
  await expect(examNotice).toContainText("考号");
  await expect(examNotice).toContainText("20260001");
  await page.getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.getByRole("region", { name: "我的考试" })).toContainText(
    "内部审计",
  );
  await page
    .getByRole("button", { name: "我的课表", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "我的课表" })).toBeVisible();
  await expect(page.locator(".academic-schedule-card")).toHaveCount(2);
  await expect(page.locator(".academic-exam-list article")).toHaveCount(1);
  await expect(page.locator(".academic-exam-list")).toContainText("内部审计");
  await expect(page.locator(".academic-exam-list")).toContainText("座位");
  await expect(page.locator(".academic-exam-list")).toContainText("18");
  await expect(page.locator(".academic-exam-list")).toContainText("考号");
  await expect(page.locator(".academic-exam-list")).toContainText("20260001");
  await expect(page.getByRole("heading", { name: "审计学" })).toBeVisible();
  const planWindow = page.getByTestId("training-plan-window");
  await expect(planWindow.getByText("96", { exact: true })).toBeVisible();
  await expect(
    planWindow.getByRole("button", { name: /本学期 1/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await planWindow.getByRole("button", { name: /专业基础必修/ }).click();
  const currentPlanCourse = planWindow.locator("article").filter({
    hasText: "内部审计",
  });
  await expect(currentPlanCourse).toContainText("本学期");
  await planWindow.getByRole("button", { name: /待选 1/ }).click();
  await planWindow.getByRole("button", { name: /专业选修课/ }).click();
  const pendingPlanCourse = planWindow.locator("article").filter({
    hasText: "审计专题",
  });
  await expect(pendingPlanCourse).toContainText("本学期未开");

  const storage = await page.evaluate(() =>
    localStorage.getItem("dufesh:student-profile:v3:anonymous"),
  );
  expect(storage).toContain("2026-2027-fall");
  expect(storage).toContain("2026级审计学专业培养方案");
  expect(storage).not.toContain("school-password");
  await page.evaluate(() => {
    const key = "dufesh:student-profile:v3:anonymous";
    const value = localStorage.getItem(key);
    if (!value) throw new Error("missing personal state");
    const parsed = JSON.parse(value);
    parsed.academicSnapshots = parsed.academicSnapshots.map(
      (item: { exams: unknown[] }) => ({ ...item, exams: [] }),
    );
    parsed.skipped = true;
    localStorage.setItem(key, JSON.stringify(parsed));
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "最近考试" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "下一场考试" })).toHaveCount(0);
  await page.getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.getByRole("region", { name: "我的考试" })).toHaveCount(0);
  await page
    .getByRole("button", { name: "我的课表", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "考试安排" })).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  ).toBe(false);
  expect(pageErrors).toEqual([]);
});
