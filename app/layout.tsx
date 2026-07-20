import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://dufesh.cn"),
  title: {
    default: "DUFESH｜东财学习与空间索引",
    template: "%s｜DUFESH",
  },
  description:
    "面向东北财经大学学生的课程、资料与校园空间索引。",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "DUFESH｜东财学习与空间索引",
    description: "知道学什么，也知道现在去哪里学。",
    type: "website",
    locale: "zh_CN",
    images: [
      {
        url: "/images/dufesh-social.png",
        width: 1731,
        height: 909,
        alt: "DUFESH 将课程、教室与学习资料重新连接",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DUFESH｜东财学习与空间索引",
    description: "知道学什么，也知道现在去哪里学。",
    images: ["/images/dufesh-social.png"],
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
