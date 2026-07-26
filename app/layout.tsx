import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://dufesh.cn"),
  title: {
    default: "东财之影｜课表、空教室与学习资料",
    template: "%s｜东财之影",
  },
  description:
    "面向东北财经大学学生的课程、资料与校园空间索引。",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "东财之影｜课表、空教室与学习资料",
    description: "打开就知道下一节课、资料和此刻可用的教室。",
    type: "website",
    locale: "zh_CN",
  },
  twitter: {
    card: "summary_large_image",
    title: "东财之影｜课表、空教室与学习资料",
    description: "打开就知道下一节课、资料和此刻可用的教室。",
  },
};

export const viewport: Viewport = {
  themeColor: "#f3f0e8",
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
