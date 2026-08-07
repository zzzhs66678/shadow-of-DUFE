import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin/", "/campus-lab/"],
    },
    sitemap: "https://dufesh.cn/sitemap.xml",
    host: "https://dufesh.cn",
  };
}
