export const siteUrl = "https://dufesh.cn";
export const siteName = "东财之影";
export const siteDescription =
  "东财之影是面向东北财经大学学生的非官方校园学习工具，提供课表、空教室、课程资料与个人日程服务。";

// Public entry pages only; material detail paths come from their real catalog.
export const publicPagePaths = {
  home: "/",
  teachers: "/teachers",
  materials: "/materials",
  community: "/community",
  privacy: "/privacy",
  terms: "/terms",
  accountDelete: "/account/delete",
} as const;

export function absoluteUrl(path: string) {
  return new URL(path, `${siteUrl}/`).href;
}
