import type { Metadata } from "next";
import { CommunitySavedView } from "./CommunitySavedView";

export const metadata: Metadata = {
  title: "东财墙 · 我的收藏",
  description: "收藏的帖子与屏蔽的账号。",
  robots: { index: false, follow: false },
};

export default function CommunitySavedPage() {
  return (
    <>
      <a className="skip-link" href="#community-saved">跳到我的收藏</a>
      <CommunitySavedView />
    </>
  );
}
