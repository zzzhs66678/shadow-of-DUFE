import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

export const GLOBAL_STYLESHEETS = [
  "app/globals.css",
  "app/product-system.css",
  "app/red-access-system.css",
];

function ancestorContext(rule) {
  const ancestors = [];

  for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
    if (parent.type === "atrule") {
      ancestors.unshift(`@${parent.name} ${parent.params}`);
    } else if (parent.type === "rule") {
      ancestors.unshift(parent.selector);
    }
  }

  return ancestors.join("\n");
}

function fingerprint(rule) {
  return [
    ancestorContext(rule),
    rule.selector,
    rule.nodes.map((node) => node.toString()).join("\n"),
  ].join("\n---\n");
}

export function findEarlierExactDuplicates(root) {
  const groups = new Map();

  root.walkRules((rule) => {
    const key = fingerprint(rule);
    const rules = groups.get(key) ?? [];
    rules.push(rule);
    groups.set(key, rules);
  });

  return [...groups.values()].flatMap((rules) => rules.slice(0, -1));
}

export async function auditStylesheet(file, { fix = false } = {}) {
  const source = await readFile(file, "utf8");
  const root = postcss.parse(source, { from: file });
  const duplicates = findEarlierExactDuplicates(root);
  const findings = duplicates.map((rule) => ({
    line: rule.source?.start?.line ?? 0,
    selector: rule.selector,
  }));

  if (fix && duplicates.length > 0) {
    for (const rule of duplicates) {
      rule.remove();
    }
    await writeFile(file, root.toString(), "utf8");
  }

  return findings;
}

async function main() {
  const fix = process.argv.includes("--fix");
  let duplicateCount = 0;

  for (const file of GLOBAL_STYLESHEETS) {
    const findings = await auditStylesheet(file, { fix });
    duplicateCount += findings.length;

    for (const finding of findings) {
      console.log(`${file}:${finding.line} ${finding.selector.replaceAll("\n", " ")}`);
    }
  }

  if (duplicateCount === 0) {
    console.log("Global CSS cascade audit passed: no context-exact duplicate rules.");
    return;
  }

  if (fix) {
    console.log(`Removed ${duplicateCount} earlier context-exact duplicate rules.`);
    return;
  }

  console.error(
    `Global CSS cascade audit failed: ${duplicateCount} earlier context-exact duplicate rules. Run npm run audit:css -- --fix.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
