/** Discovery only. Never use these scores as course/section identity. */
type SearchableCourse = { id: string; title: string; teachers?: readonly string[]; college?: string };

const aliases: Record<string, string[]> = {
  中级财务会计: ["中财"], 宏观经济学: ["宏经"], 微观经济学: ["微经"],
  高等数学: ["高数"], 概率论与数理统计: ["概统", "概率论"], 线性代数: ["线代"],
  马克思主义基本原理: ["马原"], 毛泽东思想和中国特色社会主义理论体系概论: ["毛概"],
};

export function searchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]/gu, "");
}

// Abbreviations omit words in the middle: 高[级]财[务会计], 近[现]代史.
// Evaluate within one title, never across teacher/course-code boundaries.
function titleScore(title: string, query: string): number {
  if (title === query) return 1000;
  if (title.startsWith(query)) return 900 - Math.min(90, title.length - query.length);
  if (title.includes(query)) return 800 - Math.min(90, title.length - query.length);
  if (query.length < 2 || !/^[\p{Script=Han}]+$/u.test(query)) return -1;
  let best = -1;
  for (let start = title.indexOf(query[0]); start >= 0; start = title.indexOf(query[0], start + 1)) {
    let position = start;
    for (let index = 1; index < query.length && position >= 0; index++) {
      position = title.indexOf(query[index], position + 1);
    }
    if (position < 0) continue;
    const omitted = position - start + 1 - query.length;
    best = Math.max(best, 500 - omitted * 8 - start * 2 - Math.min(title.length, 80));
  }
  return best;
}

export function scoreCourseSearch(course: SearchableCourse, input: string): number {
  const query = searchText(input);
  if (!query) return 0;
  const title = searchText(course.title);
  const id = searchText(course.id);
  let score = titleScore(title, query);
  if (id === query) score = Math.max(score, 1000);
  else if (id.includes(query)) score = Math.max(score, 700);
  for (const [name, values] of Object.entries(aliases)) {
    if (title.includes(searchText(name)) && values.some((alias) => searchText(alias) === query)) {
      score = Math.max(score, 850);
    }
  }
  const tokens = input.normalize("NFKC").trim().split(/\s+/u).map(searchText).filter(Boolean);
  const fields = [title, ...(course.teachers ?? []).map(searchText), searchText(course.college ?? "")];
  if (fields.slice(1).some((field) => field.includes(query))) score = Math.max(score, 200);
  if (tokens.length > 1 && tokens.every((token) => fields.some((field) => field.includes(token)) || id.includes(token))) {
    score = Math.max(score, 600);
  }
  return score;
}
