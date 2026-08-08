import type { Metadata } from "next";
import { CommunityTopicView } from "../../CommunityTopicView";

export const metadata: Metadata = {
  title: "回廊主题",
  description: "查看并参与东财校园回廊中的讨论。",
  robots: { index: false, follow: false },
};

export default async function CommunityTopicPage({
  params,
}: {
  params: Promise<{ topicId: string }>;
}) {
  const { topicId } = await params;
  return (
    <>
      <a className="skip-link" href="#discussion">跳到讨论</a>
      <CommunityTopicView topicId={topicId} />
    </>
  );
}
