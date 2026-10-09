import type { Metadata } from "next";
import { AdminDataFeedback } from "../../feedback/AdminDataFeedback";
export const metadata: Metadata = { title: "数据问题反馈 · 值守台", robots: { index: false, follow: false, nocache: true } };
export default function AdminDataFeedbackPage() { return <AdminDataFeedback />; }
