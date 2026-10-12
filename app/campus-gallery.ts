/** Geometry shared by the inertial loop and its reduced-motion native fallback. */
export const gallerySpeeds = [1.3, .8, 1.15, .7, 1.25, .85] as const;

export type GalleryGestureAxis = "horizontal" | "vertical";

/** Touch supports a sideways browse gesture; mouse dragging stays vertical. */
export function galleryGestureAxis(dx: number, dy: number, touch: boolean): GalleryGestureAxis | null {
  if (touch) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return null;
    return Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
  }
  return Math.abs(dy) > 7 ? "vertical" : null;
}

export function galleryTouchTravel(distance: number, axis: GalleryGestureAxis) {
  return distance * (axis === "horizontal" ? 2.2 : 1.35);
}

/** A short intentional sideways swipe advances one photo, in either direction. */
export function gallerySwipeStep(dx: number) {
  return Math.abs(dx) >= 32 ? (dx < 0 ? 1 : -1) : 0;
}

export function galleryWrap(value: number, cycle: number) {
  return cycle > 0 ? ((value % cycle) + cycle) % cycle : 0;
}

export function galleryDamp(current: number, target: number, elapsed: number) {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, elapsed) / 140));
}

/** The seam is above the viewport; speed changes never accumulate across laps. */
export function galleryLoopY(top: number, height: number, camera: number, cycle: number, speed: number) {
  return galleryWrap(top - camera + height, cycle) * speed - height;
}

/** Seek the nearest lap that puts this photograph at the viewport's visual center. */
export function galleryLoopCamera(top: number, height: number, viewport: number, speed: number, cycle: number, near: number) {
  const camera = top + height - (viewport * .48 + height / 2) / speed;
  return cycle > 0 ? camera + Math.round((near - camera) / cycle) * cycle : camera;
}

export function galleryNearest(centers: readonly number[], top: number, viewport: number) {
  if (!centers.length) return 0;
  const camera = top + viewport * .48;
  let nearest = 0;
  centers.forEach((center, index) => {
    if (Math.abs(center - camera) < Math.abs(centers[nearest] - camera)) nearest = index;
  });
  return nearest;
}

export function galleryTarget(center: number, viewport: number, max: number) {
  return Math.max(0, Math.min(Math.max(0, max), center - viewport * .48));
}

export function galleryEndPadding(viewport: number, lastHeight: number) {
  return Math.max(viewport * .12, viewport * .84 - lastHeight);
}
