// Requires the dedicated native fixture; this suite never mocks business APIs.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { CATALOG_COLUMNS, exportCatalogRows, writeCatalogCsv } from '../../services/auth-api/src/catalog/import-contract.mjs';

async function checkReply(response, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function previewAndPublish(page, kind) {
  const previewReply = page.waitForResponse(response => response.url().endsWith('/api/admin/catalog/drafts') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '校验并生成预览' }).click();
  const { draft } = await checkReply(await previewReply, 201);
  expect(draft.summary.updated + draft.summary.added + draft.summary.removed).toBeGreaterThan(0);
  await page.getByLabel('发布说明（至少 8 个字）').fill('本机原生数据库核对后发布合成目录');
  const warning = page.getByLabel('我已核对以上提醒，确认继续发布');
  if (await warning.count()) await warning.check();
  const publication = page.waitForResponse(response => response.url().endsWith('/publish') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认发布到网站' }).click();
  const result = await checkReply(await publication);
  await expect(page.getByRole('status').filter({ hasText: `${kind}已发布` })).toBeVisible();
  return result;
}

test('real native publication reaches search, SSR details, file bytes and bookmarks while original personal data survives rollback', async ({ browser, request }, testInfo) => {
  const fixture = await checkReply(await request.get('/__catalog_fixture'));
  expect(fixture.migrationCount).toBe(32);
  expect(fixture.runtimeRole).toMatch(/^catalog_browser_runtime_/);
  const adminContext = await browser.newContext({ baseURL: fixture.origin });
  const userContext = await browser.newContext({ baseURL: fixture.origin });
  const errors = [];
  try {
    await adminContext.addCookies(fixture.seeds.admin.cookies);
    await userContext.addCookies(fixture.seeds.user.cookies);
    const admin = await adminContext.newPage(), user = await userContext.newPage();
    admin.on('pageerror', error => errors.push(error.message)); user.on('pageerror', error => errors.push(error.message));
    const seededPersonal = await checkReply(await userContext.request.get('/api/auth/sync'));
    expect(seededPersonal.state.plans[0].scheduleIds).toContain(fixture.course.meetingId);
    expect(seededPersonal.state.assignments[0].title).toBe('合成原始作业');
    // The existing first-login merge also carries this clean browser's empty
    // default plan. Establish its ordinary synced state before publications,
    // and separately prove the original cloud records survived that merge.
    await user.goto(`/?view=catalog&course=${encodeURIComponent(fixture.course.id)}`);
    await expect(user.getByRole('heading', { name: fixture.course.title, exact: true, level: 2 })).toBeVisible();
    await expect.poll(async () => (await checkReply(await userContext.request.get('/api/auth/sync'))).revision).toBeGreaterThan(seededPersonal.revision);
    const beforePersonal = await checkReply(await userContext.request.get('/api/auth/sync'));
    expect(beforePersonal.state.plans.find(item => item.id === 'original-plan')).toEqual(seededPersonal.state.plans[0]);
    expect(beforePersonal.state.assignments).toEqual(seededPersonal.state.assignments);
    expect(beforePersonal.state.activePlanId).toBe(seededPersonal.state.activePlanId);
    await checkReply(await userContext.request.put(`/api/material-bookmarks/${fixture.existingMaterialId}`, {
      headers: { Origin: fixture.origin, 'X-Material-Bookmark-Owner': fixture.seeds.user.id }, data: {} }));
    const beforeBookmarks = await checkReply(await userContext.request.get('/api/material-bookmarks'));
    expect(beforeBookmarks.items.map(item => item.materialId)).toContain(fixture.existingMaterialId);
    expect((await userContext.request.get('/api/admin/catalog')).status()).toBe(403);

    await admin.goto('/admin');
    await expect(admin.getByRole('heading', { name: '课程与资料', exact: true })).toBeVisible();
    await admin.getByRole('navigation', { name: '目录类型' }).getByRole('button', { name: '学习资料' }).click();
    await admin.getByLabel('查找要关联的课程').fill(fixture.course.id);
    await expect(admin.getByLabel('关联课程（按课程号选择）').getByRole('option', { name: `${fixture.course.id} · ${fixture.course.title}` })).toBeAttached();
    await admin.getByLabel('关联课程（按课程号选择）').selectOption(fixture.course.id);
    const title = '合成本机真实发布学习资料';
    await admin.getByLabel('资料标题', { exact: true }).fill(title);
    await admin.getByRole('button', { name: '上传文件', exact: true }).click();
    const pdf = Buffer.from('%PDF-1.7\n% isolated catalog native browser test\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    const uploaded = admin.waitForResponse(response => response.url().endsWith('/api/admin/catalog/files') && response.request().method() === 'POST');
    await admin.getByLabel('资料文件（最多 25 MiB）').setInputFiles({ name: '合成发布验收.pdf', mimeType: 'application/pdf', buffer: pdf });
    const { file } = await checkReply(await uploaded, 201);
    expect(file.sizeBytes).toBe(pdf.length);
    expect((await request.get(file.url)).status()).toBe(404);
    await admin.getByRole('button', { name: '加入本批', exact: true }).click();
    await expect(admin.getByLabel('资料文件（最多 25 MiB）')).toHaveCount(0);
    const linkedTitle = '合成本机真实发布外链资料';
    const externalUrl = 'https://example.test/catalog-native-synthetic-resource.pdf';
    await admin.getByRole('button', { name: '填写链接', exact: true }).click();
    await admin.getByLabel('资料标题', { exact: true }).fill(linkedTitle);
    await admin.getByLabel('关联课程（按课程号选择）').selectOption(fixture.course.id);
    await admin.getByLabel('资料链接', { exact: true }).fill(externalUrl);
    await admin.getByRole('button', { name: '加入本批', exact: true }).click();
    const materialsPublication = await previewAndPublish(admin, '学习资料');
    expect(materialsPublication.current.materials.revision).toBe(1);
    await expect.poll(async () => {
      const reply = await userContext.request.get(`/api/materials?q=${encodeURIComponent(title)}`);
      return reply.status() === 200 ? (await reply.json()).items.some(item => item.name === title) : false;
    }, { timeout: 25_000 }).toBe(true);
    await user.goto(`/materials?q=${encodeURIComponent(title)}`);
    await user.getByRole('link', { name: title, exact: true }).click();
    await expect(user.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect((await userContext.request.head(file.url)).status()).toBe(200);
    expect(await (await userContext.request.get(file.url)).body()).toEqual(pdf);
    const downloaded = user.waitForEvent('download');
    await user.getByRole('link', { name: '下载原件', exact: true }).click();
    expect(await readFile(await (await downloaded).path())).toEqual(pdf);
    await user.getByRole('button', { name: '收藏', exact: true }).click();
    await expect(user.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
    const publishedMaterials = await checkReply(await request.get(materialsPublication.current.materials.url));
    const material = publishedMaterials.materials.find(item => item.name === title);
    expect(material.downloadUrl).toBe(file.url);
    const linkedMaterial = publishedMaterials.materials.find(item => item.name === linkedTitle);
    expect(linkedMaterial.downloadUrl).toBe(externalUrl);
    expect(linkedMaterial.previewable).toBe(false);
    const linkedSearch = await checkReply(await userContext.request.get(`/api/materials?q=${encodeURIComponent(linkedTitle)}`));
    expect(linkedSearch.items.find(item => item.id === linkedMaterial.id).downloadUrl).toBe(externalUrl);
    await user.goto(`/materials/${linkedMaterial.id}`);
    await expect(user.getByRole('heading', { name: linkedTitle, exact: true })).toBeVisible();
    const externalAction = user.getByRole('link', { name: '打开资料链接 ↗', exact: true });
    await expect(externalAction).toHaveAttribute('href', externalUrl);
    await expect(externalAction).toHaveAttribute('target', '_blank');
    await expect(externalAction).toHaveAttribute('rel', 'noreferrer');
    await expect.poll(async () => (await (await request.get('/sitemap.xml')).text()).includes(`/materials/${material.id}`), { timeout: 25_000 }).toBe(true);
    const resolved = await checkReply(await userContext.request.post('/api/materials/resolve', { data: { ids: [fixture.existingMaterialId, material.id] } }));
    expect(resolved.items.find(item => item.materialId === material.id).material.name).toBe(title);
    expect(resolved.items.find(item => item.materialId === fixture.existingMaterialId).material).toBeTruthy();

    const baseline = await checkReply(await request.get(fixture.baseline.courses.fullUrl));
    const updatedTitle = `${fixture.course.title}（原生链路验收）`;
    const rows = exportCatalogRows('courses', baseline).filter(row => row.课程号 === fixture.course.id).map(row => ({ ...row, 课程名称: updatedTitle }));
    await admin.getByRole('navigation', { name: '目录类型' }).getByRole('button', { name: '课程与教学班' }).click();
    await admin.getByLabel('上传课程与教学班表格').setInputFiles({ name: '合成课程一致修改.csv', mimeType: 'text/csv', buffer: Buffer.from(writeCatalogCsv(rows, CATALOG_COLUMNS.courses)) });
    const coursesPublication = await previewAndPublish(admin, '课程与教学班');
    expect(coursesPublication.current.courses.revision).toBe(1);
    const full = await checkReply(await request.get(coursesPublication.current.courses.fullUrl));
    const core = await checkReply(await request.get(coursesPublication.current.courses.coreUrl));
    expect(full.catalogId).toBe(core.catalogId);
    expect(full.courses.find(item => item.id === fixture.course.id).title).toBe(updatedTitle);
    await user.goto(`/?view=catalog&course=${encodeURIComponent(fixture.course.id)}`);
    await expect(user.getByRole('heading', { name: updatedTitle, exact: true, level: 2 })).toBeVisible();

    await admin.getByText('发布记录与恢复版本', { exact: true }).click();
    const history = admin.locator('li').filter({ has: admin.getByRole('button', { name: '恢复此版本', exact: true }) })
      .filter({ hasText: '课程与教学班 · r0' });
    await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
    await admin.getByLabel('恢复原因（至少 8 个字）').fill('本机核对后恢复原有课程版本');
    const rolledReply = admin.waitForResponse(response => response.url().endsWith('/api/admin/catalog/rollback') && response.request().method() === 'POST');
    await admin.getByRole('dialog', { name: '确认恢复课程与教学班' }).getByRole('button', { name: '确认恢复此版本' }).click();
    const rolled = await checkReply(await rolledReply);
    expect(rolled.current.courses.version).toBe(fixture.baseline.courses.version);
    expect(rolled.current.courses.revision).toBe(2);
    expect((await checkReply(await request.get(coursesPublication.current.courses.fullUrl))).catalogId).toBe(full.catalogId);
    await user.goto(`/?view=catalog&course=${encodeURIComponent(fixture.course.id)}`);
    await expect(user.getByRole('heading', { name: fixture.course.title, exact: true, level: 2 })).toBeVisible();
    expect(await checkReply(await userContext.request.get('/api/auth/sync'))).toEqual(beforePersonal);
    const afterBookmarks = await checkReply(await userContext.request.get('/api/material-bookmarks'));
    expect(afterBookmarks.userId).toBe(fixture.seeds.user.id);
    expect(afterBookmarks.items.map(item => item.materialId)).toEqual(expect.arrayContaining([fixture.existingMaterialId, material.id]));
    const finalResolved = await checkReply(await userContext.request.post('/api/materials/resolve', { data: { ids: [material.id] } }));
    expect(finalResolved.items[0].material.downloadUrl).toBe(file.url);
    const materialRollback = await adminContext.request.post('/api/admin/catalog/rollback', {
      headers: { Origin: fixture.origin }, data: { kind: 'materials', targetVersion: fixture.baseline.materials.version,
        expectedRevision: 1, reason: '本机核对后恢复初始资料目录' } });
    await checkReply(materialRollback);
    await expect.poll(async () => (await (await request.get('/sitemap.xml')).text()).includes(`/materials/${material.id}`), { timeout: 25_000 }).toBe(false);
    expect((await (await request.get('/sitemap.xml')).text()).includes(`/materials/${linkedMaterial.id}`)).toBe(false);
    const removed = await checkReply(await userContext.request.post('/api/materials/resolve', { data: { ids: [material.id, linkedMaterial.id] } }));
    expect(removed.items.map(item => item.material)).toEqual([null, null]);
    const retained = await checkReply(await userContext.request.get('/api/material-bookmarks'));
    expect(retained.items.map(item => item.materialId)).toContain(material.id);
    expect(await (await request.get(file.url)).body()).toEqual(pdf);
    expect(await checkReply(await userContext.request.get('/api/auth/sync'))).toEqual(beforePersonal);
    expect(errors).toEqual([]);
    await user.screenshot({ path: testInfo.outputPath('native-user-course-rollback.png'), fullPage: true });
  } finally { await adminContext.close(); await userContext.close(); }
});
