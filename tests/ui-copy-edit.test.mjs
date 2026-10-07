import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hub = read("app/DufeHubV2.tsx");

test("campus photos keep images and alt text without visible introductions or captions", () => {
  const album = hub.slice(hub.indexOf("function CampusAlmanac()"), hub.indexOf("function KnowledgeTribute()"));
  assert.equal((album.match(/<img\b/gu) ?? []).length, 7);
  assert.equal((album.match(/alt="[^"]+"/gu) ?? []).length, 7);
  assert.doesNotMatch(album, /<figcaption|<p>|校园影集|另一张课表/u);
  assert.match(album, /id="campus-almanac-title">校园相册/u);
  assert.match(hub, /Apneet Jolly/u);
  assert.match(hub, /CC BY 2\.0/u);
});

test("routine screens are concise while meaningful risks remain explicit", () => {
  assert.doesNotMatch(hub, /稍等一下，马上就好|今天学什么，去哪儿学|最多同时比较 4 个教学班|校园空间|同楼已经排前面/u);
  for (const copy of ["现在的数据只保存在这台设备", "清理微信或浏览器缓存前", "选课预览，不代表教务选课结果", "考试安排未同步", "仅用于本次导入，不会保存。", "按课表推算，是否开放以现场为准。", "是否把这些课表、日程和作业导入当前账号？"]) {
    assert.ok(hub.includes(copy), copy);
  }
});

test("import errors report known state rather than inventing a school-side change", () => {
  assert.doesNotMatch(hub, /学校调整了(?:课表|考试安排|培养方案|登录)页面/u);
  assert.match(hub, /课表暂时读不完整，本次未导入，已有课表未改动/u);
  assert.match(hub, /考试安排暂时读不完整。课表照常导入，考试标为未同步/u);
  assert.match(hub, /培养方案暂时读不完整，本次未更新培养方案/u);
});

test("navigation and form labels describe their actual action", () => {
  assert.match(read("app/admin/AdminConsole.tsx"), /actionLabel="返回首页"/u);
  assert.doesNotMatch(read("app/admin/AdminConsole.tsx"), /actionLabel="安全退出"/u);
  assert.match(hub, /label="用户名" hint="3–24 个字/u);
  assert.match(hub, /label="邮箱验证码"/u);
});
