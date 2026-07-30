import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(
  new URL("../app/DufeHubV2.tsx", import.meta.url),
  "utf8",
);
const productStyles = await readFile(
  new URL("../app/product-system.css", import.meta.url),
  "utf8",
);

test("today page keeps the one-glance command deck", () => {
  assert.match(component, /today-command-deck/);
  assert.match(component, /todayAgenda[\s\S]*nextThree/);
  assert.match(component, /campusSuggestion/);
  assert.match(productStyles, /\.now-card/);
  assert.match(productStyles, /\.agenda-glance/);
});

test("campus services keep a compact today dock and a full personal-page gateway", () => {
  const homeStart = component.indexOf("function HomePage");
  const meStart = component.indexOf("function MePage");
  const searchStart = component.indexOf("function SearchCommand");
  const homeSource = component.slice(homeStart, meStart);
  const meSource = component.slice(meStart, searchStart);

  assert.match(homeSource, /campus-pins/);
  assert.doesNotMatch(homeSource, /campus-gateway/);
  assert.match(meSource, /campus-gateway/);
  assert.match(meSource, /campus-lab-entry/);
  assert.match(component, /web\.traceint\.com\/web\/index\.html/);
  assert.match(component, /person_card\/index\?sessionid=/);
  assert.match(component, /ginkgostu\.dufe\.edu\.cn\/notice\/system/);
});

test("the visual system uses a campus route and licensed campus image", () => {
  assert.match(component, /dufe-campus-commons\.webp/);
  assert.match(productStyles, /@keyframes campus-route/);
  assert.match(productStyles, /\.campus-window/);
  assert.doesNotMatch(component, /<i>0[123]<\/i>/);
});

test("personal page explains local data, cloud sync, devices, and account control", () => {
  const meStart = component.indexOf("function MePage");
  const searchStart = component.indexOf("function SearchCommand");
  const meSource = component.slice(meStart, searchStart);

  assert.match(meSource, /账号与同步/);
  assert.match(meSource, /微信登录审核中/);
  assert.match(meSource, /保留本机修改/);
  assert.match(meSource, /使用云端版本/);
  assert.match(meSource, /登录设备/);
  assert.match(meSource, /退出登录/);
  assert.match(meSource, /确认注销/);
});

test("course drawer filters and compares teaching sections", () => {
  assert.match(component, /sectionQuery/);
  assert.match(component, /teacherFilter/);
  assert.match(component, /weekFilter/);
  assert.match(component, /buildingFilter/);
  assert.match(component, /conflictFilter/);
  assert.match(component, /compareIds/);
  assert.match(component, /schedulesOverlap/);
  assert.match(component, /scheduleWeeksLabel/);
});

test("mobile timetable offers daily and week views without changing export", () => {
  assert.match(component, /mobileScheduleView/);
  assert.match(component, /mobile-schedule-agenda/);
  assert.match(component, /week-overview-scroll/);
  assert.match(component, /export-canvas/);
  assert.match(productStyles, /\.timetable-panel\.export-canvas \.week-grid/);
});

test("room finder supports intent-based recommendations and device memory", () => {
  assert.match(component, /RoomStartMode/);
  assert.match(component, /RoomDuration/);
  assert.match(component, /什么时候去/);
  assert.match(component, /准备待多久/);
  assert.match(component, /targetBlocks/);
  assert.match(component, /roomIsAvailable/);
  assert.match(component, /availableUntil/);
  assert.match(component, /favoriteRooms/);
  assert.match(component, /recentRooms/);
  assert.match(productStyles, /\.room-recommendations/);
  assert.match(productStyles, /\.room-intents/);
});

test("customer-facing copy does not expose planning notes", () => {
  assert.doesNotMatch(component, /需要操作的内容，放在信息之后/);
  assert.doesNotMatch(component, /这个搜索词会作为后续补充别名的依据/);
  assert.doesNotMatch(component, /常用入口留在学习流的下方/);
  assert.doesNotMatch(component, /课程、教室与资料关系正在抵达/);
});

test("public compliance pages expose filing, privacy, terms, and deletion paths", async () => {
  assert.match(component, /辽ICP备2026016653号-1/);
  assert.match(component, /href="\/privacy"/);
  assert.match(component, /href="\/terms"/);
  assert.match(component, /href="\/account\/delete"/);

  const privacy = await readFile(
    new URL("../app/privacy/page.tsx", import.meta.url),
    "utf8",
  );
  const terms = await readFile(
    new URL("../app/terms/page.tsx", import.meta.url),
    "utf8",
  );
  const deletion = await readFile(
    new URL("../app/account/delete/page.tsx", import.meta.url),
    "utf8",
  );
  for (const page of [privacy, terms, deletion]) {
    assert.match(page, /2450256851@qq\.com/);
  }
});
