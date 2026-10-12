import test from "node:test";
import assert from "node:assert/strict";
import { galleryDamp, galleryEndPadding, galleryGestureAxis, galleryLoopCamera, galleryLoopY, galleryNearest, gallerySpeeds, gallerySwipeStep, galleryTarget, galleryTouchTravel, galleryWrap } from "../app/campus-gallery.ts";

test("sideways touch browsing responds while mouse gestures retain vertical dragging", () => {
  assert.equal(galleryGestureAxis(-60, 4, true), "horizontal");
  assert.equal(galleryGestureAxis(-4, 60, true), "vertical");
  assert.equal(galleryGestureAxis(-60, 4, false), null);
  assert.equal(galleryGestureAxis(-60, 20, false), "vertical");
  assert.equal(galleryGestureAxis(3, -2, true), null);
  assert.ok(galleryTouchTravel(60, "horizontal") > 120);
  assert.ok(galleryTouchTravel(60, "vertical") >= 60);
  assert.equal(gallerySwipeStep(-60), 1);
  assert.equal(gallerySwipeStep(60), -1);
  assert.equal(gallerySwipeStep(-8), 0);
});

test("finite photo navigation finds the nearest layout landmark", () => {
  assert.equal(galleryNearest([], 0, 1000), 0);
  assert.equal(galleryNearest([480, 1480, 2480], 0, 1000), 0);
  assert.equal(galleryNearest([480, 1480, 2480], 1000, 1000), 1);
  assert.equal(galleryNearest([480, 1480, 2480], 99999, 1000), 2);
});
test("navigation handles staggered nonuniform photo positions", () => {
  const landmarks = Array.from({length:26}, (_, i) => 200 + i * 311);
  for (let slot = 0; slot < 26; slot++) {
    const top = galleryTarget(landmarks[slot], 390, 10000);
    assert.equal(galleryNearest(landmarks, top, 390), slot);
  }
  assert.equal(galleryNearest([500, 450, 1000], 20, 1000), 0);
});
test("native scroll targets stay within both ends of the gallery", () => {
  assert.equal(galleryTarget(100, 1000, 9000), 0);
  assert.equal(galleryTarget(1480, 1000, 9000), 1000);
  assert.equal(galleryTarget(20000, 1000, 9000), 9000);
  assert.equal(galleryTarget(1000, 1000, -100), 0);
  assert.equal(galleryEndPadding(1000, 200), 640);
  assert.equal(galleryEndPadding(1000, 800), 120);
});
test("loop wraps negative and multi-lap gestures without an end stop", () => {
  assert.equal(galleryWrap(-1, 26), 25);
  assert.equal(galleryWrap(26, 26), 0);
  assert.equal(galleryWrap(26 * 100 + 3, 26), 3);
  assert.equal(galleryWrap(9, 0), 0);
});
test("inertia keeps moving after input, converges and is frame-rate independent", () => {
  const first = galleryDamp(0, 350, 50);
  const second = galleryDamp(first, 350, 250);
  assert.ok(first > 50 && first < 200);
  assert.ok(second > first + 100 && second < 350);
  assert.ok(Math.abs(second - galleryDamp(0, 350, 300)) < .000001);
  assert.ok(Math.abs(galleryDamp(0, 350, 1400) - 350) < .02);
  assert.equal(galleryDamp(10, -20, 0), 10);
});
test("fast and slow photos travel at independently visible speeds", () => {
  const fast = galleryLoopY(1000, 300, 100, 10000, gallerySpeeds[0]) - galleryLoopY(1000, 300, 300, 10000, gallerySpeeds[0]);
  const slow = galleryLoopY(1000, 300, 100, 10000, gallerySpeeds[3]) - galleryLoopY(1000, 300, 300, 10000, gallerySpeeds[3]);
  assert.equal(fast, 260);
  assert.equal(slow, 140);
});
test("a loop seam teleports only when the photo is outside the viewport", () => {
  const before = galleryLoopY(100, 300, 399.9, 10000, .7);
  const after = galleryLoopY(100, 300, 400.1, 10000, .7);
  assert.ok(before + 300 < 1);
  assert.ok(after > 1000);
  assert.ok(Math.abs(galleryLoopY(100, 300, 500, 10000, .7) - galleryLoopY(100, 300, 10500, 10000, .7)) < .000001);
});
test("seeking centers the chosen photo on the closest lap at every speed", () => {
  for (const speed of gallerySpeeds) for (const near of [-100000, 0, 100000]) {
    const camera = galleryLoopCamera(2000, 400, 844, speed, 10000, near);
    assert.ok(Math.abs(galleryLoopY(2000, 400, camera, 10000, speed) + 200 - 844 * .48) < .000001);
    assert.ok(Math.abs(camera - near) <= 5000);
  }
});
