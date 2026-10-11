import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { competitions, competitionPath, findCompetition } from "../app/competitions/catalog.ts";

test("competition entries keep the six supplied notices correctly associated", () => {
  const expected = {
    "dalian-math": "98343", "national-math": "100842", "math-modeling": "99407",
    cet: "99365", advertising: "98729", neccs: "97272",
  };
  assert.equal(competitions.length, 6);
  assert.equal(new Set(competitions.map(item => item.slug)).size, 6);
  for (const item of competitions) {
    assert.equal(item.notice.url, `https://jwc.dufe.edu.cn/content_${expected[item.slug]}.html`);
    assert.match(item.notice.publishedAt, /^2026-\d{2}-\d{2}$/);
    assert.equal(competitionPath(item.slug), `/competitions/${item.slug}`);
    assert.equal(findCompetition(item.slug), item);
  }
  assert.equal(findCompetition("missing"), undefined);
  assert.equal(findCompetition("__proto__"), undefined);
  assert.match(findCompetition("cet").notice.title, /考生须知/);
  assert.match(findCompetition("neccs").notice.title, /初赛考生须知/);
});

test("only supplied resources get downloads, with byte-verified packaged content", async () => {
  const resources = competitions.flatMap(item => item.resources);
  assert.equal(resources.length, 1);
  const [resource] = resources;
  assert.match(resource.href, /^\/assets\/competitions\/[a-z0-9.-]+\.zip$/);
  const archive = await readFile(new URL(`../public${resource.href}`, import.meta.url));
  assert.equal(archive.subarray(0, 4).toString("hex"), "504b0304");
  assert.equal(archive.length, resource.sizeBytes);
  assert.equal(createHash("sha256").update(archive).digest("hex"), resource.sha256);
  assert.equal(resource.filename, "大连市数学竞赛试题.zip");
});

test("the personal-page entry follows the plugin and removed room copy stays absent", async () => {
  const app = await readFile(new URL("../app/DufeHubV2.tsx", import.meta.url), "utf8");
  assert.ok(app.indexOf('<CompetitionsGateway />') > app.indexOf('id="ginkgo-plugin-title"'));
  assert.ok(app.indexOf('<CompetitionsGateway />') < app.indexOf('<CampusAlmanac />'));
  assert.doesNotMatch(app, /按课表推算，是否开放以现场为准/);
});
