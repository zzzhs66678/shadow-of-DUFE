"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "./use-modal-focus";
import { useCampusEntry, useCampusMotion } from "./use-campus-motion";
import styles from "./campus-album.module.css";

const photos = [
  { src: "/images/dufe-tree-avenue-day.webp", alt: "白天的东财林荫路，彩色花带悬在树间", width: 900, height: 1200 },
  { src: "/images/dufe-tree-avenue-night.webp", alt: "夜晚的东财林荫路，路灯照亮树木和花带", width: 900, height: 1200 },
  { src: "/images/dufe-welcome-arch.webp", alt: "东北财经大学 2024 级新生欢迎拱门和校园主楼", width: 1200, height: 900 },
  { src: "/images/dufe-winter-wayfinding.webp", alt: "雪夜里指向笃行楼、之远楼和梅园西路的校园路牌", width: 900, height: 1200 },
  { src: "/images/dufe-winter-pavilion.webp", alt: "雪夜中的东财红亭", width: 900, height: 1200 },
  { src: "/images/dufe-winter-stadium.webp", alt: "雪夜中的东北财经大学体育馆", width: 900, height: 1200 },
  { src: "/images/dufe-winter-stone-sign.webp", alt: "雪夜里亮起的东北财经大学校名石", width: 1200, height: 900 },
  { src: "/images/dufe-campus-cat.webp", alt: "夜色中，校园猫坐在博学济世石旁的草地里", width: 786, height: 1048 },
  { src: "/images/dufe-spring-love-sign.webp", alt: "春日樱花下的 I 爱 DUFE 校园装置", width: 998, height: 1500 },
  { src: "/images/dufe-sunset-tree.webp", alt: "夕阳下，校园树木的枝条映在天空中", width: 694, height: 521 },
  { src: "/images/dufe-library-ginkgo.webp", alt: "手中的银杏叶与东财图书馆", width: 640, height: 426 },
  { src: "/images/dufe-avenue-walk.webp", alt: "林荫路上并肩散步的两个人", width: 640, height: 853 },
  { src: "/images/dufe-campus-dusk.webp", alt: "傍晚校园楼宇之间的树木与路灯", width: 640, height: 480 },
  { src: "/images/dufe-autumn-avenue.webp", alt: "金黄色秋叶覆盖的校园街道", width: 640, height: 480 },
  { src: "/images/dufe-campus-care.webp", alt: "校园工作人员在绿树旁整理环境", width: 640, height: 427 },
  { src: "/images/dufe-snow-love-sign.webp", alt: "飘雪中的 I 爱 DUFE 校园装置", width: 1280, height: 853 },
  { src: "/images/dufe-snow-statue.webp", alt: "雪中的金色雕像与松树", width: 1280, height: 853 },
  { src: "/images/dufe-snow-ding.webp", alt: "冬日校园广场上的铜鼎", width: 1280, height: 853 },
  { src: "/images/dufe-snow-charm.webp", alt: "飘雪时挂在树枝上的黄色校园挂件", width: 1500, height: 900 },
  { src: "/images/dufe-snow-letters.webp", alt: "薄雪中写下的 DUFE 字样", width: 1280, height: 853 },
  { src: "/images/dufe-snow-magpie.webp", alt: "雪地旁展开翅膀的喜鹊", width: 1280, height: 768 },
  { src: "/images/dufe-winter-students.webp", alt: "冬日里走向教学楼的同学们", width: 1280, height: 853 },
  { src: "/images/dufe-snow-tiny-friends.webp", alt: "雪地里的两个小雪人与校园挂件", width: 1280, height: 853 },
  { src: "/images/dufe-snow-campus-care.webp", alt: "校园工作人员并肩清扫积雪", width: 1280, height: 853 },
  { src: "/images/dufe-campus-mural.webp", alt: "暖光下爬满藤蔓的校园墙面", width: 438, height: 747 },
  { src: "/images/dufe-spring-magnolia.webp", alt: "蓝天下盛开的白色玉兰", width: 704, height: 938 },
] as const;

// Intentionally mixed: seasons and small campus moments, not a run of identical scenes.
const journey = [8, 7, 13, 25, 18, 11, 0, 20, 9, 10, 15, 1, 14, 22, 24, 3, 16, 21, 2, 23, 19, 12, 17, 5, 6, 4] as const;
const preview = [8, 7, 13] as const;
const lastStop = journey.length - 1;
const columns = ["2 / span 5", "8 / span 4", "1 / span 5", "9 / span 4", "2 / span 4", "7 / span 5"];
// Quiet campus light, not a second copy of the photograph behind the content.
const campusLight = [
  ["#bcd1c7", "#d2dfe4"],
  ["#d0c9bc", "#ccd6de"],
  ["#e2cfb6", "#cbd1bc"],
  ["#b9cedd", "#d5dcd0"],
] as const;
const photoLight = [0, 1, 3, 1, 1, 1, 1, 2, 0, 2, 2, 0, 1, 2, 0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 3] as const;
type Mode = "walk" | "index" | "original";

function GalleryIcon({ kind }: { kind: "close" | "grid" | "back" | "expand" }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {kind === "close" && <path d="m6 6 12 12M18 6 6 18" />}
    {kind === "back" && <path d="m10 5-7 7 7 7M3 12h18" />}
    {kind === "expand" && <path d="M14 3h7v7M21 3l-8 8M10 21H3v-7M3 21l8-8" />}
    {kind === "grid" && <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>}
  </svg>;
}

/** A user-driven, inertial campus journey; no autoplay, uploads or account changes. */
export function CampusAlbum() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("walk");
  const [active, setActive] = useState(0);
  const [original, setOriginal] = useState<number>(journey[0]);
  const [sourcePhoto, setSourcePhoto] = useState<number | null>(null);
  const [failed, setFailed] = useState<number[]>([]);
  const [returnMode, setReturnMode] = useState<Mode>("walk");
  const [closing, setClosing] = useState(false);
  const light = campusLight[photoLight[journey[active]]];
  const previousLight = useRef(light);
  const outgoingLight = useRef<HTMLDivElement>(null);
  const incomingLight = useRef<HTMLDivElement>(null);
  const activeRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const photoRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const entryRef = useCampusEntry(open);
  const motion = useCampusMotion({ open, mode, scroll: scrollRef, canvas: canvasRef, tiles: tileRefs, photos: photoRefs, active: activeRef, onActive: setActive });
  const sourceRef = useRef<HTMLButtonElement | null>(null);
  const openingRect = useRef<DOMRect | null>(null);
  const originalImage = useRef<HTMLImageElement>(null);
  const originalFrame = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLElement | null>(null);
  const shadeRef = useRef<HTMLDivElement>(null);
  const originalRegion = useRef<HTMLElement>(null);
  const animations = useRef<Animation[]>([]);
  const closingRef = useRef(false);
  const transitionEpoch = useRef(0);
  const lastMode = useRef<Mode>("walk");
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cancelAnimations = () => { animations.current.forEach(animation => animation.cancel()); animations.current = []; };
  const markFailed = (index: number) => setFailed(previous => previous.includes(index) ? previous : [...previous, index]);

  useLayoutEffect(() => {
    const outgoing = outgoingLight.current, incoming = incomingLight.current;
    if (!open || !outgoing || !incoming) return;
    const before = previousLight.current; previousLight.current = light;
    outgoing.style.setProperty("--ambient-a", before[0]);
    outgoing.style.setProperty("--ambient-b", before[1]);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (before === light || media.matches) return;
    // Crossfade two fixed fields; never repaint a full-screen color every frame.
    const fades = [outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1100, fill: "both" }), incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1100, fill: "both" })];
    const flatten = () => { if (media.matches) fades.forEach(animation => animation.cancel()); };
    media.addEventListener("change", flatten);
    return () => { fades.forEach(animation => animation.cancel()); media.removeEventListener("change", flatten); };
  }, [open, light]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const flatten = () => { if (media.matches) { animations.current.forEach(animation => animation.cancel()); animations.current = []; } };
    media.addEventListener("change", flatten);
    return () => media.removeEventListener("change", flatten);
  }, []);

  const closeOriginal = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true; setClosing(true);
    const epoch = ++transitionEpoch.current;
    const image = originalImage.current, frame = originalFrame.current;
    const source = sourceRef.current;
    const finish = () => {
      if (epoch !== transitionEpoch.current || !originalRegion.current?.isConnected) return;
      closingRef.current = false; setClosing(false); setMode(returnMode);
    };
    if (reduced() || !image || !frame || !source?.isConnected) { finish(); return; }
    const target = source.getBoundingClientRect();
    const base = { width: frame.offsetWidth, height: frame.offsetHeight, left: frame.offsetLeft, top: frame.offsetTop };
    // The image is centered with CSS translate; offsets are its unanimated document coordinates.
    const from = getComputedStyle(frame).transform;
    const inner = getComputedStyle(image).transform;
    const shadeOpacity = shadeRef.current ? getComputedStyle(shadeRef.current).opacity : "1";
    cancelAnimations();
    const dx = target.left - (base.left - base.width / 2);
    const dy = target.top - (base.top - base.height / 2);
    const transform = "translate(" + dx + "px, " + dy + "px) scale(" + target.width / base.width + ", " + target.height / base.height + ")";
    const animation = frame.animate([{ transform: from }, { transform }], { duration: 760, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" });
    animations.current = [animation, image.animate([{ transform: inner }, { transform: "scale(1.08)" }], { duration: 760, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" })];
    if (overviewRef.current) animations.current.push(overviewRef.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 430, delay: 300, fill: "both" }));
    if (shadeRef.current) animations.current.push(shadeRef.current.animate([{ opacity: shadeOpacity }, { opacity: 0 }], { duration: 730, fill: "forwards" }));
    void animation.finished.catch(() => {}).then(finish);
  }, [returnMode]);

  const exit = () => { transitionEpoch.current++; cancelAnimations(); closingRef.current = false; setClosing(false); setOpen(false); };
  const dialogRef = useModalFocus<HTMLDivElement>(open, () => {
    if (mode === "original") closeOriginal();
    else if (mode === "index") setMode("walk");
    else exit();
  });

  const showOriginal = (index: number, from: Mode, source: HTMLButtonElement) => {
    transitionEpoch.current++; cancelAnimations();
    closingRef.current = false; setClosing(false);
    motion.current?.freeze();
    sourceRef.current = source; openingRect.current = source.getBoundingClientRect();
    overviewRef.current = from === "index" ? source.closest<HTMLElement>("[data-photo-index]") : canvasRef.current;
    setSourcePhoto(index);
    setFailed(previous => previous.filter(item => item !== index));
    setReturnMode(from); setOriginal(index); setMode("original");
  };
  const changeOriginal = (step: number) => {
    if (closingRef.current) return;
    transitionEpoch.current++; cancelAnimations(); openingRect.current = null;
    const slot = journey.indexOf(original as typeof journey[number]);
    const next = journey[(slot + step + journey.length) % journey.length];
    // Returning goes to the thumbnail that opened the viewer, even after browsing other photos.
    setOriginal(next);
  };
  const moveTo = (value: number, direct = false) => {
    motion.current?.seek(value, direct);
  };

  useLayoutEffect(() => {
    if (mode !== "original") return;
    const rect = openingRect.current;
    openingRect.current = null;
    const image = originalImage.current, frame = originalFrame.current, shade = shadeRef.current;
    if (!image || !frame || reduced()) return;
    if (!rect) {
      animations.current = [image.animate([{ opacity: 0, transform: "scale(1.035)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: "ease-out" })];
      return () => cancelAnimations();
    }
    // Start before paint: there is no full-size flash while the same photo decodes.
    const target = frame.getBoundingClientRect();
    const transform = "translate(" + (rect.left - target.left) + "px, " + (rect.top - target.top) + "px) scale(" + rect.width / target.width + ", " + rect.height / target.height + ")";
    animations.current = [
      frame.animate([{ transform }, { transform: "none" }], { duration: 1080, easing: "cubic-bezier(.76,0,.24,1)", fill: "both" }),
      image.animate([{ transform: "scale(1.08)" }, { transform: "none" }], { duration: 1080, easing: "cubic-bezier(.76,0,.24,1)", fill: "both" }),
    ];
    if (overviewRef.current) animations.current.push(overviewRef.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 480, easing: "ease-out", fill: "forwards" }));
    if (shade) animations.current.push(shade.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, easing: "ease-in-out", fill: "both" }));
    return () => cancelAnimations();
  }, [mode, original]);

  useEffect(() => {
    if (!open) return;
    const previous = lastMode.current; lastMode.current = mode;
    const frame = window.requestAnimationFrame(() => {
      const source = previous === "original" && mode === returnMode ? sourceRef.current : null;
      const target = source ?? dialogRef.current?.querySelector<HTMLButtonElement>("[data-mode-back]:not([disabled])") ??
        dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="退出校园漫游"]');
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, mode, returnMode, dialogRef]);

  useEffect(() => {
    if (!open) return;
    const first = () => dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="退出校园漫游"]');
    const repair = () => {
      const focused = document.activeElement;
      if (!dialogRef.current?.contains(focused) || (focused instanceof HTMLElement && focused.matches(":disabled"))) first()?.focus({ preventScroll: true });
    };
    const tab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focused = document.activeElement;
      if (!dialogRef.current?.contains(focused) || (focused instanceof HTMLElement && focused.matches(":disabled"))) { event.preventDefault(); first()?.focus({ preventScroll: true }); }
    };
    document.addEventListener("focusin", repair); document.addEventListener("keydown", tab);
    const frame = window.requestAnimationFrame(repair);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("focusin", repair); document.removeEventListener("keydown", tab); };
  }, [open, mode, active, closing, dialogRef]);

  useEffect(() => {
    if (!open) return;
    const navigate = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey) return;
      if (mode === "original" && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); changeOriginal(event.key === "ArrowLeft" ? -1 : 1);
      } else if (mode === "walk") {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); moveTo(event.key === "Home" ? 0 : event.key === "End" ? lastStop : activeRef.current + (event.key === "ArrowLeft" ? -1 : 1));
        } else if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) {
          event.preventDefault();
          const direction = ["ArrowDown", "PageDown"].includes(event.key) ? 1 : -1;
          motion.current?.nudge(direction * ((scrollRef.current?.clientHeight ?? 800) * (event.key.startsWith("Page") ? .8 : .25)));
        }
      }
    };
    document.addEventListener("keydown", navigate);
    return () => document.removeEventListener("keydown", navigate);
  });

  return (
    <section id="campus-almanac-title" className={"campus-almanac " + styles.album} aria-label="校园相册">
      <button ref={entryRef} className={styles.entry} aria-label="进入校园漫游" aria-haspopup="dialog" onClick={() => {
        activeRef.current = 0; lastMode.current = "walk"; setFailed([]); setActive(0); setMode("walk"); setOpen(true);
      }}>
        <span className={styles.entryComposition} aria-hidden="true">
          {preview.map((index, slot) => <span className={styles.entryPhoto} data-slot={slot} key={index}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img {...photos[index]} alt="" loading="lazy" decoding="async" onError={() => markFailed(index)} />
          </span>)}
        </span>
        <span className={styles.enter}><GalleryIcon kind="expand" /></span>
      </button>
      {open && createPortal(
        <div className={styles.gallery} role="dialog" aria-modal="true" aria-label="校园漫游" ref={dialogRef}>
          <div className={styles.atmosphere} data-gallery-atmosphere aria-hidden="true" style={{ "--ambient-a": light[0], "--ambient-b": light[1] } as CSSProperties}>
            <div ref={outgoingLight} className={styles.ambientField} style={{ opacity: 0 }} />
            <div ref={incomingLight} className={styles.ambientField} />
          </div>
          <header className={styles.topbar}>
            {mode === "walk" && <button onClick={() => setMode("index")} aria-label="全部照片"><GalleryIcon kind="grid" /></button>}
            <button onClick={exit} aria-label="退出校园漫游"><GalleryIcon kind="close" /></button>
          </header>
          <div className={styles.scrollport} ref={scrollRef} inert={mode !== "walk"} aria-hidden={mode !== "walk"} data-gallery-scroll style={mode === "index" ? { visibility: "hidden" } : undefined}>
            <div className={styles.canvas} ref={canvasRef}>
              {journey.map((index, slot) => <div className={styles.tile} key={index} ref={element => { tileRefs.current[slot] = element; }}
                data-slot={slot} data-landscape={photos[index].width > photos[index].height}
                style={{ "--column": columns[slot % columns.length], "--row": slot + 1, "--ratio": photos[index].width / photos[index].height } as CSSProperties}>
                <button ref={element => { photoRefs.current[slot] = element; }} className={styles.photo} data-active={active === slot}
                  data-expanded={mode === "original" && returnMode === "walk" && sourcePhoto === index}
                  disabled={mode !== "walk"} aria-label={"查看原图：" + photos[index].alt}
                  onClick={event => showOriginal(index, "walk", event.currentTarget)}>
                  {failed.includes(index) ? <span className={styles.fallback}>照片暂时没加载出来</span> : <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img {...photos[index]} alt={photos[index].alt} loading="lazy" decoding="async" draggable="false" onError={() => markFailed(index)} />
                  </>}
                </button>
              </div>)}
            </div>
          </div>
          {mode === "walk" && <span className={styles.srOnly} aria-live="polite" aria-atomic="true">第 {active + 1} 张，共 {journey.length} 张</span>}
          {(mode === "index" || (mode === "original" && returnMode === "index")) && <section data-photo-index className={styles.photoIndex} aria-label="全部校园照片" inert={mode !== "index"} aria-hidden={mode !== "index"}>
            <button data-mode-back disabled={mode !== "index"} onClick={() => setMode("walk")} aria-label="回到漫游"><GalleryIcon kind="back" /></button>
            <div className={styles.indexGrid}>{journey.map((index, slot) => <button key={index} ref={element => { thumbRefs.current[slot] = element; }}
              data-expanded={mode === "original" && returnMode === "index" && sourcePhoto === index}
              disabled={mode !== "index"} aria-label={`查看第 ${slot + 1} 张：${photos[index].alt}`} onClick={event => showOriginal(index, "index", event.currentTarget)}>
              {failed.includes(index) ? <span className={styles.fallback}>照片暂时没加载出来</span> : <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img {...photos[index]} alt={photos[index].alt} loading="lazy" decoding="async" onError={() => markFailed(index)} />
              </>}
            </button>)}</div>
          </section>}
          {mode === "original" && <section className={styles.original} aria-label="校园照片原图" ref={originalRegion}>
            <div className={styles.originalShade} ref={shadeRef} />
            <header><button data-mode-back disabled={closing} onClick={closeOriginal} aria-label={returnMode === "index" ? "全部照片" : "回到漫游"}><GalleryIcon kind="back" /></button><span className={styles.srOnly} aria-live="polite" aria-atomic="true">{journey.indexOf(original as typeof journey[number]) + 1} / {photos.length}</span></header>
            {failed.includes(original) ? <div className={styles.originalFallback}><span>照片暂时没加载出来</span><button disabled={closing} onClick={() => setFailed(previous => previous.filter(index => index !== original))}>重新加载</button></div> : <>
              <div ref={originalFrame} className={styles.originalFrame} style={{ "--ratio": photos[original].width / photos[original].height } as CSSProperties}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.originalImage} ref={originalImage} {...photos[original]} alt={photos[original].alt} decoding="async" onError={() => markFailed(original)} />
              </div>
            </>}
            <footer><button disabled={closing} onClick={() => changeOriginal(-1)} aria-label="上一张校园照片">←</button><button disabled={closing} onClick={() => changeOriginal(1)} aria-label="下一张校园照片">→</button></footer>
          </section>}
        </div>, document.body,
      )}
    </section>
  );
}

