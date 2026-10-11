import assert from "node:assert/strict";
import test from "node:test";

import { validateTeacherReviewWrite } from "../src/teacher-review-contract.mjs";

const ratings = {
  courseOrganization: 1,
  contentClarity: 2,
  assessmentExplanation: 3,
  classroomInteraction: 4,
  materialCompleteness: 5,
};

test("teacher reviews accept normalized 1–3000 character text without manufacturing ratings", () => {
  for (const body of ["好", "字".repeat(3000)]) {
    for (const optionalRatings of [{}, { ratings: null }]) {
      assert.deepEqual(validateTeacherReviewWrite({ body, ...optionalRatings }), {
        body, ratings: null, expectedVersion: null,
      });
      assert.deepEqual(validateTeacherReviewWrite({ body, ...optionalRatings, expectedVersion: 7 }), {
        body, ratings: null, expectedVersion: 7,
      });
    }
  }
  assert.deepEqual(validateTeacherReviewWrite({ body: " \r\nＡ\r\n好 \t" }), {
    body: "A\n好", ratings: null, expectedVersion: null,
  });
  for (const body of ["", " \t\r\n", "字".repeat(3001), "好\u0000", "好\u007f", null, 1]) {
    assert.equal(validateTeacherReviewWrite({ body }), null);
  }
});

test("legacy clients may send exactly five integer ratings in the original 1–5 range", () => {
  assert.deepEqual(validateTeacherReviewWrite({ body: "好", ratings, expectedVersion: 2 }), {
    body: "好", ratings, expectedVersion: 2,
  });
  const keys = Object.keys(ratings);
  for (let mask = 0; mask < 31; mask += 1) {
    const partial = Object.fromEntries(keys.filter((_, index) => mask & (1 << index)).map((key) => [key, ratings[key]]));
    assert.equal(validateTeacherReviewWrite({ body: "好", ratings: partial }), null);
  }
  for (const key of keys) {
    for (const invalid of [null, undefined, 0, 6, -1, 1.5, "3", true, NaN, Infinity]) {
      assert.equal(validateTeacherReviewWrite({ body: "好", ratings: { ...ratings, [key]: invalid } }), null);
    }
  }
  for (const invalid of [[], 3, "3", false, { ...ratings, extra: 3 }]) {
    assert.equal(validateTeacherReviewWrite({ body: "好", ratings: invalid }), null);
  }
});

test("text-only input retains strict version and mass-assignment checks", () => {
  for (const expectedVersion of [0, -1, 1.5, "1", true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateTeacherReviewWrite({ body: "好", expectedVersion }), null);
  }
  for (const extra of [{ status: "published" }, { userId: "other" }, { version: 1 }]) {
    assert.equal(validateTeacherReviewWrite({ body: "好", ...extra }), null);
  }
  for (const invalid of [null, [], "好"]) assert.equal(validateTeacherReviewWrite(invalid), null);
});
