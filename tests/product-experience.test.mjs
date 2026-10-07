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
const redAccessStyles = await readFile(
  new URL("../app/red-access-system.css", import.meta.url),
  "utf8",
);
const globalStyles = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const courseCenterStyles = await readFile(
  new URL("../app/course-center.module.css", import.meta.url),
  "utf8",
);
const roomWeekSource = await readFile(
  new URL("../app/RoomWeekSchedule.tsx", import.meta.url),
  "utf8",
);
const roomWeekStyles = await readFile(
  new URL("../app/room-week-schedule.module.css", import.meta.url),
  "utf8",
);
const materialsSource = await readFile(
  new URL("../app/materials/MaterialsExplorer.tsx", import.meta.url),
  "utf8",
);
const materialsStyles = await readFile(
  new URL("../app/materials/materials.module.css", import.meta.url),
  "utf8",
);
const materialDetailSource = await readFile(
  new URL("../app/materials/[materialId]/page.tsx", import.meta.url),
  "utf8",
);
const publicMastheadSource = await readFile(
  new URL("../app/PublicMasthead.tsx", import.meta.url),
  "utf8",
);
const publicMastheadStyles = await readFile(
  new URL("../app/public-masthead.module.css", import.meta.url),
  "utf8",
);
const dialogBackdropSource = await readFile(
  new URL("../app/DialogBackdrop.tsx", import.meta.url),
  "utf8",
);
const dialogBackdropStyles = await readFile(
  new URL("../app/dialog-backdrop.module.css", import.meta.url),
  "utf8",
);
const formFieldSource = await readFile(
  new URL("../app/FormField.tsx", import.meta.url),
  "utf8",
);
const formFieldStyles = await readFile(
  new URL("../app/form-field.module.css", import.meta.url),
  "utf8",
);
const communityHubSource = await readFile(
  new URL("../app/community/CommunityHub.tsx", import.meta.url),
  "utf8",
);
const communitySource = await readFile(
  new URL("../app/community/CommunityShared.tsx", import.meta.url),
  "utf8",
);
const communityTopicSource = await readFile(
  new URL("../app/community/CommunityTopicView.tsx", import.meta.url),
  "utf8",
);
const communityProfileSource = await readFile(
  new URL("../app/community/CommunityProfileView.tsx", import.meta.url),
  "utf8",
);
const communityStyles = await readFile(
  new URL("../app/community/community.module.css", import.meta.url),
  "utf8",
);
const adminStyles = await readFile(
  new URL("../app/admin/admin.module.css", import.meta.url),
  "utf8",
);
const adminSource = await readFile(
  new URL("../app/admin/AdminConsole.tsx", import.meta.url),
  "utf8",
);
const moderationSource = await readFile(
  new URL("../app/admin/ModerationDesk.tsx", import.meta.url),
  "utf8",
);
const activeContentSource = await readFile(
  new URL("../app/admin/ActiveContentDesk.tsx", import.meta.url),
  "utf8",
);
const teacherReviewDeskSource = await readFile(
  new URL("../app/admin/TeacherReviewDesk.tsx", import.meta.url),
  "utf8",
);
const teacherExplorerSource = await readFile(
  new URL("../app/teachers/TeacherExplorer.tsx", import.meta.url),
  "utf8",
);
const teacherDetailSource = await readFile(
  new URL("../app/teachers/[teacherId]/TeacherDetail.tsx", import.meta.url),
  "utf8",
);
const teacherDiscussionSource = await readFile(
  new URL("../app/teachers/TeacherReviewDiscussion.tsx", import.meta.url),
  "utf8",
);
const teacherStyles = await readFile(
  new URL("../app/teachers/teachers.module.css", import.meta.url),
  "utf8",
);
const teacherRecordLinkSource = await readFile(
  new URL("../app/TeacherRecordLink.tsx", import.meta.url),
  "utf8",
);
const personalCourseContextSource = await readFile(
  new URL("../app/personal-course-context.ts", import.meta.url),
  "utf8",
);

test("teacher directory disambiguates identities without taking over the daily workspace", () => {
  assert.match(teacherExplorerSource, /同名教师请核对学院/);
  assert.match(teacherExplorerSource, /\/api\/teachers/);
  assert.match(teacherDetailSource, /sourceType === "legacy_approved" \? <small>历史评价<\/small> : <>\s*<b>\{review\.authorLabel\}<\/b>\s*<time dateTime=\{review\.publishedAt\}/);
  assert.doesNotMatch(teacherDetailSource, /学长学姐|站内公开于|writeReviewLink|<img\b/);
  assert.match(teacherDetailSource, /id="teacher-reviews-title" className=\{styles\.visuallyHidden\}/);
  assert.match(teacherDetailSource, /id="teacher-contribution-title" className=\{styles\.visuallyHidden\}/);
  assert.match(teacherDetailSource, /<h1>\{teacher\.displayName\}<\/h1>[\s\S]*teacher\.collegeName/);
  assert.match(teacherDetailSource, /<p className=\{styles\.reviewEntryBody\}>\{review\.body\}<\/p>/);
  assert.doesNotMatch(teacherDetailSource, /hidden=\{panel|setPanel\(/);
  assert.match(teacherDetailSource, /<details className=\{styles\.teachingDetails\}/);
  assert.match(teacherDetailSource, /book\.courseId === courseFilter/);
  assert.match(teacherDetailSource, /termLabel\(book\.termKey\)[\s\S]*book\.sectionNo[\s\S]*book\.edition/);
  assert.match(teacherDetailSource, /textbookTarget\.current\?\.scrollIntoView/);
  assert.match(teacherDetailSource, /\/my-review/);
  assert.match(teacherDetailSource, /<FormField className=\{styles\.compactField\} label=\{<span className=\{styles\.visuallyHidden\}>评价正文<\/span>\}/);
  assert.match(teacherDetailSource, /minLength=\{1\} maxLength=\{3000\}/);
  assert.match(teacherDetailSource, /if \(!draftBody\.normalize\("NFKC"\)\.trim\(\)\)/);
  assert.match(teacherDetailSource, /const payload: \{ body: string; expectedVersion\?: number \} = \{\s*body: draftBody,\s*\};/);
  assert.match(teacherDetailSource, /if \(ownReview\) payload\.expectedVersion = ownReview\.version/);
  assert.match(teacherDetailSource, /body: JSON\.stringify\(payload\)/);
  assert.doesNotMatch(teacherDetailSource, /\bratings\b|draftRatings|ratingLabels|<fieldset|type="radio"/);
  assert.match(teacherDetailSource, /"保存修改" : "发布"/);
  assert.match(teacherDetailSource, /accountStatus === "guest"[\s\S]*登录后写评价/);
  assert.match(teacherDetailSource, /accountStatus === "ready" && ownReview\?\.status !== "hidden" && \(!ownReview \|\| composerOpen\)/);
  assert.match(teacherDetailSource, /评价已隐藏，审核期间不可修改，仍可删除/);
  assert.match(teacherDetailSource, /confirmDelete &&[\s\S]*确认删除[\s\S]*setConfirmDelete\(false\)/);
  assert.match(teacherDetailSource, /method: "DELETE"[\s\S]*JSON\.stringify\(\{ version: ownReview\.version \}\)/);
  assert.equal((teacherDetailSource.match(/response\.status === 409/g) ?? []).length, 2, "Save and delete both handle stale versions");
  assert.match(teacherDetailSource, /<TeacherReviewDiscussion/);
  assert.doesNotMatch(teacherDetailSource, /role="search"|评价排序方式|styles\.reviewSort/);
  assert.match(teacherDetailSource, /\(reviewQuery \|\| reviewSort !== "latest"\) &&/);
  assert.match(teacherDetailSource, /onClick=\{clearReviewSearch\}>查看全部评价/);
  for (const key of ["reviewQuery", "reviewSort", "q", "sort"]) {
    assert.ok(teacherDetailSource.includes(`url.searchParams.delete("${key}")`));
  }
  assert.match(teacherDetailSource, /reviewQuery \? `没有找到包含/);
  assert.match(teacherDetailSource, /reviewQuery.*reviewSort/s);
  assert.match(teacherDetailSource, /discussionCount/);
  assert.match(teacherDetailSource, /if \(cursor\) query\.set\("after", cursor\)/);
  assert.match(teacherDetailSource, /!nextCursor \|\| reviewListStatus !== "ready" \|\| reviewMoreRequest\.current/);
  assert.match(teacherDetailSource, /controller\.signal\.aborted \|\| generation !== reviewGeneration\.current/);
  assert.match(teacherDetailSource, /payload\.items\.filter\(\(review\) => !knownIds\.has\(review\.id\)\)/);
  assert.match(teacherDetailSource, /reviewMoreRequest\.current\?\.abort\(\)/);
  assert.match(teacherDetailSource, /更多评价加载失败，已读内容仍保留/);
  assert.match(teacherDetailSource, /重新读取更多评价/);
  assert.match(teacherDiscussionSource, /aria-expanded={open}/);
  assert.match(teacherDiscussionSource, /aria-controls=\{open \? `teacher-review-thread-\$\{reviewId\}` : undefined\}/);
  assert.match(teacherDiscussionSource, /open \? "收起" : "回复"/);
  assert.doesNotMatch(teacherDiscussionSource, /展开讨论|收起讨论|参与讨论|可以从具体课堂体验继续讨论/);
  assert.match(teacherDiscussionSource, /className=\{styles\.visuallyHidden\}>回复正文<\/span>/);
  assert.match(teacherDiscussionSource, /aria-label="举报评价"/);
  assert.match(teacherDiscussionSource, /<ReportDialog target=\{reportTarget\}/);
  assert.match(teacherDiscussionSource, /comment\.status !== "published" \|\| !comment\.body/);
  assert.match(teacherDiscussionSource, /这条回复已不可见，讨论位置仍被保留/);
  assert.match(teacherDiscussionSource, /nextCursor &&[\s\S]*load\(nextCursor, true\)/);
  assert.match(teacherDiscussionSource, /if \(status === "idle"\) void loadInitial\(\)/);
  assert.doesNotMatch(teacherDiscussionSource, /controller\.abort\(\)/);
  assert.match(
    teacherDiscussionSource,
    /\.\.\.current\.filter\(\(item\) => !payload\.items\.some\(\(loaded\) => loaded\.id === item\.id\)\)/,
  );
  assert.match(teacherDiscussionSource, /teacher_review_comment/);
  assert.match(teacherDiscussionSource, /comment\.author\?\.id === currentUserId/);
  assert.match(component, /<TeacherRecordLink/);
  assert.match(teacherRecordLinkSource, /href=\{fallbackHref\}/);
  assert.match(teacherRecordLinkSource, /resolveTeacherScheduleHref/);
  assert.doesNotMatch(teacherRecordLinkSource, /useEffect/);
  assert.match(teacherStyles, /min-height:\s*44px/);
  assert.match(teacherStyles, /@media \(max-width:\s*900px\)/);
  assert.match(teacherStyles, /\.reviewActions button\s*\{[^}]*min-height:\s*44px/);
  assert.match(teacherStyles, /\.reviewFilterNotice button\s*\{[^}]*min-height:\s*44px/);
  assert.match(teacherStyles, /\.teachingDetails > summary\s*\{[^}]*min-height:\s*44px/);
  assert.match(teacherStyles, /\.reviewEntryBody\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(teacherStyles, /\.visuallyHidden\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  assert.doesNotMatch(teacherStyles, /\.ratingEditor\b|\.ratings\b|\.reviewIndex\b|\.reviewSort\b/);
});

test("teacher and material discovery use scoped course context without hiding schoolwide results", () => {
  assert.match(teacherExplorerSource, /loadPersonalCourseContext/);
  assert.match(teacherExplorerSource, /aria-label="本学期教师"/);
  assert.match(teacherExplorerSource, /同名教师请核对学院/);
  assert.match(materialsSource, /ranking === "personal"/);
  assert.match(materialsSource, /与我相关/);
  assert.match(materialsSource, /全站排序/);
  assert.match(materialsSource, /rankedItems\.map/);
  assert.match(materialsSource, /\/data\/resource-manifest\.json/);
  assert.match(materialsSource, /materialRelation\(material\) !== "other"/);
  assert.match(materialsSource, /\.slice\(0, items\.length\)/);
  assert.match(materialsSource, /params\.set\("offset"/);
  assert.match(materialsStyles, /\.rankSwitch button\[aria-pressed="true"\]/);
  assert.match(materialsStyles, /\.loadMore/);
  assert.match(personalCourseContextSource, /userPersonalScope\(session\.user\.id\)/);
  assert.match(personalCourseContextSource, /anonymousPersonalScope/);
  assert.doesNotMatch(personalCourseContextSource, /localStorage\.setItem/);
});

test("material pages label catalog time without presenting it as source publication time", () => {
  assert.match(materialsSource, /formatCatalogDate\(material\.catalogedAt\)/);
  assert.match(materialDetailSource, /站内收录/u);
  assert.match(materialDetailSource, /不等同于原文件发布时间/u);
});

test("administrator can review imported teacher comments through the elevated backend", () => {
  assert.match(adminSource, /<TeacherReviewDesk/);
  assert.match(teacherReviewDeskSource, /\/api\/admin\/teacher-reviews\/candidates/);
  assert.match(teacherReviewDeskSource, /\/decision/);
  assert.match(teacherReviewDeskSource, /decision, reason/);
  assert.match(teacherReviewDeskSource, /历史整理内容/);
  assert.match(teacherReviewDeskSource, /teacher_review_candidate_conflict/);
  assert.match(teacherReviewDeskSource, /admin_mfa_required/);
  assert.doesNotMatch(teacherReviewDeskSource, /dangerouslySetInnerHTML/);
});

test("administrator can actively review topics and replies through the audited case workflow", () => {
  assert.match(adminSource, /<ActiveContentDesk/);
  assert.match(activeContentSource, /\/api\/admin\/community\/content\?/);
  assert.match(activeContentSource, /\/api\/admin\/community\/content\/\$\{selected\.type\}\/\$\{selected\.id\}\/case/);
  assert.match(activeContentSource, /\/api\/admin\/community\/cases\/\$\{selected\.caseId\}\/actions/);
  assert.match(activeContentSource, /无需等待举报/u);
  assert.match(activeContentSource, /在公开页面核对上下文/u);
  assert.doesNotMatch(activeContentSource, /dangerouslySetInnerHTML/);
  assert.match(adminStyles, /\.contentFilters button[\s\S]*min-height:\s*44px/);
});

test("administrator account governance exposes trends, precise filters, and public-only records", () => {
  assert.match(adminSource, /registrationTrend:\s*Array<\{ date: string; count: number \}>/);
  assert.match(adminSource, /aria-label="最近 30 天新增用户趋势"/u);
  assert.match(adminSource, /\/api\/admin\/users\?\$\{userFilterSearch/);
  for (const field of ["query", "role", "status", "registeredFrom", "registeredTo"]) {
    assert.match(adminSource, new RegExp(`name="${field}"`));
  }
  assert.match(adminSource, /继续读取名册/u);
  assert.match(adminSource, /查看公开资料/u);
  assert.match(adminSource, /\/public-profile\?kind=\$\{kind\}&limit=10/);
  assert.match(adminSource, /aria-label="公开资料类型"/u);
  assert.match(adminSource, /aria-pressed=\{publicKind === "topics"\}/);
  assert.match(adminSource, /aria-pressed=\{publicKind === "comments"\}/);
  assert.match(adminSource, /useModalFocus<HTMLElement>/);
  assert.match(adminSource, /ref=\{profileDialogRef\}/);
  assert.match(adminSource, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="admin-public-profile-title"/);
  assert.match(adminSource, /aria-label="关闭公开资料"/u);
  assert.doesNotMatch(adminSource, /publicProfile\.(?:email|emailMasked|role|lastLoginAt)/);

  assert.match(adminStyles, /\.registrationTrend ol[\s\S]*grid-template-columns:\s*repeat\(30,/);
  assert.match(adminStyles, /\.userBook (?:input,\s*)?[\s\S]*?select[\s\S]*?min-height:\s*44px/);
  assert.match(adminStyles, /\.userBook form > button[\s\S]*?min-height:\s*44px/);
  assert.match(adminStyles, /\.publicProfileSheet > header button[\s\S]*?height:\s*44px[\s\S]*?width:\s*44px/);
  assert.match(adminStyles, /\.publicProfileSheet nav button[\s\S]*?min-height:\s*44px/);
  assert.match(adminStyles, /@media \(max-width:\s*720px\)[\s\S]*?\.userBook form \{[\s\S]*?grid-template-columns:\s*1fr 1fr/);
  assert.match(adminStyles, /@media \(max-width:\s*720px\)[\s\S]*?\.publicProfileSheet \{[\s\S]*?max-height:\s*92dvh/);
});

test("today page keeps the one-glance command deck", () => {
  assert.match(component, /today-command-deck/);
  assert.match(component, /todayAgenda[\s\S]*nextThree/);
  assert.doesNotMatch(component, /campusSuggestion|className="campus-suggestion"/);
  assert.match(productStyles, /\.now-card/);
  assert.match(productStyles, /\.agenda-glance/);
});

test("the daily workspace defers non-critical materials until idle or demand", () => {
  const shellStart = component.indexOf("export function DufeHubV2");
  const hubStart = component.indexOf("function HubApp");
  const homeStart = component.indexOf("function HomePage");
  const shellSource = component.slice(shellStart, hubStart);
  const hubSource = component.slice(hubStart, homeStart);

  assert.match(shellSource, /fetch\("\/data\/course-core\.json"\)/);
  assert.doesNotMatch(shellSource, /fetch\("\/data\/course-data\.json"\)/);
  assert.doesNotMatch(shellSource, /resource-manifest\.json/);
  assert.match(hubSource, /fetch\("\/data\/course-data\.json"\)/);
  assert.match(hubSource, /fullDataRequired/);
  assert.match(hubSource, /view === "catalog" \|\| view === "schedule" \|\| view === "rooms"/);
  assert.match(hubSource, /materialsRequestRef/);
  assert.match(hubSource, /requestIdleCallback/);
  assert.match(hubSource, /setTimeout\(\(\) => void loadMaterials\(\), 1200\)/);
  assert.match(hubSource, /commandOpen \|\| selectedCourse/);
  assert.match(hubSource, /fetch\("\/data\/resource-manifest\.json"\)/);
  assert.match(component, /资料清单没有加载成功。关闭课程后重新打开即可再试。/);

  assert.match(adminStyles, /\.gateForm input:focus-visible/);
  assert.match(communityStyles, /\.replyComposer textarea:focus-visible/);
  assert.match(materialsStyles, /\.searchField input:focus-visible/);
  assert.doesNotMatch(adminStyles, /\.gateForm input:focus(?!-visible)/);
  assert.doesNotMatch(communityStyles, /\.replyComposer textarea:focus(?!-visible)/);
  assert.doesNotMatch(materialsStyles, /\.searchField input:focus(?!-visible)/);
});

test("the active visual system shares one paper ink and cinnabar palette", () => {
  for (const token of ["paper", "ink", "red", "pine", "gold"]) {
    assert.match(globalStyles, new RegExp(`--dufe-${token}:`));
  }
  assert.match(productStyles, /--ds-accent: var\(--dufe-red\)/);
  assert.match(redAccessStyles, /--journal-red: var\(--dufe-red\)/);
  assert.match(materialsStyles, /--red: var\(--dufe-red\)/);
  assert.match(communityStyles, /--red: var\(--dufe-red\)/);
  assert.match(adminStyles, /--admin-red: var\(--dufe-red\)/);
  assert.doesNotMatch(globalStyles, /#426a9d/i);
});

test("primary workspaces render immediately without a whole-page reveal", () => {
  assert.doesNotMatch(redAccessStyles, /journal-reveal/);
  assert.doesNotMatch(redAccessStyles, /\.page-wrap\s*\{[^}]*animation:/s);
});

test("the course finder groups offerings once and bounds mounted cards", async () => {
  const source = component;

  assert.match(source, /const \[visibleWindow, setVisibleWindow\] = useState\(\{ key: "", limit: 40 \}\)/);
  assert.match(source, /const offeringsByCourse = useMemo\(\(\) => \{/);
  assert.match(source, /grouped\.set\(schedule\.courseId, \[schedule\]\)/);
  assert.match(source, /const courseOfferings = offeringsByCourse\.get\(course\.id\)/);
  assert.match(source, /visibleWindow\.key === finderKey \? visibleWindow\.limit : 40/);
  assert.match(source, /function resetFinderWindow\(\) \{[\s\S]*?setVisibleWindow\(\{ key: "", limit: 40 \}\)/);
  assert.match(source, /setVisibleWindow\(\{ key: finderKey, limit: visibleLimit \+ 40 \}\)/);
  assert.match(
    redAccessStyles,
    /body:has\(\.course-pool\.finder-pool\.open\) \.mobile-nav[\s\S]*?pointer-events: none;[\s\S]*?visibility: hidden;/,
  );
});

test("public workspaces share one accessible masthead primitive", () => {
  assert.match(publicMastheadSource, /navigationLabel/);
  assert.match(publicMastheadSource, /aria-current/);
  assert.match(publicMastheadSource, /data-mobile/);
  assert.match(publicMastheadSource, /aria-label="返回东财之影首页"/);
  assert.doesNotMatch(publicMastheadSource, /DUFE STUDENT DESK/);
  assert.match(publicMastheadStyles, /--dufe-red/);
  assert.match(publicMastheadStyles, /min-height: 44px/);

  for (const source of [materialsSource, materialDetailSource, communitySource]) {
    assert.match(source, /import \{ PublicMasthead \}/);
    assert.match(source, /<PublicMasthead/);
  }
  for (const styles of [materialsStyles, communityStyles]) {
    assert.doesNotMatch(styles, /\.siteHeader/);
    assert.doesNotMatch(styles, /\.wordmark/);
  }
});

test("community and admin dialogs share one dismissible responsive backdrop", () => {
  assert.match(dialogBackdropSource, /event\.target === event\.currentTarget/);
  assert.match(dialogBackdropSource, /dismissDisabled/);
  assert.match(dialogBackdropStyles, /env\(safe-area-inset-top\)/);
  assert.match(dialogBackdropStyles, /env\(safe-area-inset-bottom\)/);
  assert.match(dialogBackdropStyles, /@media \(max-width: 680px\)/);
  assert.match(dialogBackdropSource, /export function DialogActions/);
  assert.match(dialogBackdropStyles, /\.actions \{[\s\S]*background: transparent/);
  assert.match(dialogBackdropStyles, /\.actions \{[\s\S]*color: inherit/);
  assert.match(dialogBackdropStyles, /\.actions button[\s\S]*min-height: 44px/);
  assert.match(dialogBackdropStyles, /\.actions button:last-child[\s\S]*--dufe-red/);
  assert.match(dialogBackdropStyles, /\.actions button:disabled/);

  for (const source of [communitySource, communityTopicSource, adminSource, moderationSource]) {
    assert.match(source, /import \{[^}]*DialogBackdrop/);
    assert.match(source, /<DialogBackdrop/);
    assert.match(source, /DialogActions/);
  }
  assert.match(adminSource, /useModalFocus<HTMLFormElement>/);
  assert.match(adminSource, /ref=\{actionDialogRef\}/);
  assert.doesNotMatch(communityStyles, /\.modalBackdrop/);
  assert.doesNotMatch(communityStyles, /\.reportSheet > div button/);
  assert.doesNotMatch(adminStyles, /\.(?:modalBackdrop|moderationBackdrop)/);
  assert.doesNotMatch(adminStyles, /\.(?:actionSheet|caseSheet) (?:button|> footer)/);
});

test("an open moderation case always resets to a server-allowed next action", () => {
  assert.match(moderationSource, /const updated = reviewing\?\.find/);
  assert.match(
    moderationSource,
    /if \(updated\) setAction\(updated\.allowedActions\[0\] \?\? "warn"\)/,
  );
});

test("editorial forms share one paper-and-ink field primitive", () => {
  assert.match(formFieldSource, /labelRow/);
  assert.match(formFieldSource, /counter/);
  assert.match(formFieldSource, /variant === "display"/);
  assert.match(formFieldStyles, /min-height:\s*44px/);
  assert.match(formFieldStyles, /:focus-visible/);
  assert.match(formFieldStyles, /--dufe-red/);
  assert.match(formFieldStyles, /prefers-reduced-motion:\s*reduce/);

  for (const source of [component, communityHubSource, communitySource, communityTopicSource, teacherDetailSource, materialsSource, adminSource, moderationSource]) {
    assert.match(source, /import \{ FormField \}/);
    assert.match(source, /<FormField/);
  }
  assert.doesNotMatch(communityStyles, /\.composer input:focus/);
  assert.doesNotMatch(teacherStyles, /\.reviewBodyField/);
  assert.doesNotMatch(materialsStyles, /\.filters select/);
  assert.doesNotMatch(adminStyles, /\.actionSheet textarea:focus/);
  assert.doesNotMatch(adminStyles, /\.caseSheet textarea:focus/);
  assert.doesNotMatch(redAccessStyles, /\.credential-gateway input:focus/);
  assert.doesNotMatch(redAccessStyles, /\.account-profile input:focus/);
  assert.match(component, /className="credential-field"/);
  assert.match(component, /className="profile-field"/);
  assert.match(component, /className="verification-field"/);
});

test("personal activities default to cinnabar while legacy blue renders as charcoal", () => {
  assert.match(component, /activity\?\.color \?\? "red"/);
  assert.match(component, /blue: "炭墨"/);
  assert.match(globalStyles, /\.event-colors button::before[\s\S]*background: #4c4842/);
  assert.match(globalStyles, /\.event-colors button[\s\S]*height: 44px[\s\S]*width: 44px/);
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
  assert.doesNotMatch(meSource, /campus-lab-entry|小影内测/);
  assert.match(component, /web\.traceint\.com\/web\/index\.html/);
  assert.match(component, /person_card\/index\?sessionid=/);
  assert.match(component, /ginkgostu\.dufe\.edu\.cn\/notice\/system/);
});

test("the daily workspace stays functional while campus photographs live in My", () => {
  const homeStart = component.indexOf("function HomePage");
  const catalogStart = component.indexOf("function CatalogPage");
  const meStart = component.indexOf("function MePage");
  const searchStart = component.indexOf("function SearchCommand");
  const homeSource = component.slice(homeStart, catalogStart);
  const meSource = component.slice(meStart, searchStart);

  assert.match(component, /dufe-tree-avenue-day\.webp/);
  assert.match(component, /dufe-tree-avenue-night\.webp/);
  assert.match(component, /dufe-winter-pavilion\.webp/);
  assert.match(component, /dufesh-creators\.webp/);
  assert.match(component, /function CampusAlmanac/);
  assert.match(component, /function CreatorsCorner/);
  assert.match(homeSource, /CampusTimeMark/);
  assert.doesNotMatch(homeSource, /CampusAlmanac/);
  assert.doesNotMatch(homeSource, /KnowledgeTribute/);
  assert.match(meSource, /CampusAlmanac/);
  assert.match(meSource, /KnowledgeTribute/);
  assert.match(redAccessStyles, /\.campus-time-mark/);
  assert.match(redAccessStyles, /@keyframes photo-reveal/);
  assert.match(redAccessStyles, /\.campus-almanac/);
  assert.doesNotMatch(component, /<i>0[123]<\/i>/);
});

test("community stays outside primary navigation and uses a quiet today-page exit", () => {
  const homeStart = component.indexOf("function HomePage");
  const catalogStart = component.indexOf("function CatalogPage");
  const meStart = component.indexOf("function MePage");
  const searchStart = component.indexOf("function SearchCommand");
  const homeSource = component.slice(homeStart, catalogStart);
  const meSource = component.slice(meStart, searchStart);

  assert.match(homeSource, /today-community-note/);
  assert.match(homeSource, /课间有空再看/u);
  assert.match(meSource, /community-corridor-entry/);
  assert.match(meSource, /href="\/community"/);
  assert.match(productStyles, /\.community-corridor-entry/);
  assert.match(productStyles, /\.today-community-note/);
  assert.doesNotMatch(component, /id: "community"/);
});

test("signed-in users can manage private community bookmarks and blocks away from Today", async () => {
  const savedSource = await readFile(
    new URL("../app/community/saved/CommunitySavedView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(savedSource, /\/api\/community\/me\/bookmarks/);
  assert.match(savedSource, /\/api\/community\/me\/blocks/);
  assert.match(savedSource, /"移出收藏"/u);
  assert.match(savedSource, /"解除屏蔽"/u);
  assert.match(component, /community-personal-entry/);
  assert.match(productStyles, /\.community-personal-entry/);
  assert.doesNotMatch(savedSource, /localStorage/);
});

test("discussion threads can be folded without deleting or reclassifying content", () => {
  assert.match(communityTopicSource, /collapsedThreadIds/);
  assert.match(communityTopicSource, /aria-expanded="false"/);
  assert.match(communityTopicSource, /aria-controls={`community-thread-\${root\.id}`}/);
  assert.match(communityTopicSource, />收起本章</u);
  assert.match(communityTopicSource, /展开本章/);
  assert.match(communityStyles, /\.threadContent\[hidden\]/);
  assert.doesNotMatch(communityTopicSource, /localStorage/);
});

test("community topics share through the system sheet with a copy fallback", () => {
  assert.match(communityTopicSource, /navigator\.share/);
  assert.match(communityTopicSource, /navigator\.clipboard\.writeText/);
  assert.match(communityTopicSource, /document\.execCommand\("copy"\)/);
  assert.match(communityTopicSource, />分享链接<\/button>/u);
});

test("community authors lead to privacy-bounded public activity profiles", () => {
  assert.match(communitySource, /href={`\/community\/users\/\${author\.id}`}/);
  assert.match(communityProfileSource, /kind=\${requestedKind}&limit=20/);
  assert.match(communityProfileSource, /公开主题/);
  assert.match(communityProfileSource, /公开回复/);
  assert.match(communityProfileSource, /私人资料不会在这里显示/);
  assert.match(communityStyles, /\.profileTabs button\[aria-pressed="true"\]/);
  assert.match(communityStyles, /@media \(max-width: 680px\)[\s\S]*?\.profileRecords li/);
});

test("community exposes real latest and snapshot-bounded hot sorting", () => {
  const selectSortSource = communityHubSource.slice(
    communityHubSource.indexOf("function selectSort"),
    communityHubSource.indexOf("const openNotifications"),
  );
  assert.match(communityHubSource, /type FeedSort = "latest" \| "hot"/);
  assert.match(communityHubSource, /sort=\${requestedSort}&limit=20/);
  assert.match(communityHubSource, /aria-label="主题排序方式"/);
  assert.match(communityHubSource, /aria-pressed={sort === "hot"}/);
  assert.match(communityHubSource, /热议综合赞同、回复与近两周的发布时间排序/);
  assert.ok(
    selectSortSource.indexOf("setSort(nextSort)") <
      selectSortSource.indexOf("void loadTopics(nextSort)"),
  );
  assert.match(communityStyles, /\.feedSort button\[aria-pressed="true"\]/);
  assert.match(
    communityStyles,
    /@media \(max-width: 680px\)[\s\S]*?\.feedSort button \{ min-height: 44px;/,
  );
});

test("personal page explains local data, cloud sync, devices, and account control", () => {
  const meStart = component.indexOf("function MePage");
  const searchStart = component.indexOf("function SearchCommand");
  const meSource = component.slice(meStart, searchStart);

  assert.match(meSource, /账号与同步/);
  assert.match(meSource, /创建账号/);
  assert.match(meSource, /用户名或邮箱/);
  assert.match(meSource, /微信登录暂未开放/);
  assert.match(meSource, /账号资料/);
  assert.match(meSource, /更换头像/);
  assert.match(meSource, /原图与定位信息没有保留/);
  assert.match(meSource, /未验证，不作为学生身份凭据/);
  assert.match(meSource, /保留本机修改/);
  assert.match(meSource, /使用云端版本/);
  assert.match(meSource, /登录设备/);
  assert.match(meSource, /退出登录/);
  assert.match(meSource, /确认注销/);
  assert.match(meSource, /是否把这些课表、日程和作业导入当前账号/);
  assert.match(meSource, /导入当前账号/);
  assert.match(component, /userPersonalScope/);
});

test("retired homepage and room containers leave no dead cascade layers", () => {
  assert.doesNotMatch(component, /campus-window|room-stack|academic-sync-band|archive-sections|campus-lab-entry/);

  for (const styles of [productStyles, redAccessStyles, globalStyles]) {
    assert.doesNotMatch(styles, /\.campus-window|\.room-stack|\.academic-sync-band|\.archive-sections|\.campus-lab-entry/);
  }

  assert.doesNotMatch(globalStyles, /(?:^|\n)\s*footer\s*\{/);
  assert.match(globalStyles, /:where\(\.site-shell > footer\)/);
  assert.match(globalStyles, /\.onboarding > footer span \{\s*color: var\(--dufe-muted, #655f58\);/);
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

test("mobile timetable defaults to the compact week and preserves occupied weekends and export", () => {
  assert.match(component, /mobileScheduleView/);
  assert.match(component, /useState<\s*"agenda" \| "week"\s*>\("week"\)/);
  assert.match(component, />\s*一周\s*<\/button>/);
  assert.match(component, /visibleWeekdays/);
  assert.match(component, /showFullWeek/);
  assert.match(component, /mobile-schedule-agenda/);
  assert.match(component, /week-overview-scroll/);
  assert.match(component, /export-canvas/);
  assert.match(productStyles, /week-overview-scroll\.mobile-active \.week-grid[\s\S]*?min-width: 0/);
  assert.match(productStyles, /\.timetable-panel\.export-canvas \.week-grid/);
});

test("room finder opens on the building map and keeps recommendations optional", () => {
  assert.match(component, /RoomStartMode/);
  assert.match(component, /RoomDuration/);
  assert.match(component, /<details className="room-tools">/);
  assert.ok(component.indexOf("building-tabs") < component.indexOf("room-tools"));
  assert.match(component, /换时间 · 找连续空闲/);
  assert.doesNotMatch(component, /离你更近，也空得更久/);
  assert.match(component, /targetBlocks/);
  assert.match(component, /roomIsAvailable/);
  assert.match(component, /availableUntil/);
  assert.match(component, /favoriteRooms/);
  assert.match(component, /recentRooms/);
  assert.match(productStyles, /\.room-recommendations/);
  assert.match(productStyles, /\.room-intents/);
  assert.match(productStyles, /\.room-tools/);
});

test("a room opens directly into one complete weekly timetable", () => {
  assert.match(component, /if \(selectedRoomInfo\)[\s\S]*?<RoomWeekSchedule/);
  assert.doesNotMatch(component, /查看这一周的课表/);
  assert.match(roomWeekSource, /role="table"/);
  assert.match(roomWeekSource, /periods\.map/);
  assert.doesNotMatch(roomWeekSource, /showWholeWeek|activeDay/);
  assert.match(roomWeekStyles, /overflow-x: auto/);
});

test("customer-facing copy does not expose planning notes", () => {
  const publicCopy = [
    component,
    materialsSource,
    teacherExplorerSource,
    communityHubSource,
    communityTopicSource,
  ].join("\n");
  assert.doesNotMatch(component, /需要操作的内容，放在信息之后/);
  assert.doesNotMatch(component, /这个搜索词会作为后续补充别名的依据/);
  assert.doesNotMatch(component, /常用入口留在学习流的下方/);
  assert.doesNotMatch(component, /课程、教室与资料关系正在抵达/);
  assert.doesNotMatch(component, /生产邮件服务尚未配置|本地开发模式|资质审核中|2024—∞|会一直有人管/);
  assert.doesNotMatch(materialsSource, /就在这里结束搜索|不再绕进选课流程/);
  assert.doesNotMatch(materialsSource, /autoFocus/);
  assert.doesNotMatch(
    publicCopy,
    /把今天留给自己的安排|眼下没有要紧的事|正好适合你|优先看看这三间|正在翻检档案|真正想问的问题/,
  );
});

test("course center keeps personal courses, school catalog, teachers, and materials distinct", () => {
  assert.match(component, /id: "catalog", label: "课程"/);
  assert.match(component, /aria-label="课程、教师与资料"/);
  assert.match(component, /mine: "我的课程", catalog: "课程库", teachers: "教师评价", materials: "学习资料"/);
  assert.match(component, /role="tablist"/);
  assert.match(component, /role="tabpanel"/);
  assert.match(component, /<WorkspaceTeachers[\s\S]*?embedded/);
  assert.match(component, /<WorkspaceMaterials[\s\S]*?embedded/);
  assert.match(component, /aria-label="教务数据状态"/);
  assert.match(courseCenterStyles, /\.objectNav/);
  assert.match(courseCenterStyles, /\.courseRows/);
});

test("global teacher search opens the disambiguating teacher directory", () => {
  assert.match(component, /window\.location\.assign\(`\/teachers\?q=\$\{encodeURIComponent\(item\.teacher\)\}`\)/);
  assert.match(component, /查看教师档案、教学班与评价/);
  assert.doesNotMatch(component, /setCoursePoolQuery\(item\.teacher\);\s*go\("schedule"\)/);
});

test("an empty teacher catalog does not pretend reviews are usable", () => {
  assert.match(teacherExplorerSource, /暂无教师档案，暂时无法评价/);
  assert.match(teacherExplorerSource, /同名记录不会自动合并/);
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
  assert.match(privacy, /统一转换为 WebP/);
  assert.match(privacy, /不会保存上传原图和 EXIF/);
  assert.match(privacy, /邮箱、校园账号、课表、日程、作业、收藏和登录信息不会进入该档案/);
});
