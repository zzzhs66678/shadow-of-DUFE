import type { Metadata } from "next";
import { CommunityTopicView } from "../../CommunityTopicView";

export const metadata: Metadata = {
  title: "东财墙 · 帖子",
  description: "看看同学们在聊什么。",
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
