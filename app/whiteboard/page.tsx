import type { Metadata } from "next";
import { Whiteboard } from "./Whiteboard";
export const metadata: Metadata = { title: "小白板 · 东财之影", description: "校园讲座、活动，还有几句想说的话。", alternates: { canonical: "/whiteboard" } };
export default function WhiteboardPage() { return <Whiteboard />; }
