type CatalogLocation = { revision: number; version: string; coreUrl?: string; fullUrl?: string; url?: string };
type PublishedCatalog = { courses: CatalogLocation; materials: CatalogLocation };
const fullLocations = new Map<string, string>();
let manifestRequest: Promise<PublishedCatalog | null> | null = null;

function safeLocation(value: unknown, suffix: string): value is string {
  return typeof value === "string" && new RegExp(`^/api/catalog/releases/[0-9a-f]{64}/${suffix}$`).test(value);
}

// One manifest per open page pins both course projections to one publication.
// Older installations still return 404 and use their bundled static catalog.
async function manifest(): Promise<PublishedCatalog | null> {
  manifestRequest ??= fetch("/api/catalog/current", {
    cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5_000),
  }).then(async response => {
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("catalog manifest unavailable");
    const value = await response.json() as PublishedCatalog;
    if (!safeLocation(value.courses?.coreUrl, "core") ||
        !safeLocation(value.courses?.fullUrl, "full") ||
        !safeLocation(value.materials?.url, "materials") ||
        value.courses.coreUrl.split("/")[4] !== value.courses.fullUrl.split("/")[4]) {
      throw new Error("catalog manifest invalid");
    }
    return value;
  });
  return manifestRequest;
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "omit" });
  if (!response.ok) throw new Error("catalog snapshot unavailable");
  return response.json() as Promise<T>;
}

export async function loadPublishedCourseCore<T extends { catalogId: string }>(): Promise<T> {
  const locations = await manifest();
  const payload = await readJson<T>(locations?.courses.coreUrl ?? "/data/course-core.json");
  fullLocations.set(payload.catalogId, locations?.courses.fullUrl ?? "/data/course-data.json");
  return payload;
}

export function loadPublishedCourseFull<T>(catalogId: string): Promise<T> {
  return readJson<T>(fullLocations.get(catalogId) ?? "/data/course-data.json");
}

export async function loadPublishedMaterials<T>(): Promise<T> {
  const locations = await manifest();
  return readJson<T>(locations?.materials.url ?? "/data/resource-manifest.json");
}
