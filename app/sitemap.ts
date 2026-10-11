import type { MetadataRoute } from "next";
import { publishedMaterialCatalog } from "./materials/published-materials-server.mjs";
import { absoluteUrl, publicPagePaths } from "./seo";
import { competitions, competitionPath } from "./competitions/catalog";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { getMaterialPaths } = await publishedMaterialCatalog();
  // Catalog generation time is not page edit time; omit unverified lastmod.
  return [...Object.values(publicPagePaths), ...getMaterialPaths(), ...competitions.map(item => competitionPath(item.slug))].map((path) => ({
    url: absoluteUrl(path),
  }));
}
