import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { savedState, snapshot, section, meeting, exam } from "../fixtures/hub-experience.mjs";
import { whiteboardLecture } from "../fixtures/whiteboard.mjs";

test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL || (process.env.CI ? "http://localhost:3000" : "http://localhost:3107"), timezoneId: "Asia/Shanghai" });
const now = "2026-10-12T07:30:00+08:00";
const name = "数字化管理会计（DMA）II（N）";
const official = snapshot({ sections: [section({ courseName: name, teachers:["演示教师甲 / 演示教师乙"], meetings:[meeting({ weeks:Array.from({length:18},(_,i)=>i+1),weekText:"1-18周",room:"1010" })] })], exams:[exam({ date:"2026-10-13",courseName:name,seat:"18",examNumber:"演示考号001" })] });
async function setup(page: Page, state = savedState(), board = true) {
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(value => localStorage.setItem("dufesh:student-profile:v3:anonymous",JSON.stringify(value)), state);
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    return route.fulfill({ json:path === "/api/auth/session" ? {authenticated:false} : {items:path === "/api/community/whiteboard" && board ? [whiteboardLecture] : [],nextCursor:null} });
  });
  return { errors,writes };
}

for (const width of [320,390,768,1280]) {
  test(`unified home retains real courses, exams, tasks, board and navigation at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width,height:844});
    const state = savedState({ academicSnapshots:[official],
      activities:[{id:"event-demo",title:"午间讨论",date:"2026-10-12",weekday:1,block:3,startTime:"13:10",endTime:"13:40",repeat:"none",location:"梅园A座",notes:"",color:"red"}],
      assignments:[{id:"task-demo",title:"提交小组报告",courseId:"",notes:"",completed:false,dueDate:"2026-10-12"}]
    });
    const checks = await setup(page,state);
    await page.goto("/?view=home");
    await expect(page.getByRole("button",{name:"返回东财之影首页",exact:true})).toBeVisible();
    const card = page.locator(".now-card"), exams = page.getByRole("region",{name:"最近考试",exact:true}), board = page.getByRole("region",{name:"小白板",exact:true});
    await expect(card).toContainText(name); await expect(card).toContainText("演示教师甲"); await expect(card).toContainText("1010");
    await expect(exams).toContainText("演示考号001"); await expect(exams).toContainText("18");
    await expect(board).toContainText(whiteboardLecture.title);
    expect((await exams.boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y);
    expect((await board.boundingBox())!.y).toBeGreaterThanOrEqual((await page.locator(".today-command-deck").boundingBox())!.y+(await page.locator(".today-command-deck").boundingBox())!.height);
    await expect(page.locator(".agenda-row.activity")).toContainText("13:10–13:40");
    await expect(page.locator(".agenda-row.assignment")).toContainText("提交小组报告");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width <= 900) await expect(page.locator(".agenda-glance")).toBeHidden();
    const violations = (await new AxeBuilder({page}).analyze()).violations.filter(v=>["serious","critical"].includes(v.impact||""));
    expect(violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`home-${width}.png`),fullPage:true});
    await page.locator(".unified-agenda").getByRole("button",{name:"＋ 添加日程",exact:true}).click();
    const dialog = page.getByRole("dialog",{name:"添加日程",exact:true}); await expect(dialog).toBeVisible();
    await dialog.getByRole("button",{name:"关闭",exact:true}).click();
    await page.locator("#wall-header-entry").click();
    await page.getByRole("link",{name:"← 返回今日",exact:true}).click(); await expect(card).toContainText(name);
    await page.getByRole("button",{name:"搜索全站",exact:true}).click(); await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
    expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
  });
}

for (const configured of [false,true]) {
  test(`empty home distinguishes a profile from a confirmed empty timetable: ${configured}`,async({page})=>{
    await setup(page,savedState({profile:{majorId:"unknown",entranceYear:2026,className:"演示班级"},academicSnapshots:configured ? [snapshot({sections:[],exams:[]})] : []}),false);
    await page.goto("/?view=home");
    await expect(page.getByRole("heading",{name:configured ? "今天没有后续课程" : "添加你的课表",exact:true})).toBeVisible();
    await expect(page.getByRole("region",{name:"最近考试",exact:true})).toHaveCount(0);
    await expect(page.getByRole("region",{name:"小白板",exact:true})).toHaveCount(0);
    await page.getByRole("button",{name:configured ? "打开课表" : "按班级添加",exact:true}).click();
    if (configured) await expect(page.locator(".schedule-page")).toBeVisible();
    else await expect(page.getByRole("dialog",{name:"按班级添加课程",exact:true})).toBeVisible();
  });
}

test("a next-day course is labelled with its weekday",async({page})=>{
  const next = snapshot({sections:[section({meetings:[meeting({weekday:2,weeks:Array.from({length:18},(_,i)=>i+1),weekText:"1-18周"})]})],exams:[]});
  await setup(page,savedState({academicSnapshots:[next]}),false); await page.goto("/?view=home");
  await expect(page.locator(".now-card > header")).toContainText("下一节课 · 周二");
});

test("an unconfirmed exam page remains distinct from no exams",async({page})=>{
  await setup(page,savedState({academicSnapshots:[snapshot({...official,examStatus:"unavailable"})]}),false);
  await page.goto("/?view=home");
  await expect(page.getByRole("region",{name:"考试安排未同步",exact:true})).toContainText("尚未同步");
  await expect(page.getByRole("region",{name:"最近考试",exact:true})).toHaveCount(0);
});
