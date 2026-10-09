export const discoveryKeys = ["room", "course", "meeting"] as const;
export function localHref(url: URL) { return `${url.pathname}${url.search}${url.hash}`; }

export function safeCourseReturn(value: string | null): string | null {
  if (!value?.startsWith("/?") || value.includes("\\") || /[\u0000-\u001f]/u.test(value)) return null;
  const url = new URL(value, "https://local.invalid");
  return url.pathname === "/" && url.searchParams.has("course") ? localHref(url) : null;
}

export function withCourseReturn(href: string, returnTo?: string) {
  const target = safeCourseReturn(returnTo ?? null);
  if (!target) return href;
  const url = new URL(href, "https://local.invalid");
  if (url.origin !== "https://local.invalid") return href;
  url.searchParams.set("returnTo", target);
  return localHref(url);
}

export function roomContextUrl(href: string, context: { building: string; date: string; block: number; floor: string; term: string }) {
  const url = new URL(href);
  for (const [key, value] of Object.entries(context)) url.searchParams.set(`room-${key}`, String(value));
  return url;
}

export function readDiscovery(search: string) {
  const params = new URLSearchParams(search);
  const room = params.get("view") === "rooms" ? params.get("room") ?? "" : "";
  const date = params.get("room-date") ?? "";
  return {
    room: /^[^|]{1,100}\|[^|]{1,100}$/u.test(room) ? room : "",
    course: params.get("course") ?? "", meeting: params.get("meeting") ?? "",
    building: params.get("room-building") ?? "", floor: params.get("room-floor") ?? "",
    date: /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : "",
    block: /^[1-4]$/u.test(params.get("room-block") ?? "") ? Number(params.get("room-block")) : 0,
    term: params.get("room-term") === "spring" ? "spring" as const : "fall" as const,
  };
}

export function pushDiscovery(url: URL, layer: "room" | "course") {
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
  window.history.replaceState({ ...window.history.state, hubScroll: window.scrollY, hubFocus: focus }, "");
  window.history.pushState({ hubLayer: layer, hubParent: localHref(new URL(window.location.href)), hubScroll: layer === "course" ? window.scrollY : 0 }, "", localHref(url));
}

export function restoreDiscoveryPosition() {
  const { hubScroll, hubFocus } = window.history.state ?? {};
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (typeof hubFocus === "string") document.getElementById(hubFocus)?.focus({ preventScroll: true });
    if (Number.isFinite(hubScroll)) window.scrollTo({ top: hubScroll, behavior: "instant" });
  }));
}
