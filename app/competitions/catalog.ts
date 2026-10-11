export type CompetitionResource = {
  name: string;
  description: string;
  href: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
};

export type Competition = {
  slug: string;
  title: string;
  category: "数学" | "英语" | "创意设计";
  notice: { title: string; url: string; publishedAt: string };
  resources: CompetitionResource[];
};

// The supplied school notices are dated references, not live registration status.
export const competitions: Competition[] = [
  {
    slug: "dalian-math",
    title: "大连市数学竞赛",
    category: "数学",
    notice: {
      title: "关于举办大连市第三十三届大学生数学竞赛通知",
      url: "https://jwc.dufe.edu.cn/content_98343.html",
      publishedAt: "2026-05-06",
    },
    resources: [{
      name: "大连市数学竞赛试题",
      description: "2010—2025 年（部分年份）· 试题与参考答案",
      href: "/assets/competitions/dalian-math-papers.6ca2d34cbde2.zip",
      filename: "大连市数学竞赛试题.zip",
      sizeBytes: 9398727,
      sha256: "6ca2d34cbde2c2a0545cb3ad7d3414a8ce122ad25b700f1b807629ee94146a05",
    }],
  },
  {
    slug: "national-math",
    title: "全国大学生数学竞赛",
    category: "数学",
    notice: {
      title: "2026年第十八届全国大学生数学竞赛通知",
      url: "https://jwc.dufe.edu.cn/content_100842.html",
      publishedAt: "2026-08-31",
    },
    resources: [],
  },
  {
    slug: "math-modeling",
    title: "高教社杯全国大学生数学建模竞赛",
    category: "数学",
    notice: {
      title: "2026年高教社杯全国大学生数学建模竞赛报名通知",
      url: "https://jwc.dufe.edu.cn/content_99407.html",
      publishedAt: "2026-06-11",
    },
    resources: [],
  },
  {
    slug: "cet",
    title: "英语四六级",
    category: "英语",
    notice: {
      title: "2026年上半年全国大学英语四、六级考试考生须知",
      url: "https://jwc.dufe.edu.cn/content_99365.html",
      publishedAt: "2026-06-09",
    },
    resources: [],
  },
  {
    slug: "advertising",
    title: "全国大学生广告艺术大赛（大广赛）",
    category: "创意设计",
    notice: {
      title: "2026年第十八届全国大学生广告艺术大赛（大广赛）赛事通知",
      url: "https://jwc.dufe.edu.cn/content_98729.html",
      publishedAt: "2026-05-13",
    },
    resources: [],
  },
  {
    slug: "neccs",
    title: "全国大学生英语竞赛（NECCS）",
    category: "英语",
    notice: {
      title: "2026年4月全国大学生英语竞赛（NECCS）东北财经大学初赛考生须知",
      url: "https://jwc.dufe.edu.cn/content_97272.html",
      publishedAt: "2026-04-03",
    },
    resources: [],
  },
];

export function findCompetition(slug: string) {
  return competitions.find(item => item.slug === slug);
}

export function competitionPath(slug: string) {
  return `/competitions/${encodeURIComponent(slug)}`;
}
