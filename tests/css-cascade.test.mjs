import assert from "node:assert/strict";
import { test } from "node:test";
import postcss from "postcss";
import { readFile } from "node:fs/promises";

import {
  findEarlierExactDuplicates,
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
