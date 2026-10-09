import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import ts from "typescript";
import * as discoveryNavigation from "../app/discovery-navigation.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../app/teachers/TeacherExplorer.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/teachers/teachers.module.css", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (name) => {
    if (name.endsWith(".css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
    if (name === "../personal-course-context") return { loadPersonalCourseContext: async () => null };
    if (name === "../discovery-navigation") return discoveryNavigation;
    if (name === "../CourseReturnLink") return { useCourseReturn: () => null };
    if (name === "../PublicMasthead") return {
      PublicMasthead: ({ navigationLabel }) => createElement("nav", { "aria-label": navigationLabel }),
    };
    if (name === "next/link") return { __esModule: true, default: (props) => createElement("a", props) };
    return require(name);
  },
  componentModule,
  componentModule.exports,
);
const TeacherExplorer = componentModule.exports.TeacherExplorer;
const render = (props = {}) => renderToStaticMarkup(createElement(TeacherExplorer, props));
const ast = ts.createSourceFile("TeacherExplorer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") {
    effects.push({ body: node.arguments[0].getText(ast), dependencies: node.arguments[1]?.getText(ast) });
  }
  ts.forEachChild(node, visit);
}
visit(ast);

test("standalone teacher directory keeps its main landmark, masthead, hero and initial filters", () => {
  const html = render({ initialQuery: "李老师", initialCollege: " 会计学院 " });
  assert.match(html, /^<main class="page" id="main-content">/);
  assert.match(html, /<nav aria-label="教师页导航"/);
  assert.match(html, /<h1 id="teachers-title">教师评价<\/h1>/);
  assert.match(html, /同名教师请核对学院。/);
  assert.match(html, /id="teacher-name-query"[^>]*value="李老师"/);
  assert.match(html, /<option value="会计学院" selected="">会计学院<\/option>/);
});

test("embedded directory is a compact section with an accessible h2 and no duplicate page chrome", () => {
  const html = render({ embedded: true });
  assert.match(html, /^<section class="embedded">/);
  assert.match(html, /<section class="embeddedSearch"/);
  assert.match(html, /<h2 id="[^"]+" class="visuallyHidden">教师评价<\/h2>/);
  assert.match(html, /role="search" aria-label="全校教师搜索"/);
  assert.match(html, /按学院找老师/);
  assert.doesNotMatch(html, /<main\b|main-content|<nav\b|<h1\b|class="hero"|从学院找老师，或搜索全校姓名/);
});

test("embedded labels and regions use unique IDs even when mounted alongside another index", () => {
  const html = renderToStaticMarkup(createElement("main", null,
    createElement(TeacherExplorer, { embedded: true, initialQuery: "教师甲" }),
    createElement(TeacherExplorer, { embedded: true, initialQuery: "教师乙" }),
  ));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const references = [...html.matchAll(/(?:for|aria-labelledby)="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(references.every((id) => ids.includes(id)));
});

test("search notification uses the latest callback ref without making callback identity a search dependency", () => {
  assert.match(source, /onSearchChange\?: \(search: \{ q: string; college: string \}\) => void/);
  assert.match(source, /const onSearchChangeRef = useRef\(onSearchChange\)/);
  const update = effects.find((effect) => effect.body.includes("onSearchChangeRef.current = onSearchChange"));
  const notification = effects.find((effect) => effect.body.includes("onSearchChangeRef.current?.("));
  assert.equal(update?.dependencies, "[onSearchChange]");
  assert.equal(notification?.dependencies, "[requestQuery, college]");
  assert.ok(effects.indexOf(update) < effects.indexOf(notification));
  const request = effects.find((effect) => effect.body.includes("teachers_unavailable"));
  assert.ok(request);
  assert.doesNotMatch(request.body + request.dependencies, /onSearchChange|replaceState|embedded/);
});

test("only standalone mode owns history while all result links and pagination keep stable teacher IDs", () => {
  const history = effects.find((effect) => effect.body.includes("window.history.replaceState"));
  assert.match(history?.body ?? "", /^\(\) => \{\s*if \(embedded\) return;/);
  assert.equal(history?.dependencies, "[embedded, requestQuery, college]");
  assert.equal((source.match(/window\.history\.replaceState/g) ?? []).length, 1);
  assert.match(source, /<Link key=\{teacher\.id\} href=\{withCourseReturn\(`\/teachers\/\$\{teacher\.id\}`, courseReturn \?\? undefined\)\}/);
  assert.match(history.body, /safeCourseReturn/);
  assert.equal(discoveryNavigation.withCourseReturn("/teachers/exact-uuid"), "/teachers/exact-uuid");
  assert.match(source, /new Set\(current\.map\(\(teacher\) => teacher\.id\)\)/);
  for (const control of ["本学期教师", "返回学院索引", "重新读取学院", "重新读取更多教师"]) {
    assert.ok(source.includes(control));
  }
});

test("embedded styling is module-scoped, uses the agreed tokens, and retains touch and focus affordances", () => {
  const rules = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.includes(".embedded")) rules.push(rule);
  });
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.ok(rule.selectors.every((selector) => /^\.embedded(?:Search)?\b/.test(selector)), rule.selector);
  }
  const tokens = Object.fromEntries(rules.find((rule) => rule.selector === ".embedded").nodes
    .filter((node) => node.type === "decl").map(({ prop, value }) => [prop, value]));
  assert.deepEqual([tokens["--dufe-paper"], tokens["--dufe-paper-raised"], tokens["--dufe-ink"],
    tokens["--dufe-muted"], tokens["--dufe-red"], tokens["--dufe-line"]],
  ["#f4f1e9", "#fbfaf5", "#1d1b18", "#706a62", "#a52325", "#cec6ba"]);
  assert.match(tokens["--journal-display"], /var\(--journal-body/);
  assert.match(css, /\.embedded :is\(button, select, a\) \{[^}]*min-height: 44px;[^}]*min-width: 44px/);
  assert.match(css, /\.embedded :is\(button, select, a\):focus-visible \{[^}]*outline: 2px solid/);
});
