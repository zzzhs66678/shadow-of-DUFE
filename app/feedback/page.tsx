import type { Metadata } from "next";
import { MyDataFeedback } from "./MyDataFeedback";
export const metadata: Metadata = { title: "我的反馈", robots: { index: false, follow: false, nocache: true } };
export default function FeedbackPage() { return <MyDataFeedback />; }
