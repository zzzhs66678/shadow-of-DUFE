const rootKeys = new Set(["view", "room", "course", "meeting", "room-building", "room-floor", "room-date", "room-block", "room-term", "tab", "cq", "term", "week", "college", "major", "year", "date", "block"]);
export function safeWallOrigin(value: string | null): string | null {
  if (!value || value.length > 4000 || !/^\/(?:\?|$)/u.test(value) || /[\\\u0000-\u001f]/u.test(value)) return null;
  const url = new URL(value, "https://local.invalid");
  if (url.pathname !== "/" || !["home", "schedule", "rooms", "catalog", "me"].includes(url.searchParams.get("view") || "home")) return null;
  for (const key of [...url.searchParams.keys()]) if (!rootKeys.has(key)) url.searchParams.delete(key);
  url.hash = "";
  return `${url.pathname}${url.search}`;
}
export function wallFeedHref(origin: string | null, sort = "latest") {
  const params = new URLSearchParams();
  if (sort === "replied") params.set("sort", sort);
  const target = safeWallOrigin(origin);
  if (target) params.set("returnTo", target);
  return `/community${params.size ? `?${params}` : ""}`;
}
export function wallTopicHref(id: string, sort: string, origin: string | null) {
  const params = new URLSearchParams({ from: sort === "replied" ? "replied" : "latest" });
  const target = safeWallOrigin(origin);
  if (target) params.set("returnTo", target);
  return `/community/topics/${encodeURIComponent(id)}?${params}`;
}
export function safeWallFeed(value: string | null): string | null {
  if (!value || value.length > 5000 || !/^\/community(?:\?|$)/u.test(value) || /[\\\u0000-\u001f]/u.test(value)) return null;
  const url = new URL(value, "https://local.invalid");
  return wallFeedHref(url.searchParams.get("returnTo"), url.searchParams.get("sort") || "latest");
}
export const wallReadingKey = (owner: string, href: string) => `dufe:wall-reading:v1:${encodeURIComponent(owner)}:${encodeURIComponent(href)}`;
