import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as catalog from "../app/competitions/catalog.ts";

// Render the actual presentation in memory, without a build or preview server.
const require = createRequire(import.meta.url);
const loaded = new Map();
const root = new URL("../app/competitions/", import.meta.url);
function loadComponent(relativePath) {
  const url = new URL(relativePath, root);
  if (loaded.has(url.href)) return loaded.get(url.href);
  const source = readFileSync(url, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const componentModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name.endsWith(".css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
    if (name.endsWith("/catalog")) return catalog;
    if (name === "next/link") return { __esModule: true, default: (props) => createElement("a", props) };
    if (name.startsWith(".")) return loadComponent(new URL(`${name}.tsx`, url));
    return require(name);
  }, componentModule, componentModule.exports);
  loaded.set(url.href, componentModule.exports);
  return componentModule.exports;
}

const { default: Index } = loadComponent("page.tsx");
const { default: Detail } = loadComponent("[slug]/page.tsx");
const { CompetitionsGateway } = loadComponent("CompetitionsGateway.tsx");
const { StudyDoodle } = loadComponent("StudyDoodle.tsx");
const render = (component) => renderToStaticMarkup(createElement(component));

test("the compact gateway remains one link and does not expand the catalog", () => {
  const html = render(CompetitionsGateway);
  assert.equal((html.match(/<a\b/g) ?? []).length, 1);
  assert.match(html, /id="competitions-entry"/);
  assert.match(html, /aria-label="查看学科考试及竞赛"/);
  assert.match(html, /href="\/competitions"/);
  for (const item of catalog.competitions) assert.ok(!html.includes(item.title));
});

test("the ticket index groups each real entry once and preserves original dates", () => {
  const html = render(Index);
  assert.equal((html.match(/<ul\b/g) ?? []).length, 3);
  assert.equal((html.match(/<li\b/g) ?? []).length, catalog.competitions.length);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  for (const category of ["数学", "英语", "创意设计"]) {
    const section = html.match(new RegExp(`<section[^>]+aria-labelledby="subject-${category}"[^>]*>(.*?)</section>`))?.[1];
    assert.ok(section, category);
    const items = catalog.competitions.filter(item => item.category === category);
    assert.equal((section.match(/<li\b/g) ?? []).length, items.length);
    for (const item of items) {
      assert.ok(section.includes(`href="${catalog.competitionPath(item.slug)}"`));
      assert.ok(section.includes(`<h3>${item.title}</h3>`));
      assert.ok(section.includes(`<time dateTime="${item.notice.publishedAt}">${item.notice.publishedAt}</time>`));
    }
  }
  assert.match(html, /href="\/\?view=me#competitions-entry"/);
  assert.match(html, /返回我的/);
  assert.match(html, /通知保留原发布日期/);
  assert.equal((html.match(/class="resourceTag"/g) ?? []).length, 1);
});

for (const item of catalog.competitions) {
  test(`detail keeps parent navigation, original notice and resource semantics: ${item.slug}`, async () => {
    const html = renderToStaticMarkup(await Detail({ params: Promise.resolve({ slug: item.slug }) }));
    assert.ok(html.includes(`<h1>${item.title}</h1>`));
    assert.match(html, /href="\/competitions"/);
    assert.match(html, /返回考试及竞赛/);
    assert.ok(html.includes(`href="${item.notice.url}" target="_blank" rel="noopener noreferrer"`));
    assert.ok(html.includes(item.notice.title));
    assert.ok(html.includes(`<time dateTime="${item.notice.publishedAt}">${item.notice.publishedAt}</time>`));
    assert.equal((html.match(/ download=/g) ?? []).length, item.resources.length);
    for (const resource of item.resources) {
      assert.ok(html.includes(`href="${resource.href}" download="${resource.filename}"`));
      assert.ok(html.includes(resource.description));
    }
    if (!item.resources.length) assert.match(html, /暂无资料。/);
  });
}

test("the small original paper marks stay decorative and make no image requests", () => {
  for (const kind of ["overview", "数学", "英语", "创意设计"]) {
    const html = renderToStaticMarkup(createElement(StudyDoodle, { kind }));
    assert.match(html, /viewBox="0 0 96 96"/);
    assert.match(html, /aria-hidden="true" focusable="false"/);
    assert.doesNotMatch(html, /<image|<text|https?:|rotate\(/);
  }
});
