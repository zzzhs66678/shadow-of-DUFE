import type { MetadataRoute } from "next";
import { getMaterialPaths } from "./materials/materials-catalog.mjs";
import { absoluteUrl, publicPagePaths } from "./seo";
import { competitions, competitionPath } from "./competitions/catalog";

export default function sitemap(): MetadataRoute.Sitemap {
  // Catalog generation time is not page edit time; omit unverified lastmod.
  return [...Object.values(publicPagePaths), ...getMaterialPaths(), ...competitions.map(item => competitionPath(item.slug))].map((path) => ({
    url: absoluteUrl(path),
  }));
}
