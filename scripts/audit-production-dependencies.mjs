import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const EXCEPTION = Object.freeze({
  advisorySource: 1240992,
  advisoryUrl: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  expiresAt: "2026-11-04T00:00:00Z",
  packages: new Set([
    "braces",
    "fast-glob",
    "micromatch",
    "vinext",
    "vite-plugin-commonjs",
    "vite-plugin-dynamic-import",
  ]),
  lockedVersions: new Map([
    ["node_modules/braces", "3.0.3"],
    ["node_modules/micromatch", "4.0.8"],
    ["node_modules/vinext", "0.0.50"],
    ["node_modules/vite-plugin-commonjs", "0.10.4"],
    ["node_modules/vite-plugin-dynamic-import", "1.6.0"],
    ["node_modules/vite-plugin-dynamic-import/node_modules/fast-glob", "3.3.3"],
  ]),
});

function fail(message, details) {
  console.error(`[production-audit] ${message}`);
  if (details) console.error(details);
  process.exitCode = 1;
}

function severeVulnerabilities(report) {
  return Object.entries(report.vulnerabilities ?? {}).filter(([, vulnerability]) =>
    ["high", "critical"].includes(vulnerability.severity),
  );
}

function advisorySourcesFor(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const sources = new Set();
  for (const cause of vulnerabilities[name]?.via ?? []) {
    if (typeof cause === "string") {
      for (const source of advisorySourcesFor(cause, vulnerabilities, seen)) {
        sources.add(source);
      }
    } else if (Number.isInteger(cause?.source)) {
      sources.add(cause.source);
    }
  }
  return sources;
}

if (Date.now() >= Date.parse(EXCEPTION.expiresAt)) {
  fail(
    `The temporary ${EXCEPTION.advisoryUrl} exception expired at ${EXCEPTION.expiresAt}. ` +
      "Reassess upstream and remove or renew it explicitly.",
  );
} else {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    fail("Run this check through `npm run audit:production` so the npm CLI is known.");
  } else {
    const result = spawnSync(
      process.execPath,
      [npmCli, "audit", "--json", "--omit=dev", "--omit=optional", "--audit-level=high"],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );

    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch (error) {
      fail(
        "npm audit did not return valid JSON.",
        `${error instanceof Error ? error.message : error}\n${result.stderr}`,
      );
    }

    if (report) {
      const severe = severeVulnerabilities(report);
      const actualPackages = new Set(severe.map(([name]) => name));
      const missing = [...EXCEPTION.packages].filter((name) => !actualPackages.has(name));
      const unexpected = [...actualPackages].filter((name) => !EXCEPTION.packages.has(name));

      if (missing.length || unexpected.length) {
        fail(
          "The high/critical advisory set changed; review it instead of widening the exception.",
          JSON.stringify({ missing, unexpected }, null, 2),
        );
      } else {
        const unrelated = severe.filter(([name]) => {
          const sources = advisorySourcesFor(name, report.vulnerabilities);
          return sources.size !== 1 || !sources.has(EXCEPTION.advisorySource);
        });
        if (unrelated.length) {
          fail(
            "A high/critical finding is not solely caused by the approved advisory.",
            JSON.stringify(unrelated, null, 2),
          );
        }

        const advisory = report.vulnerabilities.braces?.via?.find(
          (cause) => typeof cause === "object" && cause.source === EXCEPTION.advisorySource,
        );
        if (
          advisory?.url !== EXCEPTION.advisoryUrl ||
          advisory?.name !== "braces" ||
          advisory?.severity !== "high" ||
          advisory?.range !== "<=3.0.3"
        ) {
          fail("The approved advisory metadata changed and needs a new review.");
        }

        const fixSuggestions = severe.map(([name, vulnerability]) => ({
          name,
          fixAvailable: vulnerability.fixAvailable,
        }));
        if (
          fixSuggestions.some(
            ({ fixAvailable }) =>
              fixAvailable?.name !== "vinext" ||
              fixAvailable?.version !== "0.0.15" ||
              fixAvailable?.isSemVerMajor !== true,
          )
        ) {
          fail(
            "npm now reports a different remediation; remove the exception and adopt the fix.",
            JSON.stringify(fixSuggestions, null, 2),
          );
        }

        const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url)));
        const versionChanges = [...EXCEPTION.lockedVersions].flatMap(([path, expected]) => {
          const actual = lockfile.packages?.[path]?.version;
          return actual === expected ? [] : [{ path, expected, actual }];
        });
        if (versionChanges.length) {
          fail(
            "The reviewed dependency versions changed.",
            JSON.stringify(versionChanges, null, 2),
          );
        }
      }

      if (!process.exitCode && result.status !== 1) {
        fail(`Expected npm audit to exit 1 for the reviewed advisory, got ${result.status}.`);
      }
      if (!process.exitCode) {
        console.log(
          `[production-audit] Only ${EXCEPTION.advisoryUrl} is present. ` +
            `Its build-only chain is removed from the runtime image; exception expires ${EXCEPTION.expiresAt}.`,
        );
      }
    }
  }
}
