import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Result } from "axe-core";

const blockingImpacts = new Set(["critical", "serious"]);

const routes = [
  { name: "study desk", path: "/", waitsForData: true },
  { name: "materials", path: "/materials" },
  { name: "community", path: "/community" },
  { name: "teachers", path: "/teachers" },
  { name: "privacy", path: "/privacy" },
  { name: "terms", path: "/terms" },
  { name: "account deletion", path: "/account/delete" },
  { name: "administrator entry", path: "/admin" },
] as const;

const formatViolations = (violations: Result[]) =>
  violations
    .map(
      (violation) =>
        `[${violation.impact}] ${violation.id}: ${violation.help}\n` +
        `  ${violation.helpUrl}\n` +
        violation.nodes
          .map((node) => `  - ${JSON.stringify(node.target)}`)
          .join("\n"),
    )
    .join("\n\n");

for (const route of routes) {
  test(`${route.name} has no critical or serious axe violations`, async ({
    page,
  }) => {
    await page.goto(route.path, { waitUntil: "domcontentloaded" });

    if ("waitsForData" in route && route.waitsForData) {
      await page
        .locator("main:not(.data-loading)")
        .waitFor({ state: "visible", timeout: 30_000 });
    } else {
      await expect(page.locator("main")).toBeVisible();
    }

    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter(
      (violation) =>
        typeof violation.impact === "string" &&
        blockingImpacts.has(violation.impact),
    );

    expect(blocking, formatViolations(blocking)).toEqual([]);
  });
}
