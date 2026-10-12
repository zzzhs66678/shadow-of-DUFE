"use client";

import { useEffect, useRef, type RefObject } from "react";
import { galleryDamp, galleryEndPadding, galleryGestureAxis, galleryLoopCamera, galleryLoopY, galleryNearest, gallerySpeeds, gallerySwipeStep, galleryTarget, galleryTouchTravel, galleryWrap, type GalleryGestureAxis } from "./campus-gallery";

type Motion = { seek: (slot: number, instant?: boolean) => void; nudge: (distance: number) => void; freeze: () => void; pause: (value: boolean) => void };
type Elements = {
  open: boolean;
  mode: string;
  scroll: RefObject<HTMLDivElement | null>;
  canvas: RefObject<HTMLDivElement | null>;
  tiles: RefObject<(HTMLDivElement | null)[]>;
  photos: RefObject<(HTMLButtonElement | null)[]>;
  active: RefObject<number>;
  onActive: (slot: number) => void;
};

/** Scoped to the deliberately opened gallery; the surrounding page keeps native input. */
export function useCampusMotion({ open, mode, scroll, canvas, tiles, photos, active, onActive }: Elements) {
  const controller = useRef<Motion | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    if (!open || !scroll.current || !canvas.current) return;
    const port = scroll.current, stage = canvas.current;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, previousTime = 0, measured = false, dirty = true, paused = false;
    let width = 0, height = 0, cycle = 0, camera = 0, target = 0;
    let tops: number[] = [], heights: number[] = [], visible: boolean[] = [];
    let pointer: { id: number; touch: boolean; startX: number; startY: number; lastX: number; lastY: number; slot: number; axis: GalleryGestureAxis | null } | null = null;
    // A narrow screen uses one staggered stream: differing speeds would make
    // its large photographs overtake and cover each other. Inertia stays on.
    const speed = (slot: number) => width <= 760 ? 1 : gallerySpeeds[slot % gallerySpeeds.length];
    const reveals = new Map<number, Animation[]>();
    const cancelReveals = () => { reveals.forEach(list => list.forEach(animation => animation.cancel())); reveals.clear(); };
    const announce = (slot: number) => { if (active.current !== slot) { active.current = slot; onActive(slot); } };
    const seek = (value: number, instant = false) => {
      const slot = galleryWrap(Math.round(value), photos.current.length);
      if (media.matches) {
        const landmark = tops[slot] + heights[slot] / 2;
        port.scrollTo({ top: slot === 0 ? 0 : galleryTarget(landmark, height, port.scrollHeight - height), behavior: "instant" });
      } else {
        target = galleryLoopCamera(tops[slot], heights[slot], height, speed(slot), cycle, camera);
        if (instant) camera = target;
      }
      queue();
    };
    const measure = () => {
      const changed = width !== port.clientWidth || height !== port.clientHeight;
      width = port.clientWidth; height = port.clientHeight;
      // Read layout in one batch. Per-frame loop projection uses only these cached numbers.
      tops = tiles.current.map(tile => (tile?.offsetTop ?? 0) + stage.offsetTop);
      heights = photos.current.map(photo => photo?.offsetHeight ?? 0);
      const gap = parseFloat(getComputedStyle(stage).rowGap) || height * .12;
      cycle = (tops.at(-1) ?? 0) + (heights.at(-1) ?? 0) + gap;
      stage.style.paddingBottom = media.matches ? galleryEndPadding(height, heights.at(-1) ?? 0) + "px" : "0px";
      port.dataset.motion = media.matches ? "reduced" : "loop";
      port.dataset.cycle = String(cycle);
      if (!measured || changed) {
        if (media.matches) {
          photos.current.forEach(photo => { if (photo) { photo.style.transform = "none"; photo.style.opacity = "1"; } });
          const landmark = tops[active.current] + heights[active.current] / 2;
          port.scrollTo({ top: active.current === 0 ? 0 : galleryTarget(landmark, height, port.scrollHeight - height), behavior: "instant" });
        } else {
          port.scrollTop = 0;
          camera = target = galleryLoopCamera(tops[active.current], heights[active.current], height, speed(active.current), cycle, camera);
        }
      }
      measured = true; dirty = false;
    };
    const reveal = (slot: number, shown: boolean, delay: number) => {
      if (visible[slot] === shown) return;
      visible[slot] = shown;
      reveals.get(slot)?.forEach(animation => animation.cancel()); reveals.delete(slot);
      const photo = photos.current[slot];
      if (!photo) return;
      photo.dataset.visible = String(shown);
      photo.style.opacity = shown ? "1" : "0";
      if (shown && !media.matches) {
        const list = [photo.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" })];
        const image = photo.querySelector("img");
        if (image) list.push(image.animate([{ transform: "scale(1.16)" }, { transform: "scale(1.08)" }], { duration: 1100, delay, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" }));
        reveals.set(slot, list);
      }
    };
    const paint = (time: number) => {
      frame = 0;
      if (dirty || width !== port.clientWidth || height !== port.clientHeight) measure();
      const elapsed = previousTime ? Math.min(64, time - previousTime) : 16;
      previousTime = time;
      if (media.matches) {
        announce(port.scrollTop <= 2 ? 0 : galleryNearest(tops.map((top, slot) => top + heights[slot] / 2), port.scrollTop, height));
        port.dataset.camera = String(port.scrollTop); port.dataset.animating = "false";
        return;
      }
      if (!paused && !document.hidden) camera = galleryDamp(camera, target, elapsed);
      if (Math.abs(target - camera) < .1) camera = target;
      // Rebase at very large values without changing any displayed position.
      if (Math.abs(camera) > cycle * 100) { const laps = Math.trunc(camera / cycle) * cycle; camera -= laps; target -= laps; }
      const projections = photos.current.map((photo, slot) => ({ photo, slot, y: galleryLoopY(tops[slot], heights[slot], camera, cycle, speed(slot)) }));
      let nearest = 0, distance = Infinity;
      const entries = projections.filter(({ slot, y }) => y < height + 40 && y + heights[slot] > -40).sort((a, b) => a.y - b.y);
      projections.forEach(({ photo, slot, y }) => {
        if (!photo) return;
        photo.style.transform = `translate3d(0, ${y - tops[slot]}px, 0)`;
        const next = Math.abs(y + heights[slot] / 2 - height * .48);
        if (next < distance) { nearest = slot; distance = next; }
        if (!entries.some(entry => entry.slot === slot)) reveal(slot, false, 0);
      });
      entries.forEach(({ slot }, order) => reveal(slot, true, order * 100));
      announce(nearest);
      port.dataset.camera = String(camera); port.dataset.target = String(target);
      const moving = !paused && !document.hidden && Math.abs(target - camera) > .1;
      port.dataset.animating = String(moving);
      if (moving) queue(); else previousTime = 0;
    };
    function queue() { if (!frame) frame = window.requestAnimationFrame(paint); }
    const nudge = (distance: number) => {
      if (paused) return;
      if (media.matches) port.scrollBy({ top: distance, behavior: "instant" });
      else { target += distance; port.dataset.animating = "true"; queue(); }
    };
    const freeze = () => { pointer = null; target = camera; window.cancelAnimationFrame(frame); frame = 0; previousTime = 0; port.dataset.animating = "false"; };
    controller.current = { seek, nudge, freeze, pause: value => { paused = value; if (value) freeze(); else queue(); } };
    const wheel = (event: WheelEvent) => {
      if (media.matches || paused || event.ctrlKey) return;
      event.preventDefault();
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      nudge(delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1));
    };
    const down = (event: PointerEvent) => {
      const touch = event.pointerType === "touch";
      if ((media.matches && !touch) || paused || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      if (touch) freeze();
      pointer = { id: event.pointerId, touch, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, slot: active.current, axis: null };
      dragged.current = false;
    };
    const move = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId || paused) return;
      const firstMove = pointer.axis === null;
      pointer.axis ??= galleryGestureAxis(event.clientX - pointer.startX, event.clientY - pointer.startY, pointer.touch);
      if (!pointer.axis) return;
      // Reduced motion keeps vertical touch scrolling entirely native. CSS
      // pan-y lets the browser cancel this pointer when it starts scrolling.
      if (media.matches && pointer.axis === "vertical") { pointer = null; return; }
      dragged.current = true;
      if (!port.hasPointerCapture(event.pointerId)) port.setPointerCapture(event.pointerId);
      const distance = pointer.axis === "horizontal"
        ? (firstMove ? pointer.startX : pointer.lastX) - event.clientX
        : (firstMove ? pointer.startY : pointer.lastY) - event.clientY;
      if (pointer.touch) {
        const travel = galleryTouchTravel(distance, pointer.axis);
        if (media.matches) port.scrollBy({ top: travel, behavior: "instant" });
        else {
          // Finger travel paints directly, without the wheel/mouse damping
          // delay. The release seek retains the existing gentle settling.
          camera = target = target + travel;
          queue();
        }
      } else {
        nudge(distance);
      }
      pointer.lastX = event.clientX; pointer.lastY = event.clientY;
    };
    const up = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const completed = pointer; pointer = null;
      if (event.type === "pointercancel" || paused || !completed.touch || completed.axis !== "horizontal") return;
      const step = gallerySwipeStep(event.clientX - completed.startX);
      if (step) seek(completed.slot + step, media.matches);
    };
    const click = (event: MouseEvent) => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); dragged.current = false; } };
    const focus = (event: FocusEvent) => {
      if (paused || media.matches || !(event.target instanceof HTMLElement)) return;
      const tile = event.target.closest<HTMLElement>("[data-slot]");
      const slot = Number(tile?.dataset.slot);
      if (tile && !visible[slot]) seek(slot, true);
      port.scrollTop = 0;
    };
    const refresh = () => { pointer = null; dirty = true; measured = false; cancelReveals(); visible = []; queue(); };
    const nativeScroll = () => { if (media.matches) queue(); else if (port.scrollTop) { port.scrollTop = 0; queue(); } };
    const observer = new ResizeObserver(() => { dirty = true; queue(); }); observer.observe(port); observer.observe(stage);
    port.addEventListener("wheel", wheel, { passive: false });
    port.addEventListener("pointerdown", down); port.addEventListener("pointermove", move);
    port.addEventListener("pointerup", up); port.addEventListener("pointercancel", up);
    port.addEventListener("click", click, true); port.addEventListener("focusin", focus);
    port.addEventListener("scroll", nativeScroll, { passive: true });
    media.addEventListener("change", refresh); document.addEventListener("visibilitychange", queue);
    queue();
    return () => {
      freeze(); cancelReveals(); observer.disconnect(); controller.current = null;
      port.removeEventListener("wheel", wheel); port.removeEventListener("pointerdown", down); port.removeEventListener("pointermove", move);
      port.removeEventListener("pointerup", up); port.removeEventListener("pointercancel", up); port.removeEventListener("click", click, true);
      port.removeEventListener("focusin", focus); port.removeEventListener("scroll", nativeScroll);
      media.removeEventListener("change", refresh); document.removeEventListener("visibilitychange", queue);
    };
  }, [open, scroll, canvas, tiles, photos, active, onActive]);

  useEffect(() => { controller.current?.pause(mode !== "walk"); }, [mode, open]);
  return controller;
}

/** A short reveal, then scroll/pointer-driven motion only—never an unattended loop. */
export function useCampusEntry(open: boolean) {
  const entry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = entry.current;
    if (!node || open) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const frames = [...node.querySelectorAll<HTMLElement>("[data-slot]")];
    const animations: Animation[] = [];
    let frame = 0, nearby = false, top = 0, height = 0, pointerX = 0, pointerY = 0, x = 0, y = 0, travel = 0, last = 0;
    const measure = () => { const rect = node.getBoundingClientRect(); top = rect.top + window.scrollY; height = rect.height; queue(); };
    const paint = (time: number) => {
      frame = 0;
      if (!nearby || media.matches || document.hidden) return;
      const elapsed = last ? Math.min(64, time - last) : 16; last = time;
      const goal = Math.max(-1, Math.min(1, (window.scrollY + window.innerHeight * .5 - top - height / 2) / window.innerHeight)) * 80;
      x = galleryDamp(x, pointerX, elapsed); y = galleryDamp(y, pointerY, elapsed); travel = galleryDamp(travel, goal, elapsed);
      frames.forEach((photo, slot) => {
        const factor = [1, -1.5, .8][slot];
        photo.style.transform = `translate3d(${x * 20 * factor}px, ${y * 15 * factor + travel * factor}px, 0)`;
      });
      if (Math.abs(x - pointerX) + Math.abs(y - pointerY) + Math.abs(travel - goal) > .02) queue(); else last = 0;
    };
    function queue() { if (!frame) frame = window.requestAnimationFrame(paint); }
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const rect = node.getBoundingClientRect();
      pointerX = (event.clientX - rect.left) / rect.width * 2 - 1; pointerY = (event.clientY - rect.top) / rect.height * 2 - 1; queue();
    };
    const leave = () => { pointerX = pointerY = 0; queue(); };
    const reset = () => {
      window.cancelAnimationFrame(frame); frame = 0; last = 0;
      animations.forEach(animation => animation.cancel());
      frames.forEach(photo => { photo.style.transform = "none"; });
      x = y = travel = pointerX = pointerY = 0;
      if (!media.matches) queue();
    };
    const visibility = new IntersectionObserver(entries => {
      nearby = entries[0].isIntersecting;
      if (nearby && !media.matches && !node.dataset.entered) {
        node.dataset.entered = "true";
        frames.forEach((photo, slot) => { const img = photo.querySelector("img"); if (img) animations.push(img.animate([{ opacity: 0, transform: "translateY(45px) scale(1.06)" }, { opacity: 1, transform: "none" }], { duration: 1000, delay: slot * 130, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" })); });
      }
      measure();
    });
    visibility.observe(node);
    const resize = new ResizeObserver(measure); resize.observe(node);
    node.addEventListener("pointermove", pointer); node.addEventListener("pointerleave", leave);
    window.addEventListener("scroll", queue, { passive: true }); window.addEventListener("resize", measure);
    media.addEventListener("change", reset); document.addEventListener("visibilitychange", queue);
    return () => { window.cancelAnimationFrame(frame); animations.forEach(animation => animation.cancel()); visibility.disconnect(); resize.disconnect(); node.removeEventListener("pointermove", pointer); node.removeEventListener("pointerleave", leave); window.removeEventListener("scroll", queue); window.removeEventListener("resize", measure); media.removeEventListener("change", reset); document.removeEventListener("visibilitychange", queue); };
  }, [open]);
  return entry;
}
