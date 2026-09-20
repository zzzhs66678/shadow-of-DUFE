import type { MetadataRoute } from "next";
import { getMaterialPaths } from "./materials/materials-catalog.mjs";
import { absoluteUrl, publicPagePaths } from "./seo";

export default function sitemap(): MetadataRoute.Sitemap {
  // Catalog generation time is not page edit time; omit unverified lastmod.
  return [...Object.values(publicPagePaths), ...getMaterialPaths()].map((path) => ({
    url: absoluteUrl(path),
  }));
}
