import type { Metadata } from "next";
import { CommunityProfileView } from "../../CommunityProfileView";

export const metadata: Metadata = {
  title: "社区公开档案",
  description: "查看东财之影校园回廊用户主动公开的主题与回复。",
  robots: { index: false, follow: false },
};

export default async function CommunityProfilePage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return (
    <>
      <a className="skip-link" href="#public-records">跳到公开记录</a>
      <CommunityProfileView userId={userId} />
    </>
  );
}
