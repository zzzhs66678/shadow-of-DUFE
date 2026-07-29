const meetingPattern =
  /(?:第?\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)周(?:单周|双周)?\s*星期[一二三四五六日]\s*第\d+(?:-\d+)?节/g;

export function extractMeetingTimes(value) {
  return [...String(value ?? "").matchAll(meetingPattern)].map(
    (match) => match[0],
  );
}

export function splitMeetingLocations(value) {
  return String(value ?? "")
    .split(/[，,；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseWeeks(value) {
  const text = String(value ?? "").trim();
  const expression = text.match(
    /^第?(.+?)周(?:单周|双周)?(?=\s*星期)/,
  )?.[1];
  if (!expression) return [];

  const weeks = new Set();
  for (const match of expression.matchAll(/(\d+)(?:-(\d+))?/g)) {
    const start = Math.max(1, Number(match[1]));
    const end = Math.min(18, Number(match[2] ?? match[1]));
    for (let week = start; week <= end; week += 1) weeks.add(week);
  }

  return [...weeks]
    .filter((week) => {
      if (text.includes("单周")) return week % 2 === 1;
      if (text.includes("双周")) return week % 2 === 0;
      return true;
    })
    .sort((a, b) => a - b);
}

export function occursInWeek(weeks, week) {
  return week >= 1 && week <= 18 && weeks.includes(week);
}
