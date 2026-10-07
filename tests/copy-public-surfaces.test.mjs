import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hub = read("app/community/CommunityHub.tsx");
const topic = read("app/community/CommunityTopicView.tsx");
const shared = read("app/community/CommunityShared.tsx");
const profile = read("app/community/CommunityProfileView.tsx");
const saved = read("app/community/saved/CommunitySavedView.tsx");
const teachers = read("app/teachers/TeacherExplorer.tsx");
const detail = read("app/teachers/[teacherId]/TeacherDetail.tsx");
const discussion = read("app/teachers/TeacherReviewDiscussion.tsx");
const materials = read("app/materials/MaterialsExplorer.tsx");
const material = read("app/materials/[materialId]/page.tsx");
const availability = read("app/materials/MaterialAvailability.tsx");
const missingMaterial = read("app/materials/[materialId]/not-found.tsx");

test("public surfaces use direct labels without duplicate introductions", () => {
  assert.match(hub, /<h1 id="community-title">校园回廊<\/h1>/u);
  assert.match(hub, /已加载主题/u);
  assert.match(hub, /正在加载主题/u);
  assert.match(hub, /加载更多主题/u);
  assert.doesNotMatch(hub, /让有用的话|在校园里多走一段|正在听回廊里的声音|继续往前走|沿时间向前读/u);
  assert.doesNotMatch(topic, /线程墓碑|页面不会替你提交任何操作|回复只展开一层|补上第一段/u);
  assert.doesNotMatch(saved, /留存与边界|PRIVATE INDEX|控制阅读边界的工具|不会混入匿名设备数据/u);
  assert.doesNotMatch(materials, /东财课程资料档案|支持预览与下载|按课程、教师或文件名找资料/u);
  assert.match(materials, /<h1 id=\{titleId\}>学习资料<\/h1>/u);
});

test("teacher identity, history, uncertainty and publication boundaries remain explicit", () => {
  assert.match(teachers, /同名教师请核对学院/u);
  assert.match(teachers, /来自已导入课表/u);
  assert.match(teachers, /同名记录不会自动合并/u);
  for (const text of ["历史评价", "评价当前未公开", "评价已隐藏，审核期间不可修改，仍可删除", "确定删除这条评价？", "请核对后再保存", "请保留当前内容后重试", "待核对", "原表未提供"]) {
    assert.ok(detail.includes(text), text);
  }
  assert.match(detail, /review\.sourceType === "legacy_approved" \? <small>历史评价<\/small>/u);
  assert.match(detail, /\{review\.body\}/u);
  assert.match(discussion, /删除后讨论位置仍会保留，确认删除这条回复/u);
  assert.match(discussion, /这条回复已不可见，讨论位置仍被保留/u);
});

test("community deletion, blocking and reporting warnings are preserved", () => {
  assert.match(topic, /删除后正文无法恢复，讨论位置仍保留。确认删除主题？/u);
  assert.match(topic, /删除后正文不再显示，讨论位置仍保留。确认删除回复？/u);
  assert.match(topic, /互相看不到对方的社区内容，相关旧互动也会清理。确认屏蔽？/u);
  assert.match(hub, /互相看不到对方的社区内容。确认屏蔽？/u);
  assert.match(shared, /举报不会通知对方。审核员会看到你选择的原因和补充说明/u);
  assert.match(shared, /（至少 8 个字）/u);
  assert.match(shared, /账号已注销/u);
  assert.match(hub, /请尊重同学隐私。课程与校园信息如有变动，以学校官方通知为准/u);
});

test("private and unavailable community content retains its boundaries", () => {
  assert.match(saved, /只对你可见/u);
  assert.match(saved, /内容可能已删除、隐藏，或与当前屏蔽关系冲突。正文与作者信息不再展示/u);
  assert.match(saved, /原主题不会受到影响/u);
  assert.match(profile, /未公开、已删除或仅链接可见的内容不会出现在个人主页/u);
  assert.match(profile, /账号已停用、注销，或你们之间存在屏蔽关系/u);
  assert.match(topic, /仅链接可见/u);
  assert.match(hub, /仅通过链接访问/u);
  assert.match(topic, /这条回复因屏蔽关系不再显示/u);
  assert.match(topic, /这条回复已不可见，讨论位置仍被保留/u);
});

test("materials distinguish collection dates, missing files, denied access and unknown state", () => {
  assert.match(material, /收录时间不等同于原文件发布时间/u);
  assert.match(material, /资料由站长整理发布/u);
  assert.match(material, /以学校官方信息和文件内容为准/u);
  assert.match(availability, /response\.status === 403/u);
  assert.match(availability, /response\.status === 404 \|\| response\.status === 410/u);
  assert.match(availability, /文件暂时不可用/u);
  assert.match(availability, /文件访问受限/u);
  assert.match(availability, /文件当前不可公开访问，可能需要额外授权/u);
  assert.match(availability, /无法确认文件状态，仍可尝试打开/u);
  assert.match(missingMaterial, /这份资料不存在，或已经撤下/u);
  assert.match(missingMaterial, /返回资料搜索/u);
});

test("shorter copy keeps accessible labels, status announcements and keyboard help", () => {
  assert.match(shared, /aria-label="关闭通知"/u);
  assert.match(shared, /aria-label=\{`隐藏通知：/u);
  assert.match(shared, /aria-labelledby="community-report-title"/u);
  assert.match(topic, /aria-labelledby="edit-comment-title"/u);
  assert.match(topic, /<h2 id="edit-comment-title">修改回复/u);
  assert.match(hub, /aria-label="主题排序方式"/u);
  assert.match(saved, /aria-labelledby="saved-title"/u);
  assert.match(saved, /id="saved-title">收藏与屏蔽/u);
  assert.match(teachers, /aria-label="清空教师搜索"/u);
  assert.match(detail, /visuallyHidden\}>评价正文/u);
  assert.match(discussion, /visuallyHidden\}>回复正文/u);
  assert.match(materials, /↑↓ 浏览，Enter 打开，Esc 清空/u);
  for (const source of [hub, topic, shared, teachers, detail, materials]) {
    assert.match(source, /role="status"/u);
    assert.match(source, /role="alert"/u);
  }
});

test("edited TSX sources parse without syntax errors", () => {
  for (const [name, source] of Object.entries({ hub, topic, shared, profile, saved, teachers, detail, materials, material, availability, missingMaterial })) {
    const ast = ts.createSourceFile(`${name}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.deepEqual(ast.parseDiagnostics, [], name);
  }
});
