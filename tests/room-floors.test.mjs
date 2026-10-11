import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { groupRoomsByFloor, roomFloor } from "../app/room-floors.ts";

test("room floors preserve multi-digit floors, wings and catalog-separated labels", () => {
  const cases = {
    "102": "1", "916": "9", "1010": "10", "1014": "10", "1015": "10",
    "1101": "11", "2014": "20", "E101": "1", "W101": "1", "E201": "2",
    "J4-3": "4", " e101 ": "1", "Ｅ１０１": "1", "１０１４": "10",
  };
  for (const [room, floor] of Object.entries(cases)) assert.equal(roomFloor(room), floor, room);
});

test("unknown labels never guess a floor from unrelated numbers", () => {
  for (const room of ["", "报告厅", "体育场2", "之远楼(5#)1010", "1010/1014", "12345", "B1", "1", "01", "000", "J4-3-2"]) {
    assert.equal(roomFloor(room), "?", room);
  }
});

test("floor grouping sorts numerically, preserves room identities and leaves its input unchanged", () => {
  const rooms = Object.freeze(["1014", "W101", "916", "1101", "E101", "102", "1010", "1014", "报告厅"]);
  assert.deepEqual(groupRoomsByFloor(rooms), [
    ["11", ["1101"]], ["10", ["1010", "1014"]], ["9", ["916"]],
    ["1", ["102", "E101", "W101"]], ["?", ["报告厅"]],
  ]);
});

test("the real five-building catalog separates 之远楼 10F from 1F without dropping rooms", async () => {
  const data = JSON.parse(await readFile(new URL("../public/data/course-data.json", import.meta.url), "utf8"));
  for (const building of data.buildings) {
    const rooms = [...new Set(data.schedules.filter(row => row.building === building).map(row => row.room))];
    const grouped = groupRoomsByFloor(rooms);
    assert.equal(grouped.some(([floor]) => floor === "?"), false, building);
    assert.deepEqual(new Set(grouped.flatMap(([, floorRooms]) => floorRooms)), new Set(rooms), building);
    if (building === "之远楼") {
      const floors = new Map(grouped);
      assert.deepEqual(floors.get("10"), ["1010", "1014", "1015"]);
      assert.ok(floors.get("1").includes("E101"));
      assert.ok(floors.get("1").includes("W101"));
      assert.ok(floors.get("1").every(room => roomFloor(room) === "1"));
      assert.equal(grouped[0][0], "10");
    }
  }
});

test("floor availability lives in a single rail instead of a duplicate bottom overview", async () => {
  const source = await readFile(new URL("../app/DufeHubV2.tsx", import.meta.url), "utf8");
  assert.match(source, /roomFilterStyles\.floorAvailability/);
  assert.match(source, /共 \$\{floorRooms\.length\} 间/);
  assert.doesNotMatch(source, /floor-overview|整栋楼一览/);
  for (const file of ["globals.css", "product-system.css"]) {
    const styles = await readFile(new URL(`../app/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(styles, /floor-overview/);
  }
});
