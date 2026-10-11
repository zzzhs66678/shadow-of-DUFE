import * as bundled from "./materials-catalog.mjs";

let cached = null;
let pending = null;
let expiresAt = 0;
const safeVersion = /^[0-9a-f]{64}$/u;

// The deployment supplies its own HTTPS origin; never use a request Host header
// or forward account cookies for this public catalog lookup.
export async function publishedMaterialCatalog() {
  const configured = process.env.CATALOG_API_ORIGIN;
  if (!configured) return bundled;
  const origin = new URL(configured);
  if (origin.protocol !== "https:" && origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") {
    throw new Error("Catalog API requires HTTPS");
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Invalid catalog origin");
  }
  if (cached && Date.now() < expiresAt) return cached;
  if (!pending) {
    pending = (async () => {
      const response = await fetch(new URL("/api/catalog/current", origin), { signal: AbortSignal.timeout(5_000), cache: "no-store" });
      if (!response.ok) throw new Error("Published catalog unavailable");
      const { materials } = await response.json();
      if (!safeVersion.test(materials?.version) || materials.url !== `/api/catalog/releases/${materials.version}/materials`) {
        throw new Error("Invalid published catalog location");
      }
      if (!cached || cached.version !== materials.version) {
        const snapshot = await fetch(new URL(materials.url, origin), { signal: AbortSignal.timeout(5_000) });
        if (!snapshot.ok) throw new Error("Published materials unavailable");
        cached = { ...bundled.createMaterialCatalog(await snapshot.json()), version: materials.version };
      }
      expiresAt = Date.now() + 10_000;
      return cached;
    })().finally(() => { pending = null; });
  }
  return pending;
}
