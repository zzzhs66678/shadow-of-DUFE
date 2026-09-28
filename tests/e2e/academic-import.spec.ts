import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
      status: "已安排",
    },
  ],
};

test("official timetable and exams import through the SMS flow", async ({
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
    expect(route.request().postDataJSON()).toEqual({
      transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
      code: "123456",
    });
    await route.fulfill({ json: { status: "imported", snapshot } });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "从教务导入", exact: true })
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

  await expect(page.locator(".academic-sync-band p")).toContainText(
    "已导入 1 门课、1 项考试",
  );
  await page
    .getByRole("button", { name: "我的课表", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "我的课表" })).toBeVisible();
  await expect(page.locator(".academic-schedule-card")).toHaveCount(2);
  await expect(page.locator(".academic-exam-list article")).toHaveCount(1);
  await expect(page.locator(".academic-exam-list")).toContainText("内部审计");
  await expect(page.locator(".academic-exam-list")).toContainText("座位 18");

  const storage = await page.evaluate(() =>
    localStorage.getItem("dufesh:student-profile:v3:anonymous"),
  );
  expect(storage).toContain("2026-2027-fall");
  expect(storage).not.toContain("school-password");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  ).toBe(false);
  expect(pageErrors).toEqual([]);
});
