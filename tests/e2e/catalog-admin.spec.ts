import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { zipSync, strToU8 } from "fflate";
import { readFile } from "node:fs/promises";
import { CATALOG_COLUMNS, writeCatalogCsv } from "../../services/auth-api/src/catalog/import-contract.mjs";

const baseline = "a".repeat(64);
const publishedVersion = "b".repeat(64);
const uploadedFileId = "66666666-6666-4666-8666-666666666666";
const pendingUrl = `/resources/files/uploads/${uploadedFileId}.pdf`;
const courses = [
  { id: "11160113", title: "中国近现代史纲要", college: "马克思主义学院", credits: "3.00" },
  { id: "11160114", title: "中国近现代史纲要", college: "马克思主义学院", credits: "3.00" },
];
const existingMaterial = { id: "0123456789abcdef0123", name: "现有课件", courseIds: ["11160113"], category: "课件", downloadUrl: "https://example.test/existing.pdf", description: "第一章" };
const materialRow = { 操作: "更新", 资料编号: "0123456789abcdefabcd", 标题: "期末复习", 课程号: "11160114", 分类: "题库", 链接: "https://example.test/review.pdf", 描述: "期末使用" };

async function setup(page: Page, options: { warnings?: string[]; conflict?: boolean; uploadsEnabled?: boolean; invalid?: boolean; expired?: boolean; duplicateMaterial?: boolean; publishError?: { status: number; code: string } } = {}) {
  let revision = 1;
  let publicationCount = 0;
  let previewCount = 0;
  let snapshotReads = 0;
  const drafts: { kind: string; rows: Record<string, string>[]; expectedRevision: number; sourceName: string }[] = [];
  const fileRequests: { contentType: string; name: string; bytes: Buffer | null }[] = [];
  const rollbacks: Record<string, unknown>[] = [];
  const discarded: string[] = [];
  const now = new Date().toISOString();
  await page.route("**/test-catalog/**", async (route) => {
    snapshotReads += 1;
    await route.fulfill({ json: route.request().url().includes("courses") ? { courses, schedules: [] } : { materials: options.duplicateMaterial ? [existingMaterial, { ...existingMaterial, courseIds: ["11160114"] }] : [existingMaterial] } });
  });
  await page.route("**/api/admin/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let payload: unknown = { items: [], reports: [], announcements: [], candidates: [], events: [], nextCursor: null };
    if (path.endsWith("/session")) payload = { role: "admin", mfaConfigured: true, elevated: true, elevatedUntil: new Date(Date.now() + 600_000).toISOString() };
    if (path.endsWith("/overview")) payload = { overview: { totalUsers: 0, activeUsers: 0, disabledUsers: 0, administrators: 1, verifiedEmails: 0, registrationTrend: [] } };
    if (path.endsWith("/users")) payload = { users: [], nextCursor: null };
    if (path === "/api/admin/catalog") payload = { current: { courses: { revision, version: revision > 1 ? publishedVersion : baseline, fullUrl: "/test-catalog/courses.json", coreUrl: "/test-catalog/courses.json" }, materials: { revision, version: revision > 1 ? publishedVersion : baseline, url: "/test-catalog/materials.json" } }, history: revision > 1 ? [{ kind: "materials", revision, version: publishedVersion, createdAt: now, sourceName: "后台资料编辑", summary: { added: 2, updated: 0, removed: 0, unchanged: 1 } }] : [], baselineVersions: { courses: baseline, materials: baseline }, drafts: [], uploadsEnabled: options.uploadsEnabled ?? true };
    if (path.endsWith("/catalog/drafts")) {
      previewCount += 1;
      const body = route.request().postDataJSON(); drafts.push(body);
      if (options.invalid) { await route.fulfill({ status: 400, json: { error: "invalid_catalog_import", errors: [{ row: 2, field: "课程号", message: "关联课程不存在，请核对课程号" }] } }); return; }
      payload = { draft: { id: "draft-test", kind: body.kind, baseRevision: revision, expiresAt: new Date(Date.now() + (options.expired ? -1000 : 1_200_000)).toISOString(), warnings: options.warnings ?? [], summary: { added: body.rows.length, updated: 0, removed: 0, unchanged: 1 }, changes: body.rows.map((row: Record<string, string>, index: number) => ({ id: row.资料编号 || row.时段编号 || `course:${row.课程号}:${index}`, label: row.标题 || row.课程名称, action: "added", before: null, after: row })) } };
    }
    if (path.endsWith("/publish")) {
      expect(route.request().postDataJSON().reason.trim().length).toBeGreaterThanOrEqual(8);
      if (options.publishError) { await route.fulfill({ status: options.publishError.status, json: { error: options.publishError.code } }); return; }
      if (options.conflict && publicationCount === 0) { revision = 2; publicationCount += 1; await route.fulfill({ status: 409, json: { error: "catalog_revision_conflict" } }); return; }
      revision += 1; publicationCount += 1; payload = { success: true };
    }
    if (path.endsWith("/catalog/files")) {
      fileRequests.push({ contentType: route.request().headers()["content-type"], name: route.request().headers()["x-file-name"], bytes: route.request().postDataBuffer() });
      payload = { file: { id: uploadedFileId, url: pendingUrl, name: "review.pdf", sizeBytes: 32 } };
    }
    if (path.endsWith("/catalog/rollback")) { rollbacks.push(route.request().postDataJSON()); revision += 1; payload = { success: true }; }
    if (route.request().method() === "DELETE" && path.includes("/catalog/drafts/")) { discarded.push(path.split("/").at(-1)!); payload = { discarded: true }; }
    await route.fulfill({ json: payload });
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "课程与资料", exact: true })).toBeVisible();
  await expect(page.getByLabel("上传课程与教学班表格")).toBeEnabled();
  return { drafts, fileRequests, rollbacks, discarded, get previews() { return previewCount; }, get publications() { return publicationCount; }, get snapshotReads() { return snapshotReads; } };
}

async function verifyPage(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
}

async function openMaterials(page: Page) {
  await page.getByRole("navigation", { name: "目录类型" }).getByRole("button", { name: "学习资料" }).click();
  await expect(page.getByLabel("关联课程（按课程号选择）").getByRole("option", { name: "11160114 · 中国近现代史纲要" })).toBeAttached();
}

async function openExistingMaterials(page: Page) {
  await page.getByText("查找并编辑已有资料", { exact: true }).click();
}

async function openMaterialSpreadsheet(page: Page) {
  await page.getByRole("navigation", { name: "资料编辑方式" }).getByRole("button", { name: "上传表格", exact: true }).click();
  await expect(page.getByLabel("上传学习资料表格")).toBeVisible();
}

async function addLink(page: Page, title = "链接复习资料") {
  await page.getByLabel("资料标题", { exact: true }).fill(title);
  await page.getByLabel("关联课程（按课程号选择）").selectOption("11160114");
  await page.getByLabel("资料链接", { exact: true }).fill("https://example.test/review.pdf");
  await page.getByRole("button", { name: "加入本批", exact: true }).click();
}

test("course spreadsheet requires a reviewed preview, acknowledgement and reason before publication", async ({ page }) => {
  const state = await setup(page, { warnings: ["本批将修改课程信息，请核对课程号。"] });
  const row = { ...Object.fromEntries(CATALOG_COLUMNS.courses.map((column) => [column, ""])), 操作: "更新", 课程号: "11160113", 课程名称: "中国近现代史纲要", 学期: "fall", 教学班编号: "fall-11160113-01", 课序号: "01", 教师: "示例教师", 主修班级: "会计一班", 时段编号: "fall-11160113-01-1", 星期: "1", 节次: "1-2", 周次: "1-9周", 地点: "之远楼101" };
  await page.getByLabel("上传课程与教学班表格").setInputFiles({ name: "课程.csv", mimeType: "text/csv", buffer: Buffer.from(writeCatalogCsv([row, { ...row, 时段编号: "fall-11160113-01-2", 周次: "9-18周" }], CATALOG_COLUMNS.courses)) });
  expect(state.publications).toBe(0);
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  await expect(page.getByRole("heading", { name: /核对变化/ })).toBeFocused();
  expect(state.drafts[0].rows.map((item) => item.周次)).toEqual(["1-9周", "9-18周"]);
  const publish = page.getByRole("button", { name: "确认发布到网站" });
  await expect(publish).toBeDisabled();
  await page.getByLabel("发布说明（至少 8 个字）").fill("补充秋季课程并核对上课周次");
  await expect(publish).toBeDisabled();
  await page.getByLabel("我已核对以上提醒，确认继续发布").check();
  await verifyPage(page);
  await publish.click();
  await expect(page.getByRole("status")).toContainText("课程与教学班已发布");
  expect(state.publications).toBe(1);
  await expect(page.getByRole("button", { name: "校验并生成预览" })).toBeDisabled();
});

for (const width of [320, 390, 1280]) {
  test(`materials file and link enter one explicit publication batch at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const state = await setup(page);
    await openMaterials(page);
    const prepare = await page.getByRole("heading", { name: /准备学习资料/ }).boundingBox();
    const validate = await page.getByRole("heading", { name: /校验本批/ }).boundingBox();
    expect(prepare).not.toBeNull(); expect(validate).not.toBeNull();
    if (width === 1280) expect(validate!.x).toBeGreaterThan(prepare!.x + prepare!.width);
    else expect(validate!.y).toBeGreaterThan(prepare!.y);
    await verifyPage(page);
    await addLink(page);
    await page.getByLabel("资料标题", { exact: true }).fill("上传复习文件");
    await page.getByLabel("关联课程（按课程号选择）").selectOption("11160113");
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    await page.getByLabel("资料文件（最多 25 MiB）").setInputFiles({ name: "复习.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
    await expect(page.getByText("待发布文件 · review.pdf")).toBeVisible();
    expect(state.fileRequests[0].contentType).toBe("application/octet-stream");
    expect(state.fileRequests[0].name).toBe(encodeURIComponent("复习.pdf"));
    expect(state.fileRequests[0].bytes?.toString()).toContain("%PDF-1.4");
    expect(state.publications).toBe(0);
    await page.getByRole("button", { name: "加入本批", exact: true }).click();
    await expect(page.getByLabel("资料文件（最多 25 MiB）")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "资料来源" }).getByRole("button", { name: "填写链接", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "校验并生成预览" }).click();
    await expect(page.getByRole("button", { name: "确认发布到网站" })).toBeDisabled();
    expect(state.drafts[0].rows).toHaveLength(2);
    expect(state.drafts[0].rows[0].课程号).toBe("11160114");
    expect(state.drafts[0].rows[1].链接).toBe(pendingUrl);
    expect(state.drafts[0].rows.every((row) => /^[a-f0-9]{20}$/.test(row.资料编号))).toBe(true);
    await page.getByLabel("发布说明（至少 8 个字）").fill("补充期末复习文件与外部学习链接");
    expect(state.snapshotReads).toBe(2);
    await page.getByRole("region", { name: /核对变化/ }).locator("summary").filter({ hasText: "上传复习文件" }).click();
    const previewFields = page.getByLabel("发布后的记录字段").filter({ hasText: "上传复习文件" });
    await expect(previewFields.getByText("课程号", { exact: true })).toBeVisible();
    await expect(previewFields.getByText("链接", { exact: true })).toBeVisible();
    await expect(previewFields.locator("pre")).toHaveCount(0);
    await verifyPage(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`catalog-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "确认发布到网站" }).click();
    await expect(page.getByRole("status")).toContainText("学习资料已发布");
    expect(state.publications).toBe(1);
    await page.getByText("发布记录与恢复版本", { exact: true }).click();
    await page.getByRole("button", { name: "恢复此版本", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认恢复学习资料" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "确认恢复此版本" })).toBeDisabled();
    await verifyPage(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(state.rollbacks).toHaveLength(0);
    await expect(page.getByRole("button", { name: "恢复此版本", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "恢复此版本", exact: true }).click();
    await page.getByLabel("恢复原因（至少 8 个字）").fill("核对后恢复上一批学习资料目录");
    await dialog.getByRole("button", { name: "确认恢复此版本" }).click();
    await expect(page.getByRole("status")).toContainText("学习资料已恢复到所选版本");
    expect(state.rollbacks[0]).toMatchObject({ kind: "materials", expectedRevision: 2, targetVersion: baseline });
    expect(errors).toEqual([]);
  });
}

test("a conflicting publish stops success, refreshes the revision and requires another preview", async ({ page }) => {
  const state = await setup(page, { conflict: true }); await openMaterials(page); await addLink(page);
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  await page.getByLabel("发布说明（至少 8 个字）").fill("补充课程资料并核对外部链接");
  await page.getByRole("button", { name: "确认发布到网站" }).click();
  await expect(page.getByRole("status")).toContainText("已停止发布");
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toHaveCount(0);
  await expect(page.getByText("学习资料已发布", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toBeVisible();
  expect(state.drafts[1].expectedRevision).toBe(2);
  await expect(page.getByLabel("发布说明（至少 8 个字）")).toHaveValue("");
});

for (const scenario of [
  { status: 503, code: "service_unavailable", message: "服务暂时不可用，请稍后重试。" },
  { status: 409, code: "catalog_retention_limit", message: "保留版本已达到存储上限" },
  { status: 409, code: "catalog_dangling_material_reference", message: "这个课程版本与现有资料的课程关联不一致" },
]) {
  test(`publication reports ${scenario.code} without discarding a valid preview`, async ({ page }) => {
    const state = await setup(page, { publishError: scenario }); await openMaterials(page); await addLink(page);
    await page.getByRole("button", { name: "校验并生成预览" }).click();
    await page.getByLabel("发布说明（至少 8 个字）").fill("补充课程资料并核对外部链接");
    await page.getByRole("button", { name: "确认发布到网站" }).click();
    await expect(page.getByRole("status")).toContainText(scenario.message);
    await expect(page.getByRole("button", { name: "确认发布到网站" })).toBeVisible();
    await expect(page.getByRole("status")).not.toContainText("文件上传尚未启用");
    expect(state.publications).toBe(0);
  });
}

test("existing material editing keeps its ID and displays precise server validation errors", async ({ page }) => {
  const state = await setup(page, { invalid: true }); await openMaterials(page);
  await openExistingMaterials(page);
  await page.getByLabel("选择要修改的资料").selectOption(existingMaterial.id);
  await expect(page.getByLabel("资料编号", { exact: true })).toHaveValue(existingMaterial.id);
  await expect(page.getByLabel("资料链接", { exact: true })).toHaveValue(existingMaterial.downloadUrl);
  await page.getByLabel("资料标题", { exact: true }).fill("修正后的标题");
  await page.getByRole("button", { name: "加入本批", exact: true }).click();
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  await expect(page.getByText("第 2 行 · 课程号", { exact: true })).toBeVisible();
  await expect(page.getByText("关联课程不存在，请核对课程号", { exact: true })).toBeVisible();
  expect(state.drafts[0].rows[0].资料编号).toBe(existingMaterial.id);
  expect(state.publications).toBe(0);
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toHaveCount(0);
});

test("editing a legacy shared material preserves all courses associated with its stable ID", async ({ page }) => {
  const state = await setup(page, { duplicateMaterial: true }); await openMaterials(page);
  await openExistingMaterials(page);
  await expect(page.getByLabel("选择要修改的资料").locator(`option[value='${existingMaterial.id}']`)).toHaveCount(1);
  await page.getByLabel("选择要修改的资料").selectOption(existingMaterial.id);
  await expect(page.getByLabel("关联课程（按课程号选择）")).toHaveValue("__multiple");
  await page.getByLabel("资料标题", { exact: true }).fill("保留共同课程的修正版课件");
  await page.getByRole("button", { name: "加入本批", exact: true }).click();
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toBeVisible();
  expect(state.drafts[0].rows[0].课程号).toBe("11160113;11160114");
  expect(state.drafts[0].rows[0].资料编号).toBe(existingMaterial.id);
});

test("expired previews cannot publish and disabled file storage still allows links", async ({ page }) => {
  const state = await setup(page, { expired: true, uploadsEnabled: false }); await openMaterials(page);
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  await expect(page.getByLabel("资料文件（最多 25 MiB）")).toBeDisabled();
  await expect(page.getByText("文件上传未启用：服务器尚未配置资料存储目录。当前可填写 HTTPS 链接。")).toBeVisible();
  await page.getByRole("button", { name: "填写链接", exact: true }).click();
  await addLink(page); await page.getByRole("button", { name: "校验并生成预览" }).click();
  await expect(page.getByText("预览已过期，请重新校验。", { exact: true })).toBeVisible();
  await page.getByLabel("发布说明（至少 8 个字）").fill("补充课程资料并核对外部链接");
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toBeDisabled();
  expect(state.publications).toBe(0);
});

test("templates export literal stable IDs and invalid spreadsheets never reach the draft API", async ({ page }) => {
  const state = await setup(page); await openMaterials(page);
  const templatePromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载空白模板" }).click();
  const template = await templatePromise;
  const templateContents = await readFile((await template.path())!, "utf8");
  expect(templateContents).toBe(writeCatalogCsv([], CATALOG_COLUMNS.materials));
  const exportPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前目录" }).click();
  const exported = await exportPromise;
  expect(await readFile((await exported.path())!, "utf8")).toContain(existingMaterial.id);
  await openMaterialSpreadsheet(page);
  await page.getByLabel("上传学习资料表格").setInputFiles({ name: "错误表头.csv", mimeType: "text/csv", buffer: Buffer.from("课程名称,链接\r\n示例,https://example.test/a.pdf") });
  await expect(page.getByRole("alert")).toContainText("请按行号修正表格");
  await expect(page.getByRole("button", { name: "校验并生成预览" })).toBeDisabled();
  await page.getByLabel("上传学习资料表格").setInputFiles({ name: "过大表格.csv", mimeType: "text/csv", buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 32) });
  await expect(page.getByRole("status")).toContainText("表格不能超过 8 MiB");
  expect(state.previews).toBe(0);
});

test("discarding a preview frees it without losing the editable batch", async ({ page }) => {
  const state = await setup(page); await openMaterials(page); await addLink(page);
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  await page.getByText("未发布预览 · 1 份", { exact: true }).click();
  await page.getByRole("button", { name: /丢弃预览/ }).click();
  await expect(page.getByRole("status")).toContainText("预览已丢弃");
  expect(state.discarded).toEqual(["draft-test"]);
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toHaveCount(0);
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toBeVisible();
  expect(state.drafts[1].rows).toEqual(state.drafts[0].rows);
});

function workbook(sheets: { name: string; rows: string[][]; formula?: boolean }[]) {
  const xmlEscape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'),
    "xl/workbook.xml": strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`),
    "xl/styles.xml": strToU8('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>'),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr">${sheet.formula && rowIndex === 1 && columnIndex === 2 ? "<f>1+1</f><v>2</v>" : `<is><t>${xmlEscape(value)}</t></is>`}</c>`).join("")}</row>`).join("")}</sheetData></worksheet>`);
  });
  return Buffer.from(zipSync(files));
}

test("XLSX needs an explicit sheet selection and rejects cached formulas before creating a draft", async ({ page }) => {
  const state = await setup(page); await openMaterials(page);
  await openMaterialSpreadsheet(page);
  const rowValues = CATALOG_COLUMNS.materials.map((column) => materialRow[column as keyof typeof materialRow]);
  await page.getByLabel("上传学习资料表格").setInputFiles({ name: "资料.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: workbook([{ name: "第一张", rows: [[...CATALOG_COLUMNS.materials], rowValues] }, { name: "本次更新", rows: [[...CATALOG_COLUMNS.materials], rowValues] }]) });
  await expect(page.getByLabel("本批使用的工作表")).toBeVisible();
  await expect(page.getByRole("button", { name: "校验并生成预览" })).toBeDisabled();
  await page.getByLabel("本批使用的工作表").selectOption("本次更新");
  await page.getByRole("button", { name: "读取工作表" }).click();
  await expect(page.getByRole("status")).toContainText("已读取 1 行");
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toBeVisible();
  expect(state.drafts[0].sourceName).toContain("本次更新");
  await page.getByLabel("上传学习资料表格").setInputFiles({ name: "含公式.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: workbook([{ name: "资料", rows: [[...CATALOG_COLUMNS.materials], rowValues], formula: true }]) });
  await expect(page.getByRole("status")).toContainText("工作簿含有公式");
  await expect(page.getByRole("button", { name: "确认发布到网站" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "校验并生成预览" })).toBeDisabled();
  expect(state.previews).toBe(1);
});

test("entry modes preserve unfinished details and an existing material can be downlisted with its metadata folded", async ({ page }) => {
  const state = await setup(page); await openMaterials(page); await addLink(page);
  await page.getByLabel("资料标题", { exact: true }).fill("尚未加入本批的资料");
  const entryNav = page.getByRole("navigation", { name: "资料编辑方式" });
  await entryNav.getByRole("button", { name: "上传表格", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("上传学习资料表格")).toBeVisible();
  await expect(page.getByLabel("资料标题", { exact: true })).toBeHidden();
  await expect(page.getByText("本批资料 · 1 条", { exact: true })).toBeVisible();
  await entryNav.getByRole("button", { name: "直接填写", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("资料标题", { exact: true })).toHaveValue("尚未加入本批的资料");
  await page.getByText("查找并编辑已有资料", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("选择要修改的资料").selectOption(existingMaterial.id);
  await expect(page.getByLabel("资料编号", { exact: true })).toBeHidden();
  await expect(page.getByLabel("资料描述（选填）")).toHaveValue(existingMaterial.description);
  await page.getByLabel("本次操作").selectOption("下架");
  await page.getByRole("button", { name: "加入本批", exact: true }).click();
  await expect(page.getByText("本批资料 · 2 条", { exact: true })).toBeVisible();
  await expect(page.getByText("当前：等待校验", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "校验并生成预览" }).click();
  expect(state.drafts[0].rows[1]).toMatchObject({ 操作: "下架", 资料编号: existingMaterial.id, 描述: existingMaterial.description, 课程号: "11160113" });
  await expect(page.getByText("当前：核对变化", { exact: true })).toBeVisible();
  expect(state.publications).toBe(0);
});
