import type { Metadata } from "next";
import { CommunitySavedView } from "./CommunitySavedView";

export const metadata: Metadata = {
  title: "我的社区存档",
  description: "管理自己在校园回廊收藏的主题与屏蔽的账号。",
  robots: { index: false, follow: false },
};

export default function CommunitySavedPage() {
  return (
    <>
      <a className="skip-link" href="#community-saved">跳到我的社区存档</a>
      <CommunitySavedView />
    </>
  );
}
