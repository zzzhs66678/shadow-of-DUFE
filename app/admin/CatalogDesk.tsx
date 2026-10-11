"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CATALOG_COLUMNS, exportCatalogRows, parseCatalogCsv, writeCatalogCsv } from "../../services/auth-api/src/catalog/import-contract.mjs";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { useModalFocus } from "../use-modal-focus";
import styles from "./catalog.module.css";

type Kind = "courses" | "materials";
type Row = Record<string, string>;
type Summary = { added: number; updated: number; removed: number; unchanged: number };
type Revision = number | string;
type Snapshot = { revision: Revision; version: string; coreUrl?: string; fullUrl?: string; url?: string };
type Release = { kind: Kind; version: string; revision: Revision; createdAt: string; sourceName: string; summary: Summary };
type SavedDraft = { id: string; kind: Kind; sourceName?: string; expiresAt: string; baseRevision: Revision };
type CatalogState = { current: Record<Kind, Snapshot>; history: Release[]; uploadsEnabled: boolean; drafts: SavedDraft[]; baselineVersions?: Record<Kind, string> };
type Draft = { id: string; kind: Kind; baseRevision: Revision; summary: Summary; changes: { id: string; label: string; action: string; before?: unknown; after?: unknown }[]; warnings: (string | { message: string })[]; expiresAt: string };
type FieldError = { row: number; field: string; message: string };
type ApiError = Error & { status?: number; code?: string; errors?: FieldError[] };
type Course = { id: string; title: string };
type Material = { id: string; name: string; courseIds: string[]; category: string; downloadUrl: string; description: string };
type MaterialForm = { id: string; title: string; courseId: string; category: string; link: string; description: string; operation: string };
const API = "/api/admin/catalog";
const MAX_ROWS = 10_000;
const MAX_SHEET_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const blankMaterial: MaterialForm = { id: "", title: "", courseId: "", category: "课件", link: "", description: "", operation: "更新" };
const labels: Record<Kind, string> = { courses: "课程与教学班", materials: "学习资料" };
const previewLabels: Record<string, string> = {
  id: "编号", title: "课程名称", name: "资料标题", college: "开课学院", colleges: "关联学院", category: "分类", property: "课程性质", credits: "学分", textbook: "教材", publisher: "出版社", author: "作者", term: "学期", terms: "学期", teachers: "教师", teacher: "教师", sectionId: "教学班编号", meetingIndex: "时段序号", sourceRow: "源表行号", courseId: "课程号", courseIds: "关联课程号", courseTitle: "关联课程", weekday: "星期", block: "大节", periods: "节次", weeks: "有效周次", timeText: "上课时间", building: "教学楼", room: "教室", classNames: "主修班级", linked: "关联专业", majorId: "专业编号", year: "年级", years: "年级", tags: "标签", kind: "资料类型", extension: "文件格式", sizeBytes: "文件大小", catalogedAt: "资料收录时间", description: "描述", previewable: "支持站内预览", previewUrl: "预览地址", downloadUrl: "资料链接", entries: "原有资料记录",
};

function previewText(value: unknown, field = ""): string {
  if (value == null || value === "") return "未填写";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (["term", "terms", "学期"].includes(field)) return value === "fall" ? "秋季（fall）" : value === "spring" ? "春季（spring）" : String(value);
  if (field === "weekday" && typeof value === "number") return `星期${"一二三四五六日"[value - 1] ?? value}`;
  if (field === "sizeBytes" && typeof value === "number") return value > 0 ? `${(value / 1024 / 1024).toFixed(2)} MiB` : "大小未标注";
  return String(value);
}

function PreviewValue({ value, field = "" }: { value: unknown; field?: string }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span>未填写</span>;
    if (value.every((item) => item == null || typeof item !== "object")) return <span>{value.map((item) => previewText(item, field)).join("、")}</span>;
    return <ol className={styles.nestedRecords}>{value.map((item, index) => <li key={index}><PreviewValue value={item} /></li>)}</ol>;
  }
  if (value && typeof value === "object") return <dl className={styles.recordFields}>{Object.entries(value).map(([key, item]) => <div key={key}><dt>{previewLabels[key] || key}</dt><dd><PreviewValue value={item} field={key} /></dd></div>)}</dl>;
  return <span>{previewText(value, field)}</span>;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init, headers: init?.body && typeof init.body === "string" ? { "Content-Type": "application/json", ...init.headers } : init?.headers });
  const payload = await response.json().catch(() => ({})) as { error?: string; errors?: FieldError[] };
  if (!response.ok) {
    const error = new Error(payload.error || "request_failed") as ApiError;
    error.status = response.status; error.code = payload.error; error.errors = payload.errors;
    throw error;
  }
  return payload as T;
}

function publicSnapshotUrl(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) throw new Error("目录地址无效，请刷新后重试。");
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("目录地址无效，请刷新后重试。");
  return url.pathname + url.search;
}

async function readSnapshot(snapshot: Snapshot, kind: Kind) {
  return requestJson<Record<string, unknown>>(publicSnapshotUrl(kind === "courses" ? snapshot.fullUrl : snapshot.url));
}

function dateLabel(value: string) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "部署时初始目录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function downloadCsv(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function errorLabel(error: unknown) {
  const failure = error as ApiError;
  if (failure.code === "admin_mfa_required") return "管理员验证已过期，请重新验证后继续。";
  if (failure.code === "catalog_retention_limit") return "保留版本已达到存储上限，请完成目录存储维护后重试。";
  if (failure.code === "catalog_dangling_material_reference") return "这个课程版本与现有资料的课程关联不一致，请先调整资料关联后重试。";
  if (failure.status === 409) return "网站目录刚刚发生变化。已停止发布，请重新校验并核对新预览。";
  if (failure.status === 410 || failure.code?.includes("expired")) return "这份预览已过期，请重新校验后发布。";
  if (failure.code === "catalog_not_found") return "这份预览已失效，请重新校验后发布。";
  if (failure.code === "catalog_no_changes") return "本批与当前目录相同，没有需要发布的变化。";
  if (failure.code === "catalog_draft_limit") return "暂存预览数量已达上限，请稍后再试。";
  if (failure.status === 413) return "文件或本批数据超过允许大小，请缩小后重试。";
  if (failure.code === "catalog_uploads_disabled") return "文件上传尚未启用。请先配置资料存储，或使用链接。";
  if (failure.status === 503) return "服务暂时不可用，请稍后重试。";
  if (failure.errors?.length) return "校验发现问题。请按行号修正表格，再重新上传。";
  if (failure.status) return "操作没有完成，请检查输入和网络后重试。";
  return failure.message || "操作没有完成，请重试。";
}

// Inspect ZIP metadata before expanding a workbook. Excel formulas are rejected,
// including formulas that carry a cached value; identifiers must remain literal.
async function readWorkbook(file: File) {
  const { unzipSync, strFromU8 } = await import("fflate");
  let expanded = 0; let entries = 0;
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => {
    expanded += entry.originalSize; entries += 1;
    if (expanded > 40 * 1024 * 1024 || entries > 256) throw new Error("工作簿解压后过大，请分成更小的表格。");
    return entry.name.endsWith(".xml");
  } });
  const workbook = files["xl/workbook.xml"];
  if (!workbook) throw new Error("这不是有效的 XLSX 工作簿。");
  let cells = 0;
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith("xl/worksheets/")) continue;
    const xml = strFromU8(bytes);
    if (/<(?:\w+:)?f(?:\s|>)/.test(xml)) throw new Error("工作簿含有公式。请将公式复制并粘贴为值，再上传。");
    cells += [...xml.matchAll(/<(?:\w+:)?c(?:\s|>)/g)].length;
    if (cells > 200_000 || [...xml.matchAll(/<(?:\w+:)?row\s[^>]*\br=["'](\d+)["']/g)].some((match) => Number(match[1]) > MAX_ROWS + 1)) throw new Error("工作簿超过 10,000 行或单元格过多，请分批上传。");
  }
  const xml = new DOMParser().parseFromString(strFromU8(workbook), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("工作簿格式有误，请重新保存为 XLSX。");
  const sheets = [...xml.getElementsByTagName("sheet")].map((sheet) => sheet.getAttribute("name") || "");
  if (!sheets.length || sheets.length > 12) throw new Error("工作簿须含 1 至 12 张工作表，请拆分后上传。");
  return sheets;
}

async function readWorkbookSheet(file: File, sheet: string, kind: Kind): Promise<Row[]> {
  const { readSheet } = await import("read-excel-file/browser");
  let data;
  try { data = await readSheet(file, sheet, { parseNumber: (value) => value }); }
  catch { throw new Error("无法读取这张工作表。请在 Excel 中另存为 XLSX，或转存为 UTF-8 CSV 后上传。"); }
  if (data.length > MAX_ROWS + 1) throw new Error("每批最多上传 10,000 行，请分批处理。");
  const strings = data.map((row) => row.map((cell) => {
    if (cell instanceof Date || typeof cell === "boolean") throw new Error("请按模板填写文字和数字，课程号应设为文本，不能使用日期或公式。");
    return cell == null ? "" : String(cell);
  }));
  const headers = strings[0] ?? [];
  const expected = CATALOG_COLUMNS[kind] as string[];
  if (headers.length !== expected.length || expected.some((name) => !headers.includes(name)) || new Set(headers).size !== headers.length) throw new Error(`表头须与${labels[kind]}模板一致。请先下载模板。`);
  if (strings.some((row) => row.length > headers.length)) throw new Error("存在超出模板列数的数据，请移除多余列。");
  const rows = strings.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
  // The shared parser applies exactly the same heading and literal-value rules.
  return parseCatalogCsv(writeCatalogCsv(rows, headers)) as Row[];
}

export function CatalogDesk({ active = true, onMfaExpired, onAuditChanged }: { active?: boolean; onMfaExpired: () => void; onAuditChanged: () => Promise<void> }) {
  const [kind, setKind] = useState<Kind>("courses");
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [sourceName, setSourceName] = useState("");
  const [sheetFile, setSheetFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheetName, setSheetName] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState("");
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [visibleChanges, setVisibleChanges] = useState(20);
  const [materialForm, setMaterialForm] = useState<MaterialForm>(blankMaterial);
  const [courseSearch, setCourseSearch] = useState("");
  const [materialSearch, setMaterialSearch] = useState("");
  const [fileMode, setFileMode] = useState(false);
  const [pendingFile, setPendingFile] = useState("");
  const [now, setNow] = useState(0);
  const [rollback, setRollback] = useState<{ entry: Release; revision: Revision } | null>(null);
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackNotice, setRollbackNotice] = useState("");
  const noticeRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLHeadingElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeRollback = useCallback(() => { setRollback(null); setRollbackNotice(""); }, []);
  const rollbackRef = useModalFocus<HTMLFormElement>(Boolean(rollback), closeRollback, busy === "rollback");
  const courseSnapshot = catalog?.current.courses;
  const materialSnapshot = catalog?.current.materials;

  const loadCatalog = useCallback(async () => {
    const next = await requestJson<CatalogState>(API);
    if (!next.current?.courses || !next.current?.materials) throw new Error("目录状态暂时不可用，请重试。");
    setCatalog(next);
    return next;
  }, []);

  const reportError = useCallback((error: unknown) => {
    const failure = error as ApiError;
    if (failure.code === "admin_mfa_required") onMfaExpired();
    setErrors(failure.errors ?? []); setNotice(errorLabel(error));
    window.requestAnimationFrame(() => noticeRef.current?.focus());
  }, [onMfaExpired]);

  useEffect(() => {
    if (!active || catalog) return;
    const controller = new AbortController();
    void requestJson<CatalogState>(API, { signal: controller.signal }).then((next) => {
      if (!next.current?.courses || !next.current?.materials) throw new Error("目录状态暂时不可用，请重试。");
      setCatalog(next);
    }).catch((error) => { if (!controller.signal.aborted) reportError(error); });
    return () => controller.abort();
  }, [active, catalog, reportError]);

  useEffect(() => {
    if (!draft) return;
    const tick = () => setNow(Date.now()); tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [draft]);

  useEffect(() => {
    if (!active || kind !== "materials" || !courseSnapshot || !materialSnapshot) return;
    let alive = true;
    void Promise.all([readSnapshot(courseSnapshot, "courses"), readSnapshot(materialSnapshot, "materials")]).then(([courseData, materialData]) => {
      if (alive) {
        setCourses((courseData.courses ?? []) as Course[]);
        // Match the export contract: legacy rows sharing one material ID are
        // presented once, with their explicit course associations preserved.
        setMaterials(exportCatalogRows("materials", materialData).map((row) => ({ id: row.资料编号, name: row.标题, courseIds: row.课程号.split(";"), category: row.分类, downloadUrl: row.链接, description: row.描述 })));
      }
    }).catch((error) => { if (alive) reportError(error); });
    return () => { alive = false; };
  }, [active, kind, courseSnapshot, materialSnapshot, reportError]);

  const expired = Boolean(draft && now >= new Date(draft.expiresAt).getTime());
  const current = catalog?.current[kind];
  const filteredCourses = useMemo(() => {
    const query = courseSearch.trim().toLocaleLowerCase();
    const selected = new Set(materialForm.courseId.split(";").filter(Boolean));
    const matches = courses.filter((course) => !query || `${course.id} ${course.title}`.toLocaleLowerCase().includes(query)).slice(0, 50);
    return [...courses.filter((course) => selected.has(course.id) && !matches.some((match) => match.id === course.id)), ...matches];
  }, [courses, courseSearch, materialForm.courseId]);
  const filteredMaterials = useMemo(() => {
    const matches = materials.filter((material) => `${material.id} ${material.name}`.toLocaleLowerCase().includes(materialSearch.trim().toLocaleLowerCase())).slice(0, 40);
    const selected = materials.find((material) => material.id === materialForm.id);
    return selected && !matches.some((material) => material.id === selected.id) ? [selected, ...matches] : matches;
  }, [materials, materialSearch, materialForm.id]);
  const releaseHistory = catalog ? catalog.history.filter((entry) => entry.kind === kind) : [];
  if (catalog?.baselineVersions?.[kind] && !releaseHistory.some((entry) => entry.version === catalog.baselineVersions?.[kind])) releaseHistory.push({ kind, version: catalog.baselineVersions[kind], revision: 0, createdAt: "", sourceName: "部署时初始目录", summary: { added: 0, updated: 0, removed: 0, unchanged: 0 } });
  const changedCount = draft ? draft.summary.added + draft.summary.updated + draft.summary.removed : 0;

  function invalidatePreview() { setDraft(null); setReason(""); setAcknowledgeWarnings(false); setErrors([]); setVisibleChanges(20); }
  function changeKind(next: Kind) { if (next === kind) return; setKind(next); setRows([]); setSourceName(""); setSheetFile(null); setSheets([]); setSheetName(""); setNotice(""); invalidatePreview(); if (fileInputRef.current) fileInputRef.current.value = ""; }

  async function readSpreadsheet(file?: File) {
    if (!file) return;
    invalidatePreview(); setRows([]); setSheets([]); setSheetFile(null); setSourceName(""); setNotice(""); setBusy("read");
    try {
      if (file.size > MAX_SHEET_BYTES) throw new Error("表格不能超过 8 MiB，请分批上传。");
      if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error("请选择 CSV 或 XLSX 表格；旧版 XLS 请另存为 XLSX。");
      let nextRows: Row[];
      if (/\.xlsx$/i.test(file.name)) {
        const names = await readWorkbook(file); setSheetFile(file); setSheets(names); setSheetName(names[0]);
        if (names.length > 1) { setSourceName(file.name.slice(0, 160)); setNotice("请选择本批使用的工作表，再点击读取工作表。"); return; }
        nextRows = await readWorkbookSheet(file, names[0], kind);
      } else { nextRows = parseCatalogCsv(await file.text()) as Row[]; }
      if (!nextRows.length || nextRows.length > MAX_ROWS) throw new Error("请上传含 1 至 10,000 行数据的表格。");
      if (nextRows.some((row) => Object.keys(row).some((name) => !CATALOG_COLUMNS[kind].includes(name)))) throw new Error(`请上传${labels[kind]}模板，或切换到对应目录类型。`);
      setRows(nextRows); setSourceName(file.name.slice(0, 160)); setNotice(`已读取 ${nextRows.length} 行，请继续校验。`);
    } catch (error) { reportError(error); } finally { setBusy(""); }
  }

  async function readSelectedSheet() {
    if (!sheetFile) return;
    invalidatePreview(); setRows([]); setBusy("read");
    try {
      const nextRows = await readWorkbookSheet(sheetFile, sheetName, kind);
      if (!nextRows.length) throw new Error("这张工作表没有数据，请选择其他工作表。");
      setRows(nextRows); setSourceName(`${sheetFile.name} · ${sheetName}`.slice(0, 160)); setNotice(`已读取 ${nextRows.length} 行，请继续校验。`);
    } catch (error) { reportError(error); } finally { setBusy(""); }
  }

  async function exportCurrent() {
    if (!current) return;
    setBusy("export"); setNotice("");
    try {
      const payload = await readSnapshot(current, kind);
      downloadCsv(writeCatalogCsv(exportCatalogRows(kind, payload), CATALOG_COLUMNS[kind]), `${labels[kind]}-当前目录-r${current.revision}.csv`);
      setNotice("已导出当前目录。保留原编号，修改需要更新的行；未上传的记录会保留。");
    } catch (error) { reportError(error); } finally { setBusy(""); }
  }

  async function validateRows() {
    if (!current || !rows.length) return;
    setBusy("validate"); setNotice(""); setErrors([]);
    try {
      if (draft) {
        await requestJson(`${API}/drafts/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
        setCatalog((value) => value ? { ...value, drafts: value.drafts.filter((entry) => entry.id !== draft.id) } : value);
      }
      setDraft(null);
      const payload = await requestJson<{ draft: Draft }>(`${API}/drafts`, { method: "POST", body: JSON.stringify({ kind, rows, expectedRevision: current.revision, sourceName }) });
      setDraft(payload.draft); setReason(""); setAcknowledgeWarnings(false); setVisibleChanges(20); setNow(Date.now());
      setCatalog((value) => value ? { ...value, drafts: [...value.drafts.filter((entry) => entry.id !== payload.draft.id), { id: payload.draft.id, kind: payload.draft.kind, sourceName, expiresAt: payload.draft.expiresAt, baseRevision: payload.draft.baseRevision }] } : value);
      setNotice("校验通过。请核对变化清单，再填写发布说明。");
      window.requestAnimationFrame(() => previewRef.current?.focus());
    } catch (error) {
      reportError(error);
      if ((error as ApiError).status === 409) await loadCatalog().catch(reportError);
    } finally { setBusy(""); }
  }

  async function discardDraft(id: string) {
    setBusy("discard"); setNotice("");
    try {
      await requestJson(`${API}/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
      setCatalog((value) => value ? { ...value, drafts: value.drafts.filter((entry) => entry.id !== id) } : value);
      if (draft?.id === id) invalidatePreview();
      setNotice("预览已丢弃。本批填写保留，可重新校验。");
    } catch (error) { reportError(error); } finally { setBusy(""); }
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || expired || reason.trim().length < 8 || !changedCount || (draft.warnings.length && !acknowledgeWarnings)) return;
    setBusy("publish"); setNotice("");
    try {
      await requestJson(`${API}/drafts/${encodeURIComponent(draft.id)}/publish`, { method: "POST", body: JSON.stringify({ expectedRevision: draft.baseRevision, reason: reason.trim(), acknowledgeWarnings }) });
      invalidatePreview(); setRows([]); setSourceName(""); setSheets([]); setSheetFile(null); setMaterialForm(blankMaterial); setPendingFile("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice(`${labels[kind]}已发布，网站将读取新目录。`);
      await loadCatalog().catch(() => setNotice(`${labels[kind]}已发布。目录状态刷新失败，请刷新页面查看新版本。`));
      await onAuditChanged().catch(() => {});
      window.requestAnimationFrame(() => noticeRef.current?.focus());
    } catch (error) {
      reportError(error);
      const failure = error as ApiError;
      if ((failure.status === 409 && !["catalog_retention_limit", "catalog_dangling_material_reference"].includes(failure.code ?? "")) || failure.status === 410 || failure.code === "catalog_not_found") { invalidatePreview(); await loadCatalog().catch(reportError); }
    } finally { setBusy(""); }
  }

  async function uploadMaterial(file?: File) {
    if (!file || !catalog?.uploadsEnabled) return;
    setBusy("file"); setNotice("");
    try {
      if (file.size === 0 || file.size > MAX_FILE_BYTES) throw new Error("请选择大小为 1 字节至 25 MiB 的资料文件。更大文件请使用 HTTPS 链接。");
      if (!/\.(pdf|pptx|docx|xlsx|zip)$/i.test(file.name)) throw new Error("支持 PDF、PPTX、DOCX、XLSX 和 ZIP 文件。");
      const payload = await requestJson<{ file: { id: string; url: string; name: string; sizeBytes: number } }>(`${API}/files`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
      setMaterialForm((value) => ({ ...value, title: value.title || payload.file.name, link: payload.file.url }));
      setPendingFile(payload.file.name); setNotice("文件已暂存。填写课程与标题，加入本批后还需校验并发布。");
    } catch (error) { reportError(error); } finally { setBusy(""); }
  }

  function chooseExisting(id: string) {
    const material = materials.find((item) => item.id === id);
    if (!material) { setMaterialForm(blankMaterial); setPendingFile(""); return; }
    setMaterialForm({ id: material.id, title: material.name, courseId: material.courseIds.join(";"), category: material.category, link: material.downloadUrl, description: material.description, operation: "更新" });
    setPendingFile(""); setFileMode(false); setCourseSearch("");
  }

  function addMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = materialForm.id || [...crypto.getRandomValues(new Uint8Array(10))].map((value) => value.toString(16).padStart(2, "0")).join("");
    const row = { 操作: materialForm.operation, 资料编号: id, 标题: materialForm.title.trim(), 课程号: materialForm.courseId, 分类: materialForm.category.trim(), 链接: materialForm.link.trim(), 描述: materialForm.description.trim() };
    if (!rows.some((entry) => entry.资料编号 === id) && rows.length >= MAX_ROWS) { setNotice("本批已达到 10,000 行，请先发布再新增。"); return; }
    invalidatePreview();
    setRows((value) => value.some((entry) => entry.资料编号 === id) ? value.map((entry) => entry.资料编号 === id ? row : entry) : [...value, row]);
    setSourceName("后台资料编辑"); setMaterialForm(blankMaterial); setPendingFile(""); setNotice("资料已加入本批。请继续校验，核对后发布。");
  }

  async function confirmRollback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!rollback || rollbackReason.trim().length < 8) return;
    setBusy("rollback"); setRollbackNotice("");
    try {
      await requestJson(`${API}/rollback`, { method: "POST", body: JSON.stringify({ kind: rollback.entry.kind, targetVersion: rollback.entry.version, expectedRevision: rollback.revision, reason: rollbackReason.trim() }) });
      setRollback(null); invalidatePreview(); setNotice(`${labels[rollback.entry.kind]}已恢复到所选版本。`);
      await loadCatalog().catch(() => setNotice("所选版本已恢复。目录状态刷新失败，请刷新页面查看。"));
      await onAuditChanged().catch(() => {});
      window.requestAnimationFrame(() => noticeRef.current?.focus());
    } catch (error) {
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
      setRollbackNotice(errorLabel(error));
      if ((error as ApiError).status === 409) await loadCatalog().catch(reportError);
    } finally { setBusy(""); }
  }

  return <section className={styles.desk} aria-label="课程与资料发布工作台">
    <header className={styles.intro}><div><span className={styles.eyebrow}>目录编辑 · 按批发布</span><h2>准备好，再让大家看见。</h2><p>用同一份模板更新课程与教学班，或把资料关联到已有课程。</p></div><span className={styles.stamp}>发布前<br />先核对</span></header>
    <nav className={styles.kindNav} aria-label="目录类型">{(["courses", "materials"] as Kind[]).map((value) => <button key={value} aria-pressed={kind === value} disabled={Boolean(busy)} onClick={() => changeKind(value)}>{labels[value]}<small>{catalog ? `当前 r${catalog.current[value].revision}` : "读取中"}</small></button>)}</nav>
    <ol className={styles.steps} aria-label="发布步骤">{["准备内容", "校验表格", "核对变化", "确认发布"].map((label, index) => <li key={label} aria-current={(draft ? 2 : rows.length ? 1 : 0) === index ? "step" : undefined}><span>0{index + 1}</span><b>{label}</b></li>)}</ol>
    {notice && <div className={styles.notice} ref={noticeRef} tabIndex={-1} role={errors.length ? "alert" : "status"}>{notice}</div>}
    {!catalog && <div className={styles.loading}><p>{notice ? "目录状态尚未加载。" : "正在读取当前目录…"}</p>{notice && <button className={styles.button} onClick={() => void loadCatalog().catch(reportError)}>重新读取目录</button>}</div>}
    {catalog && <>
      <section className={styles.section} aria-labelledby="catalog-prepare-title"><header className={styles.sectionHeader}><h3 id="catalog-prepare-title"><span>01</span>准备{labels[kind]}</h3><div className={styles.tools}><button className={styles.button} disabled={Boolean(busy)} onClick={() => downloadCsv(writeCatalogCsv([], CATALOG_COLUMNS[kind]), `${labels[kind]}-模板.csv`)}>下载空白模板</button><button className={styles.button} disabled={Boolean(busy)} onClick={() => void exportCurrent()}>{busy === "export" ? "正在导出…" : "导出当前目录"}</button></div></header>
        <details className={styles.template}><summary>模板字段与填写规则</summary><p>保留表头。新增或更新填“更新”；仅修改上传的记录，其他记录会保留。编号需保持稳定，不能用课程名代替课程号。</p><div className={styles.columnList}>{(CATALOG_COLUMNS[kind] as string[]).map((column) => <code key={column}>{column}</code>)}</div>{kind === "courses" ? <p>一行表示一个上课时段。同一教学班可有多行，时段编号各不相同；教师、主修班级与课序号保持一致。学期填 fall（秋季）或 spring（春季），星期填 1–7，节次如 1–2、3–4、5–7 或 8–10。周次填“1-9周”“9-18周”或“1-18周”。删除某时段时，“操作”填“删除时段”，并保留其时段编号。</p> : <p>资料编号为空时会生成新编号；更新已有资料应保留原编号。多门课程用英文分号分隔。下架时，“操作”填“下架”，并保留资料编号。链接支持 HTTPS，或已暂存的站内文件地址。</p>}<p>CSV 用 UTF-8 保存；XLSX 的课程号、编号设为文本，公式需粘贴为值。每批最多 10,000 行、表格 8 MiB。</p></details>
        <div className={styles.upload}><label htmlFor="catalog-spreadsheet">上传{labels[kind]}表格</label><input ref={fileInputRef} id="catalog-spreadsheet" type="file" accept=".csv,.xlsx" disabled={Boolean(busy)} onChange={(event) => void readSpreadsheet(event.target.files?.[0])} /><small>{sourceName || "从空白模板新增，或从当前目录修改后上传"}</small></div>
        {sheets.length > 1 && <div className={styles.sheetChoice}><label htmlFor="catalog-sheet">本批使用的工作表</label><select id="catalog-sheet" disabled={Boolean(busy)} value={sheetName} onChange={(event) => { setSheetName(event.target.value); setRows([]); invalidatePreview(); }} >{sheets.map((name) => <option key={name}>{name}</option>)}</select><button className={styles.button} disabled={Boolean(busy)} onClick={() => void readSelectedSheet()}>读取工作表</button></div>}
        {kind === "materials" && <details className={styles.composer} open><summary>逐条添加或修改资料</summary>
          <div className={styles.existing}><label htmlFor="catalog-material-search">查找现有资料</label><input id="catalog-material-search" value={materialSearch} onChange={(event) => setMaterialSearch(event.target.value)} placeholder="标题或资料编号" maxLength={200} disabled={Boolean(busy)} /><label htmlFor="catalog-existing-material">选择要修改的资料</label><select id="catalog-existing-material" value={materials.some((item) => item.id === materialForm.id) ? materialForm.id : ""} disabled={Boolean(busy)} onChange={(event) => chooseExisting(event.target.value)}><option value="">添加新资料</option>{filteredMaterials.map((material) => <option key={material.id} value={material.id}>{material.name} · {material.id}</option>)}</select><small>最多显示 40 项，请用搜索缩小范围。</small></div>
          <form onSubmit={addMaterial} className={styles.materialForm}><div className={styles.field}><label htmlFor="catalog-material-title">资料标题</label><input id="catalog-material-title" required={materialForm.operation !== "下架"} maxLength={200} value={materialForm.title} disabled={Boolean(busy)} onChange={(event) => setMaterialForm((value) => ({ ...value, title: event.target.value }))} /></div><div className={styles.field}><label htmlFor="catalog-material-category">分类</label><input id="catalog-material-category" required={materialForm.operation !== "下架"} maxLength={80} list="catalog-material-categories" value={materialForm.category} disabled={Boolean(busy)} onChange={(event) => setMaterialForm((value) => ({ ...value, category: event.target.value }))} /><datalist id="catalog-material-categories"><option value="课件" /><option value="题库" /><option value="教材" /><option value="其他" /></datalist></div>
            <div className={styles.fullField}><label htmlFor="catalog-course-search">查找要关联的课程</label><input id="catalog-course-search" placeholder="输入课程名或课程号" value={courseSearch} maxLength={100} disabled={Boolean(busy)} onChange={(event) => setCourseSearch(event.target.value)} /></div><div className={styles.fullField}><label htmlFor="catalog-material-course">关联课程（按课程号选择）</label><select id="catalog-material-course" required={materialForm.operation !== "下架"} value={materialForm.courseId.includes(";") ? "__multiple" : materialForm.courseId} disabled={Boolean(busy)} onChange={(event) => setMaterialForm((value) => ({ ...value, courseId: event.target.value }))}><option value="">请选择课程</option>{materialForm.courseId.includes(";") && <option value="__multiple">保留原有多门课程：{materialForm.courseId}</option>}{filteredCourses.map((course) => <option key={course.id} value={course.id}>{course.id} · {course.title}</option>)}</select><small>最多显示 50 门。通过表格可关联多门课程；同名课程请核对课程号。</small></div>
            <div className={styles.fullField}><nav className={styles.sourceNav} aria-label="资料来源"><button type="button" aria-pressed={!fileMode} disabled={Boolean(busy)} onClick={() => setFileMode(false)}>填写链接</button><button type="button" aria-pressed={fileMode} disabled={Boolean(busy)} onClick={() => setFileMode(true)}>上传文件</button></nav>{fileMode && <div className={styles.fileSource}><label htmlFor="catalog-material-file">资料文件（最多 25 MiB）</label><input id="catalog-material-file" type="file" accept=".pdf,.pptx,.docx,.xlsx,.zip" disabled={Boolean(busy) || !catalog.uploadsEnabled} onChange={(event) => void uploadMaterial(event.target.files?.[0])} /><small>{catalog.uploadsEnabled ? "支持 PDF、PPTX、DOCX、XLSX、ZIP；大文件可填写外部链接。" : "文件上传未启用：服务器尚未配置资料存储目录。当前可填写 HTTPS 链接。"}</small>{pendingFile && <p className={styles.pending}>待发布文件 · {pendingFile}</p>}</div>}<label htmlFor="catalog-material-link">资料链接</label><input id="catalog-material-link" required={materialForm.operation !== "下架"} placeholder="https://…" maxLength={2000} value={materialForm.link} disabled={Boolean(busy) || (fileMode && Boolean(pendingFile))} onChange={(event) => { setPendingFile(""); setMaterialForm((value) => ({ ...value, link: event.target.value })); }} /><small>上传文件会自动填入地址，发布关联资料后才能在网站下载。</small></div>
            <div className={styles.fullField}><label htmlFor="catalog-material-description">资料描述（选填）</label><textarea id="catalog-material-description" rows={2} maxLength={500} value={materialForm.description} disabled={Boolean(busy)} onChange={(event) => setMaterialForm((value) => ({ ...value, description: event.target.value }))} /></div><div className={styles.field}><label htmlFor="catalog-material-id">资料编号</label><input id="catalog-material-id" pattern="[a-f0-9]{20}" placeholder="新增时自动生成" maxLength={20} value={materialForm.id} disabled={Boolean(busy)} onChange={(event) => setMaterialForm((value) => ({ ...value, id: event.target.value }))} /></div><div className={styles.field}><label htmlFor="catalog-material-operation">本次操作</label><select id="catalog-material-operation" value={materialForm.operation} disabled={Boolean(busy)} onChange={(event) => setMaterialForm((value) => ({ ...value, operation: event.target.value }))}><option value="更新">新增或更新</option><option value="下架" disabled={!materialForm.id}>下架资料</option></select></div><div className={styles.formActions}><button className={styles.button} type="button" disabled={Boolean(busy)} onClick={() => { setMaterialForm(blankMaterial); setPendingFile(""); }}>清空填写</button><button className={styles.primary} disabled={Boolean(busy) || (materialForm.operation === "下架" && !materialForm.id)}>加入本批</button></div></form>
        </details>}
        {kind === "materials" && rows.length > 0 && <details className={styles.queue}><summary>本批资料 · {rows.length} 条</summary><ol>{rows.slice(0, 20).map((row, index) => <li key={`${row.资料编号}-${index}`}><div><b>{row.标题 || row.资料编号}</b><small>{row.操作 || "更新"} · {row.课程号}</small></div><button className={styles.button} disabled={Boolean(busy)} onClick={() => { setRows((value) => value.filter((_, rowIndex) => rowIndex !== index)); invalidatePreview(); }}>移出本批<span className="sr-only"> {row.标题 || row.资料编号}</span></button></li>)}</ol>{rows.length > 20 && <p>其余 {rows.length - 20} 条可在校验后的变化清单中核对。</p>}</details>}
      </section>
      <section className={styles.checkSection} aria-labelledby="catalog-validate-title"><div><h3 id="catalog-validate-title"><span>02</span>校验表格</h3><p>{busy === "read" ? "正在读取表格…" : rows.length ? `本批 ${rows.length} 行 · 基于当前 r${current?.revision}` : "上传表格，或把资料加入本批后继续。"}</p></div><button className={styles.primary} disabled={Boolean(busy) || !rows.length} onClick={() => void validateRows()}>{busy === "validate" ? "正在校验…" : draft ? "重新校验并预览" : "校验并生成预览"}</button></section>
      {errors.length > 0 && <section className={styles.errorList} aria-label="表格校验错误"><h4>需修正 {errors.length} 处</h4><ol>{errors.slice(0, 100).map((error, index) => <li key={index}><b>第 {error.row} 行 · {error.field}</b><span>{error.message}</span></li>)}</ol>{errors.length > 100 && <p>先修正前 100 处，再重新校验。</p>}</section>}
      <section className={styles.section} aria-labelledby="catalog-preview-title"><header className={styles.sectionHeader}><h3 id="catalog-preview-title" ref={previewRef} tabIndex={-1}><span>03</span>核对变化</h3>{draft && <small>预览有效至 {dateLabel(draft.expiresAt)}</small>}</header>{!draft ? <p className={styles.muted}>校验通过后，这里会列出新增、修改和删除。</p> : <><dl className={styles.summary}>{[["新增", draft.summary.added], ["修改", draft.summary.updated], ["删除 / 下架", draft.summary.removed], ["未改变", draft.summary.unchanged]].map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>{!changedCount && <p className={styles.muted}>本批没有变化，无需发布。</p>}<ol className={styles.changes}>{draft.changes.slice(0, visibleChanges).map((change) => <li key={change.id}><details><summary><span className={styles.changeTag}>{({ added: "新增", updated: "修改", removed: "删除", unchanged: "未改变", add: "新增", update: "修改", remove: "删除" } as Record<string, string>)[change.action] || change.action}</span><b>{change.label}</b><code>{change.id}</code></summary><div className={styles.comparison}><div><h4>发布前</h4><div className={styles.recordBody} tabIndex={change.before == null ? undefined : 0} aria-label="发布前的记录字段">{change.before == null ? <p>尚无此记录</p> : <PreviewValue value={change.before} />}</div></div><div><h4>发布后</h4><div className={styles.recordBody} tabIndex={change.after == null ? undefined : 0} aria-label="发布后的记录字段">{change.after == null ? <p>将删除此记录</p> : <PreviewValue value={change.after} />}</div></div></div></details></li>)}</ol>{draft.changes.length > visibleChanges && <button className={styles.button} onClick={() => setVisibleChanges((value) => value + 20)}>再显示 20 条变化</button>}{draft.warnings.length > 0 && <div className={styles.warnings}><h4>发布前需要注意</h4><ul>{draft.warnings.map((warning, index) => <li key={index}>{typeof warning === "string" ? warning : warning.message}</li>)}</ul></div>}</>}</section>
      <section className={styles.section} aria-labelledby="catalog-publish-title"><header className={styles.sectionHeader}><h3 id="catalog-publish-title"><span>04</span>确认发布</h3></header>{draft ? <form onSubmit={publish} className={styles.publishForm}><p>发布{labels[draft.kind]}，共 {changedCount} 处变化。成功后网站使用这一批目录，原版本保留供恢复。</p>{expired && <p className={styles.expired} role="alert">预览已过期，请重新校验。</p>}<label htmlFor="catalog-publish-reason">发布说明（至少 8 个字）</label><textarea id="catalog-publish-reason" value={reason} rows={2} minLength={8} maxLength={500} required disabled={Boolean(busy)} onChange={(event) => setReason(event.target.value)} placeholder="例如：补充秋季课程资料并修正教室" />{draft.warnings.length > 0 && <label className={styles.acknowledge}><input type="checkbox" checked={acknowledgeWarnings} disabled={Boolean(busy)} onChange={(event) => setAcknowledgeWarnings(event.target.checked)} /><span>我已核对以上提醒，确认继续发布</span></label>}<button className={styles.publish} disabled={Boolean(busy) || expired || !changedCount || reason.trim().length < 8 || (draft.warnings.length > 0 && !acknowledgeWarnings)}>{busy === "publish" ? "正在发布…" : "确认发布到网站"}</button></form> : <p className={styles.muted}>完成校验与核对后，才能发布。</p>}</section>
      {catalog.drafts.length > 0 && <details className={styles.history}><summary>未发布预览 · {catalog.drafts.length} 份</summary><p>预览保存 20 分钟，最多保留 3 份。可丢弃不再使用的预览，释放本批空间。</p><ol>{catalog.drafts.map((entry) => <li key={entry.id}><div><b>{labels[entry.kind]} · {entry.sourceName || "未命名表格"}</b><span>基于 r{entry.baseRevision} · 有效至 {dateLabel(entry.expiresAt)}</span></div><button className={styles.button} disabled={Boolean(busy)} onClick={() => void discardDraft(entry.id)}>丢弃预览<span className="sr-only"> {entry.sourceName || entry.id}</span></button></li>)}</ol></details>}
      <details className={styles.history}><summary>发布记录与恢复版本</summary><p>恢复会把所选目录整体切换到该版本，请先核对版本和时间。</p><ol>{releaseHistory.map((entry) => <li key={`${entry.version}-${entry.revision}`}><div><b>{labels[entry.kind]} · r{entry.revision}{catalog.current[entry.kind].version === entry.version ? " · 当前" : ""}</b><time dateTime={entry.createdAt || undefined}>{dateLabel(entry.createdAt)}</time><span>{entry.sourceName || "初始目录"}</span><code>{entry.version.slice(0, 12)}</code></div>{catalog.current[entry.kind].version !== entry.version && <button className={styles.button} disabled={Boolean(busy)} onClick={() => { setRollback({ entry, revision: catalog.current[entry.kind].revision }); setRollbackReason(""); setRollbackNotice(""); }}>恢复此版本</button>}</li>)}</ol>{!releaseHistory.length && <p>还没有发布记录。</p>}</details>
    </>}
    {rollback && <DialogBackdrop onDismiss={closeRollback} dismissDisabled={busy === "rollback"}><form className={styles.rollbackDialog} ref={rollbackRef} role="dialog" aria-modal="true" aria-labelledby="catalog-rollback-title" onSubmit={confirmRollback}><span className={styles.eyebrow}>恢复目录版本</span><h2 id="catalog-rollback-title">确认恢复{labels[rollback.entry.kind]}</h2><p>网站将使用 {dateLabel(rollback.entry.createdAt)} 的 r{rollback.entry.revision}。当前这一类目录的后续更新会被替换。</p><p>{rollback.entry.sourceName || "初始目录"}<br /><code>{rollback.entry.version}</code></p><label htmlFor="catalog-rollback-reason">恢复原因（至少 8 个字）</label><textarea id="catalog-rollback-reason" required minLength={8} maxLength={500} rows={3} value={rollbackReason} disabled={busy === "rollback"} onChange={(event) => setRollbackReason(event.target.value)} />{rollbackNotice && <p role="alert">{rollbackNotice}</p>}<DialogActions><button className={styles.button} type="button" disabled={busy === "rollback"} onClick={closeRollback}>取消</button><button className={styles.publish} disabled={busy === "rollback" || rollbackReason.trim().length < 8}>{busy === "rollback" ? "正在恢复…" : "确认恢复此版本"}</button></DialogActions></form></DialogBackdrop>}
  </section>;
}
