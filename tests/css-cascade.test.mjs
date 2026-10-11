import assert from "node:assert/strict";
import { test } from "node:test";
import postcss from "postcss";
import { readFile } from "node:fs/promises";

import {
  auditGlobalStylesheets,
  findEarlierExactDuplicates,
  findEarlierShadowedDeclarations,
  GLOBAL_STYLESHEETS,
} from "../scripts/audit-css-cascade.mjs";

test("global stylesheets do not repeat context-exact rules", async () => {
  for (const file of GLOBAL_STYLESHEETS) {
    const source = await readFile(file, "utf8");
    const root = postcss.parse(source, { from: file });
    const duplicates = findEarlierExactDuplicates(root);

    assert.deepEqual(
      duplicates.map((rule) => `${file}:${rule.source?.start?.line ?? 0} ${rule.selector}`),
      [],
    );
  }
});

test("cascade audit removes only declarations overridden by the same selector and context", () => {
  const roots = [
    {
      file: "first.css",
      root: postcss.parse(`
        .card { --tone: red; color: red; border: 1px solid; padding: 8px !important; }
        @media (max-width: 600px) { .card { color: green; } }
      `),
    },
    {
      file: "second.css",
      root: postcss.parse(`
        .card { --tone: black; color: black; border-color: black; padding: 12px; }
        @media (max-width: 700px) { .card { color: blue; } }
      `),
    },
  ];

  assert.deepEqual(
    findEarlierShadowedDeclarations(roots).map((declaration) =>
      declaration.toString(),
    ),
    ["color: red"],
  );
});

test("global stylesheets do not keep exactly shadowed declarations", async () => {
  const { duplicateRules, shadowedDeclarations } = await auditGlobalStylesheets(
    GLOBAL_STYLESHEETS,
  );

  assert.equal(duplicateRules.length, 0);
  assert.deepEqual(
    shadowedDeclarations.map(
      (declaration) =>
        `${declaration.source?.input.file}:${declaration.source?.start?.line ?? 0} ${declaration.prop}`,
    ),
    [],
  );
});
