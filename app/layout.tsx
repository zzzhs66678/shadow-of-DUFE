import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./product-system.css";
import "./red-access-system.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://dufesh.cn"),
  title: {
    default: "东财之影｜课表、空教室与学习资料",
    template: "%s｜东财之影",
  },
  description:
    "面向东北财经大学学生的课表、空教室、课程资料与个人日程工具。",
  applicationName: "东财之影",
  authors: [{ name: "东财之影" }],
  creator: "东财之影",
  publisher: "东财之影",
  category: "education",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "东财之影｜课表、空教室与学习资料",
    description: "打开就能看到下一节课、可用教室和需要处理的作业。",
    type: "website",
    locale: "zh_CN",
    url: "/",
    siteName: "东财之影",
    images: [
      {
        url: "/images/dufesh-social.png",
        width: 1200,
        height: 630,
        alt: "东财之影",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "东财之影｜课表、空教室与学习资料",
    description: "打开就能看到下一节课、可用教室和需要处理的作业。",
    images: ["/images/dufesh-social.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#f4f4ef",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "东财之影",
  url: "https://dufesh.cn/",
  applicationCategory: "EducationalApplication",
  operatingSystem: "Web",
  inLanguage: "zh-CN",
  description: "东北财经大学学生使用的课表、空教室与课程资料工具。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </body>
    </html>
  );
}
