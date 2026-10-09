import assert from "node:assert/strict";
import test from "node:test";
import { readDiscovery, roomContextUrl, safeCourseReturn, withCourseReturn } from "../app/discovery-navigation.ts";
test("room drill-down preserves independent exact identities and room context", () => {
  const url = roomContextUrl("https://dufesh.cn/?view=rooms&v=preview", { building: "之远楼", date: "2026-10-09", block: 3, floor: "10", term: "fall" });
  url.searchParams.set("room", "之远楼|1010");
  url.searchParams.set("course", "001"); url.searchParams.set("meeting", "fall-001-02-3");
  assert.deepEqual(readDiscovery(url.search), { room: "之远楼|1010", course: "001", meeting: "fall-001-02-3", building: "之远楼", date: "2026-10-09", block: 3, floor: "10", term: "fall" });
  assert.equal(url.searchParams.get("v"), "preview");
  assert.equal(readDiscovery("?view=rooms&room=bad&room-block=99").room, "");
});
test("nested public pages only accept a local course return path", () => {
  const returnTo = "/?view=rooms&room=a%7C102&course=001&meeting=exact";
  assert.equal(safeCourseReturn(returnTo), returnTo);
  for (const value of ["https://evil.test/?course=001", "//evil.test/?course=001", "/admin?course=001", "/?view=rooms", "/?course=001\\evil", "javascript:alert(1)"]) assert.equal(safeCourseReturn(value), null);
  const href = withCourseReturn("/teachers/exact?panel=teaching", returnTo);
  assert.equal(new URL(href, "https://dufesh.cn").searchParams.get("returnTo"), returnTo);
  assert.equal(withCourseReturn("https://external.test", returnTo), "https://external.test");
});
