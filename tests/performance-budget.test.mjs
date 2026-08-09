import assert from "node:assert/strict";
import { stat, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

test("initial data and staging Web Vitals budgets stay explicit", async () => {
  const budget = JSON.parse(
    await readFile(new URL("performance-budgets.json", repositoryRoot), "utf8"),
  );
  const initialData = await stat(new URL(budget.initialRoute.path, repositoryRoot));
  const materials = await stat(
    new URL(budget.deferredMaterials.path, repositoryRoot),
  );

  assert.equal(budget.version, 1);
  assert.ok(
    initialData.size <= budget.initialRoute.maxBytes,
    `${budget.initialRoute.path} is ${initialData.size} bytes; budget is ${budget.initialRoute.maxBytes}`,
  );
  assert.ok(
    materials.size <= budget.deferredMaterials.maxBytes,
    `${budget.deferredMaterials.path} is ${materials.size} bytes; budget is ${budget.deferredMaterials.maxBytes}`,
  );
  assert.ok(
    budget.nextInitialDataTargetBytes <= 750_000,
    "the next initial data target must stay at or below 750 KB",
  );
  assert.deepEqual(budget.stagingWebVitals, {
    lcpMs: 2500,
    inpMs: 200,
    cls: 0.1,
  });
});
