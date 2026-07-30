import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date("2026-07-30T00:00:00+08:00");
  return [
    { url: "https://dufesh.cn/", lastModified, changeFrequency: "daily", priority: 1 },
    {
      url: "https://dufesh.cn/privacy",
      lastModified,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: "https://dufesh.cn/terms",
      lastModified,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: "https://dufesh.cn/account/delete",
      lastModified,
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
