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

function contextAndSelector(rule) {
  return `${ancestorContext(rule)}\n---\n${rule.selector}`;
}

function effectiveDeclarations(rule) {
  const declarations = new Map();

  for (const node of rule.nodes) {
    if (node.type !== "decl") continue;
    if (node.prop.startsWith("--")) continue;

    const current = declarations.get(node.prop);
    if (!current || node.important || !current.important) {
      declarations.set(node.prop, node);
    }
  }

  return declarations;
}

export function findEarlierShadowedDeclarations(stylesheets) {
  const laterDeclarations = new Map();
  const shadowed = [];

  for (let sheetIndex = stylesheets.length - 1; sheetIndex >= 0; sheetIndex -= 1) {
    const rules = [];
    stylesheets[sheetIndex].root.walkRules((rule) => rules.push(rule));

    for (let ruleIndex = rules.length - 1; ruleIndex >= 0; ruleIndex -= 1) {
      const rule = rules[ruleIndex];
      const key = contextAndSelector(rule);
      const laterByProperty = laterDeclarations.get(key) ?? new Map();

      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        if (node.prop.startsWith("--")) continue;

        const later = laterByProperty.get(node.prop);
        if (later && (!node.important || later.important)) {
          shadowed.push(node);
        }
      }

      for (const [property, declaration] of effectiveDeclarations(rule)) {
        const later = laterByProperty.get(property);
        if (!later || (declaration.important && !later.important)) {
          laterByProperty.set(property, declaration);
        }
      }

      laterDeclarations.set(key, laterByProperty);
    }
  }

  return shadowed;
}

async function loadStylesheets(files) {
  return Promise.all(
    files.map(async (file) => ({
      file,
      root: postcss.parse(await readFile(file, "utf8"), { from: file }),
    })),
  );
}

export async function auditGlobalStylesheets(files, { fix = false } = {}) {
  const stylesheets = await loadStylesheets(files);
  const duplicateRules = stylesheets.flatMap(({ root }) =>
    findEarlierExactDuplicates(root),
  );

  if (fix) {
    for (const rule of duplicateRules) {
      rule.remove();
    }
  }

  const shadowedDeclarations = findEarlierShadowedDeclarations(stylesheets);

  if (fix) {
    const affectedRules = new Set(shadowedDeclarations.map((node) => node.parent));
    for (const declaration of shadowedDeclarations) {
      declaration.remove();
    }
    for (const rule of affectedRules) {
      if (rule && rule.nodes.every((node) => node.type === "comment")) {
        rule.remove();
      }
    }
    await Promise.all(
      stylesheets.map(({ file, root }) => writeFile(file, root.toString(), "utf8")),
    );
  }

  return { duplicateRules, shadowedDeclarations };
}

async function main() {
  const fix = process.argv.includes("--fix");
  const { duplicateRules, shadowedDeclarations } = await auditGlobalStylesheets(
    GLOBAL_STYLESHEETS,
    { fix },
  );
  const findingCount = duplicateRules.length + shadowedDeclarations.length;

  if (findingCount === 0) {
    console.log(
      "Global CSS cascade audit passed: no context-exact duplicate rules or exactly shadowed declarations.",
    );
    return;
  }

  if (fix) {
    console.log(
      `Removed ${duplicateRules.length} earlier context-exact duplicate rules and ${shadowedDeclarations.length} exactly shadowed declarations.`,
    );
    return;
  }

  console.error(
    `Global CSS cascade audit failed: ${duplicateRules.length} duplicate rules and ${shadowedDeclarations.length} exactly shadowed declarations. Run npm run audit:css -- --fix.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
