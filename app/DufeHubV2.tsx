"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  clearPersonalSyncMetadata,
  loadPersonalSyncMetadata,
  mergeInitialPersonalState,
  savePersonalSyncMetadata,
  synchronizePersonalState,
  type PersonalSyncState,
} from "./personal-sync";
import { FormField } from "./FormField";
import { TeacherRecordLink } from "./TeacherRecordLink";
import {
  anonymousPersonalScope,
  migrateLegacyPersonalStorage,
  readPersonalStorage,
  removePersonalStorage,
  userPersonalScope,
  writePersonalStorage,
  type PersonalStorageScope,
} from "./personal-storage";

type Term = "fall" | "spring";
type View = "home" | "catalog" | "schedule" | "rooms" | "me";
type SearchKind = "all" | "course" | "material" | "teacher" | "room";
const COURSE_CATALOG_ID = /^course-v1:[0-9a-f]{64}$/u;

type Major = { id: string; college: string; name: string; aliases: string[] };
type Course = {
  id: string;
  title: string;
  college: string;
  category: string;
  property: string;
  credits: string;
  textbook: string;
  publisher: string;
  author: string;
  terms: string[];
  teachers: string[];
};
type Schedule = {
  id: string;
  sectionId?: string;
  meetingIndex?: number;
  sourceRow?: string;
  term: Term;
  courseId: string;
  title: string;
  teacher: string;
  weekday: number;
  block: number;
  periods: number[];
  weeks?: number[];
  timeText: string;
  building: string;
  room: string;
  classNames: string;
};
type SiteData = {
  catalogId: string;
  disclaimer: string;
  periods: Array<{ block: number; label: string; short: string; time: string }>;
  buildings: string[];
  colleges: Array<{ name: string; majorIds: string[] }>;
  majors: Major[];
  courses: Course[];
  majorCourses: Array<{
    majorId: string;
    year: number;
    term: Term;
    courseId: string;
  }>;
  schedules: Schedule[];
  quality: { roomScheduleRows: number };
};
type CourseCorePayload = {
  version: 1;
  catalogId: string;
  disclaimer: string;
  periods: SiteData["periods"];
  buildings: string[];
  colleges: SiteData["colleges"];
  majors: Major[];
  quality: SiteData["quality"];
  courseTitles: Array<[courseId: string, title: string]>;
  dictionaries: {
    teachers: string[];
    timeTexts: string[];
    venues: string[];
    rooms: string[];
  };
  schedules: Array<
    [
      id: string,
      term: 0 | 1,
      courseIndex: number,
      teacherIndex: number,
      weekday: number,
      block: number,
      weeks: number[] | null,
      timeTextIndex: number,
      venueIndex: number,
      roomIndex: number,
    ]
  >;
};

function inflateCourseCore(payload: CourseCorePayload): SiteData {
  if (payload.version !== 1) throw new Error("unsupported course core version");
  if (!COURSE_CATALOG_ID.test(payload.catalogId)) {
    throw new Error("invalid course catalog identity");
  }
  const courses = payload.courseTitles.map(([id, title]) => ({
    id,
    title,
    college: "",
    category: "",
    property: "",
    credits: "",
    textbook: "",
    publisher: "",
    author: "",
    terms: [],
    teachers: [],
  }));
  const schedules = payload.schedules.map(
    ([
      id,
      encodedTerm,
      courseIndex,
      teacherIndex,
      weekday,
      block,
      weeks,
      timeTextIndex,
      venueIndex,
      roomIndex,
    ]): Schedule => ({
      id,
      term: encodedTerm === 0 ? "fall" : "spring",
      courseId: courses[courseIndex]?.id ?? "",
      title: courses[courseIndex]?.title ?? "课程",
      teacher: payload.dictionaries.teachers[teacherIndex] ?? "",
      weekday,
      block,
      periods: [],
      weeks: weeks ?? [],
      timeText: payload.dictionaries.timeTexts[timeTextIndex] ?? "",
      building: payload.dictionaries.venues[venueIndex] ?? "",
      room: payload.dictionaries.rooms[roomIndex] ?? "",
      classNames: "",
    }),
  );

  return {
    catalogId: payload.catalogId,
    disclaimer: payload.disclaimer,
    periods: payload.periods,
    buildings: payload.buildings,
    colleges: payload.colleges,
    majors: payload.majors,
    courses,
    majorCourses: [],
    schedules,
    quality: payload.quality,
  };
}
type Profile = {
  entranceYear: number;
  college: string;
  majorId: string;
  className: string;
};
type Plan = { id: string; name: string; scheduleIds: string[] };
type PersonalActivity = {
  id: string;
  title: string;
  weekday: number;
  block: number;
  location: string;
  notes: string;
  color: "red" | "blue" | "green" | "amber";
};
type Assignment = {
  id: string;
  courseId: string;
  title: string;
  dueDate: string;
  notes: string;
  completed: boolean;
};
type SavedState = {
  profile: Profile | null;
  skipped: boolean;
  plans: Plan[];
  activePlanId: string;
  activities: PersonalActivity[];
  assignments: Assignment[];
  favoriteRooms: string[];
  recentRooms: string[];
};
type AccountDevice = {
  id: string;
  label: string;
  platform: string;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
  current: boolean;
};
type AccountState = {
  status: "loading" | "anonymous" | "authenticated";
  user: {
    id: string;
    username?: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    email?: string | null;
    emailVerified?: boolean;
    schoolAccount?: string | null;
    schoolAccountVerified?: boolean;
    createdAt?: string;
    lastLoginAt?: string | null;
    status?: string;
    role?: "user" | "moderator" | "admin";
  } | null;
  session: { expiresAt: string; deviceId: string | null } | null;
  credentialsAvailable: boolean;
  passwordResetAvailable: boolean;
  emailVerificationAvailable: boolean;
  wechatAvailable: boolean;
};
type CloudSyncStatus = "local" | "syncing" | "synced" | "conflict" | "offline";
type CalendarEditorRequest =
  | { kind: "activity"; weekday?: number; block?: number; id?: string }
  | { kind: "assignment"; courseId?: string; id?: string };
type SearchItem = {
  key: string;
  kind: Exclude<SearchKind, "all">;
  title: string;
  meta: string;
  course?: Course;
  material?: Material;
  teacher?: string;
  room?: string;
};
type Material = {
  id: string;
  courseTitle: string;
  courseIds: string[];
  teachers?: string[];
  colleges?: string[];
  terms?: string[];
  years?: number[];
  tags?: string[];
  category: string;
  name: string;
  kind: string;
  extension: string;
  sizeBytes: number;
  catalogedAt?: string;
  description?: string;
  previewable: boolean;
  previewUrl: string;
  downloadUrl: string;
};
type MaterialManifest = {
  previewLimitBytes: number;
  materials: Material[];
};
type MaterialsLoadStatus = "idle" | "loading" | "ready" | "error";

const campusLinks = {
  library:
    "https://web.traceint.com/web/index.html#/pages/index/index?r=1785318814",
  campusCard:
    "https://sso.dufe.edu.cn/app.php/open_apps/person_card/index?sessionid=",
  ginkgo: "https://ginkgostu.dufe.edu.cn/notice/system",
} as const;
const xiaoyingServiceUrl = process.env.NEXT_PUBLIC_XIAOYING_URL?.trim() ?? "";
const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const weekdayShort = ["一", "二", "三", "四", "五", "六", "日"];
const courseAliases: Record<string, string[]> = {
  中级财务会计: ["中财"],
  宏观经济学: ["宏经"],
  微观经济学: ["微经"],
  高等数学: ["高数"],
  概率论与数理统计: ["概统", "概率论"],
  线性代数: ["线代"],
};
const emptySavedState: SavedState = {
  profile: null,
  skipped: false,
  plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
  activePlanId: "default",
  activities: [],
  assignments: [],
  favoriteRooms: [],
  recentRooms: [],
};

function normalizeSavedState(value: unknown): SavedState {
  const parsed =
    value && typeof value === "object"
      ? (value as Partial<SavedState>)
      : {};
  const plans =
    Array.isArray(parsed.plans) && parsed.plans.length > 0
      ? parsed.plans
      : emptySavedState.plans;
  const activePlanId = plans.some((plan) => plan.id === parsed.activePlanId)
    ? parsed.activePlanId!
    : plans[0].id;

  return {
    profile: parsed.profile ?? null,
    skipped: Boolean(parsed.skipped),
    plans: plans.map((plan) => ({
      ...plan,
      scheduleIds: Array.isArray(plan.scheduleIds) ? plan.scheduleIds : [],
    })),
    activePlanId,
    activities: Array.isArray(parsed.activities) ? parsed.activities : [],
    assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
    favoriteRooms: Array.isArray(parsed.favoriteRooms)
      ? parsed.favoriteRooms
      : [],
    recentRooms: Array.isArray(parsed.recentRooms) ? parsed.recentRooms : [],
  };
}

function hasMeaningfulSavedState(value: SavedState) {
  return Boolean(
    value.profile ||
      value.skipped ||
      value.plans.length > 1 ||
      value.plans.some((plan) => plan.scheduleIds.length > 0) ||
      value.activities.length > 0 ||
      value.assignments.length > 0 ||
      value.favoriteRooms.length > 0 ||
      value.recentRooms.length > 0,
  );
}

function toPersonalSyncState(
  saved: SavedState,
  preferredTerm: Term,
): PersonalSyncState {
  return {
    ...saved,
    preferredTerm,
    theme: "system",
  };
}

function fromPersonalSyncState(state: PersonalSyncState): SavedState {
  return {
    profile: state.profile,
    skipped: state.skipped,
    plans: state.plans,
    activePlanId: state.activePlanId,
    activities: state.activities,
    assignments: state.assignments,
    favoriteRooms: state.favoriteRooms,
    recentRooms: state.recentRooms,
  };
}

function todayISO() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function currentBlock() {
  const minutes = new Date().getHours() * 60 + new Date().getMinutes();
  if (minutes < 9 * 60 + 35) return 1;
  if (minutes < 11 * 60 + 30) return 2;
  if (minutes < 15 * 60 + 25) return 3;
  return 4;
}

function scheduleWeeksLabel(schedule: Schedule) {
  const weeks = [...new Set(schedule.weeks ?? [])].sort((a, b) => a - b);
  if (!weeks.length) return "周次未标注";
  const ranges: Array<[number, number]> = [];
  for (const week of weeks) {
    const last = ranges[ranges.length - 1];
    if (last && week === last[1] + 1) last[1] = week;
    else ranges.push([week, week]);
  }
  return `${ranges
    .map(([start, end]) => (start === end ? start : `${start}-${end}`))
    .join("、")}周`;
}

function schedulesOverlap(first: Schedule, second: Schedule) {
  if (
    first.weekday !== second.weekday ||
    first.block !== second.block ||
    first.term !== second.term
  ) {
    return false;
  }
  const firstWeeks = first.weeks ?? [];
  const secondWeeks = second.weeks ?? [];
  if (!firstWeeks.length || !secondWeeks.length) return true;
  const secondSet = new Set(secondWeeks);
  return firstWeeks.some((week) => secondSet.has(week));
}

function normalize(value: string) {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s·•—_\-（）()]/g, "");
}

function splitClasses(value: string) {
  return value
    .split(/[、，,；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function schoolWeek(date = new Date(), term: Term = "fall") {
  const start = new Date(
    term === "fall"
      ? "2026-08-31T00:00:00+08:00"
      : "2027-03-01T00:00:00+08:00",
  );
  const end = new Date(start.getTime() + 18 * 604_800_000);
  if (date < start)
    return {
      state: "before" as const,
      week: 0,
      days: Math.ceil((start.getTime() - date.getTime()) / 86_400_000),
    };
  if (date >= end) return { state: "after" as const, week: 18, days: 0 };
  return {
    state: "active" as const,
    week: Math.floor((date.getTime() - start.getTime()) / 604_800_000) + 1,
    days: 0,
  };
}

function scheduleOccursInWeek(schedule: Schedule, week: number) {
  if (week < 1 || week > 18) return false;
  if (Array.isArray(schedule.weeks)) return schedule.weeks.includes(week);
  const weekExpression = schedule.timeText.match(/^(.+?周(?:单周|双周)?)/)?.[1];
  if (!weekExpression) return true;
  if (weekExpression.includes("单周") && week % 2 === 0) return false;
  if (weekExpression.includes("双周") && week % 2 !== 0) return false;
  const ranges = [...weekExpression.matchAll(/(\d+)(?:-(\d+))?/g)];
  if (!ranges.length) return true;
  return ranges.some((match) => {
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    return week >= start && week <= end;
  });
}

function daysUntil(date: string) {
  const today = new Date(`${todayISO()}T00:00:00`);
  const target = new Date(`${date}T00:00:00`);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

function dateISO(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function dateAtOffset(offset: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date;
}

function weekdayNumber(date: Date) {
  return date.getDay() || 7;
}

function courseMark(title: string) {
  const clean = title.replace(/[（(].*?[）)]/g, "").replace(/[“”"《》]/g, "");
  return clean.slice(0, 2).toUpperCase();
}

function aliasesForCourse(course: Course) {
  const title = normalize(course.title);
  return Object.entries(courseAliases)
    .filter(([canonical]) => title.includes(normalize(canonical)))
    .flatMap(([, aliases]) => aliases);
}

function viewFromLocation(): View {
  if (typeof window === "undefined") return "home";
  const value = new URL(window.location.href).searchParams.get("view");
  return ["home", "catalog", "schedule", "rooms", "me"].includes(value ?? "")
    ? (value as View)
    : "home";
}

function Wordmark() {
  return (
    <div className="wordmark" aria-label="东财之影">
      <svg viewBox="0 0 72 72" role="img" aria-label="展开的书与坐标">
        <path d="M11 16c11 0 19 3 25 9v34c-6-6-14-9-25-9V16Z" />
        <path d="M61 16c-11 0-19 3-25 9v34c6-6 14-9 25-9V16Z" />
        <circle cx="54" cy="12" r="6" />
        <path
          className="mark-line"
          d="M36 25v34M18 26c6 .5 11 2 15 5M54 26c-6 .5-11 2-15 5"
        />
      </svg>
      <div>
        <strong>
          东财
          <br />
          之影
        </strong>
        <span>课表 · 教室 · 资料</span>
      </div>
    </div>
  );
}

type UiIconName = "home" | "schedule" | "rooms" | "catalog" | "search" | "user";

function UiIcon({ name }: { name: UiIconName }) {
  const paths: Record<UiIconName, React.ReactNode> = {
    home: (
      <>
        <path d="M3.5 9.5 10 4l6.5 5.5" />
        <path d="M5.5 8.5v7.5h9V8.5" />
        <path d="M8.5 16v-4h3v4" />
      </>
    ),
    schedule: (
      <>
        <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
        <path d="M6.5 3v3M13.5 3v3M3.5 8h13M7.5 11h1M11.5 11h1M7.5 14h1M11.5 14h1" />
      </>
    ),
    rooms: (
      <>
        <path d="M4 17V5.5L10 3l6 2.5V17" />
        <path d="M2.5 17h15M7 7h1M12 7h1M7 10h1M12 10h1M8.5 17v-4h3v4" />
      </>
    ),
    catalog: (
      <>
        <path d="M4 4.5h5a2 2 0 0 1 2 2V17H6a2 2 0 0 1-2-2Z" />
        <path d="M16 4.5h-3a2 2 0 0 0-2 2V17h3a2 2 0 0 0 2-2Z" />
      </>
    ),
    search: (
      <>
        <circle cx="9" cy="9" r="5" />
        <path d="m13 13 4 4" />
      </>
    ),
    user: (
      <>
        <circle cx="10" cy="7" r="3" />
        <path d="M4.5 17c.6-3 2.4-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      </>
    ),
  };

  return (
    <svg
      className="ui-icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

function CampusTimeMark({
  nextLabel,
  nextMeta,
}: {
  nextLabel: string;
  nextMeta: string;
}) {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const dayProgress = Math.max(0, Math.min(1, (minutes - 360) / 960));
  const displayTime = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  return (
    <aside
      className="campus-time-mark"
      style={
        {
          "--day-progress": dayProgress,
          "--sun-x": `${4 + dayProgress * 92}%`,
        } as CSSProperties
      }
      aria-label={`校园时间 ${displayTime}，${nextLabel}，${nextMeta}`}
    >
      <div className="time-mark-head">
        <span>DUFE · CAMPUS TIME</span>
        <time dateTime={now.toISOString()}>{displayTime}</time>
      </div>
      <div className="time-mark-track" aria-hidden="true">
        <i />
      </div>
      <div className="time-mark-copy">
        <span>下一项</span>
        <b>{nextLabel}</b>
        <small>{nextMeta}</small>
      </div>
    </aside>
  );
}

function CampusAlmanac() {
  return (
    <section className="campus-almanac" aria-labelledby="campus-almanac-title">
      <header>
        <span>我的东财 · 校园影集</span>
        <h2 id="campus-almanac-title">我们每天走过的<span>东财</span></h2>
        <p>从入校到夜归，方向、灯光和雪把校园写成另一张课表。</p>
      </header>
      <div className="campus-almanac-grid">
        <figure className="campus-scene scene-arrival">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/dufe-welcome-arch.webp"
            alt="东北财经大学 2024 级新生欢迎拱门和校园主楼"
            width="1200"
            height="900"
            loading="lazy"
            decoding="async"
          />
          <figcaption><span>抵达</span><b>2024 新生季，从这里进场</b></figcaption>
        </figure>
        <figure className="campus-scene scene-wayfinding">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/dufe-winter-wayfinding.webp"
            alt="雪夜里指向笃行楼、之远楼和梅园西路的校园路牌"
            width="900"
            height="1200"
            loading="lazy"
            decoding="async"
          />
          <figcaption><span>方向</span><b>雪夜里的路牌</b></figcaption>
        </figure>
        <figure className="campus-scene scene-avenue-day">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/dufe-tree-avenue-day.webp"
            alt="白天的东财林荫路，彩色花带悬在树间"
            width="900"
            height="1200"
            loading="lazy"
            decoding="async"
          />
          <figcaption><span>去上课</span><b>同一条路，白天</b></figcaption>
        </figure>
        <figure className="campus-scene scene-avenue-night">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/dufe-tree-avenue-night.webp"
            alt="夜晚的东财林荫路，路灯照亮树木和花带"
            width="900"
            height="1200"
            loading="lazy"
            decoding="async"
          />
          <figcaption><span>往回走</span><b>同一条路，夜里</b></figcaption>
        </figure>
        <figure className="campus-scene scene-pavilion">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/dufe-winter-pavilion.webp"
            alt="雪夜中的东财红亭"
            width="900"
            height="1200"
            loading="lazy"
            decoding="async"
          />
          <figcaption><span>停一会儿</span><b>红亭，雪夜</b></figcaption>
        </figure>
        <figure className="campus-scene scene-stadium">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/dufe-winter-stadium.webp"
            alt="雪夜中的东北财经大学体育馆"
            width="900"
            height="1200"
            loading="lazy"
            decoding="async"
          />
          <figcaption><span>夜课以后</span><b>雪还在下</b></figcaption>
        </figure>
      </div>
      <figure className="campus-signature">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/dufe-winter-stone-sign.webp"
          alt="雪夜里亮起的东北财经大学校名石"
          width="1200"
          height="900"
          loading="lazy"
          decoding="async"
        />
        <figcaption>
          <span>东财日月志 · 大连</span>
          <b>一场雪把校名擦亮。</b>
        </figcaption>
      </figure>
    </section>
  );
}

function KnowledgeTribute() {
  return (
    <section className="knowledge-tribute">
      <figure className="tribute-photo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/alexandra-elbakyan.jpg"
          alt="Alexandra Elbakyan 在 2010 年 Humanity+ 峰会上"
          width="500"
          height="669"
          loading="lazy"
          decoding="async"
        />
        <figcaption>
          Apneet Jolly ·{" "}
          <a
            href="https://commons.wikimedia.org/wiki/File:Alexandra_Elbakyan_(cropped).jpg"
            target="_blank"
            rel="noreferrer"
          >
            CC BY 2.0
          </a>
        </figcaption>
      </figure>
      <div className="tribute-copy">
        <span>致敬 · Alexandra Elbakyan</span>
        <h2>希望每个人都能更容易地接近知识。</h2>
        <p>
          她在 2011 年创建 Sci-Hub，也让论文获取的门槛被更多人看见。东财之影认同知识应更容易抵达读者；站内资料只收录可合法分享或已获授权的内容。
        </p>
      </div>
      <nav aria-label="了解 Alexandra Elbakyan">
        <a
          className="scihub-link"
          href="https://sci-hub.ru/"
          target="_blank"
          rel="noreferrer nofollow"
        >
          Sci-Hub · 访问网站 ↗
        </a>
        <a
          href="https://www.nature.com/articles/540507a"
          target="_blank"
          rel="noreferrer"
        >
          Nature · 2016 年度人物 ↗
        </a>
        <a
          href="https://www.eff.org/deeplinks/2023/09/eff-award-winner-alexandra-asanova-elbakyan"
          target="_blank"
          rel="noreferrer"
        >
          EFF · 科学知识获取奖 ↗
        </a>
        <a
          href="https://elifesciences.org/articles/32822"
          target="_blank"
          rel="noreferrer"
        >
          eLife · 学术获取研究 ↗
        </a>
      </nav>
    </section>
  );
}

function CreatorsCorner({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="creators-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="creators-darkroom"
        role="dialog"
        aria-modal="true"
        aria-labelledby="creators-title"
      >
        <button
          ref={closeRef}
          className="creators-close"
          onClick={onClose}
          aria-label="关闭创作者合影"
        >
          回到校园 ×
        </button>
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/dufesh-creators.webp"
            alt="东财之影的三位创作者在船上合影"
            width="900"
            height="1200"
            decoding="async"
          />
          <figcaption>网站之外，我们偶尔也出门。</figcaption>
        </figure>
        <div>
          <span>东财之影 · 幕后</span>
          <h2 id="creators-title">三个学生，想把每天上课这件事做得顺手一点。</h2>
          <p>我们在东财上课、赶作业、找自习室，也在课余一起做这个网站。</p>
          <small>始于 2024 · 三个做东西的人</small>
        </div>
      </section>
    </div>
  );
}

export function DufeHubV2() {
  const [data, setData] = useState<SiteData | null>(null);
  const [dataError, setDataError] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/data/course-core.json")
      .then((response) => {
        if (!response.ok) throw new Error("course data unavailable");
        return response;
      })
      .then((response) => response.json() as Promise<CourseCorePayload>)
      .then((payload) => live && setData(inflateCourseCore(payload)))
      .catch(() => live && setDataError(true));
    return () => {
      live = false;
    };
  }, []);
  if (dataError) {
    return (
      <main className="data-loading data-error" role="alert">
        <Wordmark />
        <div>
          <strong>课程数据没有加载成功</strong>
          <p>检查网络连接后重新加载页面。</p>
          <button onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="data-loading" aria-live="polite">
        <Wordmark />
        <div>
          <span>正在加载课程数据</span>
          <i />
        </div>
        <p>稍等一下，马上就好。</p>
      </main>
    );
  }
  return <HubApp data={data} />;
}

type FullDataStatus = "idle" | "loading" | "ready" | "error";

function HubApp({ data: initialData }: { data: SiteData }) {
  const [data, setData] = useState(initialData);
  const [fullDataStatus, setFullDataStatus] =
    useState<FullDataStatus>("idle");
  const fullDataRequestRef = useRef<Promise<void> | null>(null);
  const [view, setView] = useState<View>("home");
  const [term, setTerm] = useState<Term>("fall");
  const [saved, setSaved] = useState<SavedState>(emptySavedState);
  const [hydrated, setHydrated] = useState(false);
  const [personalScope, setPersonalScope] =
    useState<PersonalStorageScope>(anonymousPersonalScope);
  const [anonymousImportAvailable, setAnonymousImportAvailable] =
    useState(false);
  const [cloudUserId, setCloudUserId] = useState("");
  const [cloudSyncReady, setCloudSyncReady] = useState(false);
  const [cloudSyncStatus, setCloudSyncStatus] =
    useState<CloudSyncStatus>("local");
  const [cloudSyncedAt, setCloudSyncedAt] = useState("");
  const [account, setAccount] = useState<AccountState>({
    status: "loading",
    user: null,
    session: null,
    credentialsAvailable: true,
    passwordResetAvailable: false,
    emailVerificationAvailable: false,
    wechatAvailable: false,
  });
  const [authRevision, setAuthRevision] = useState(0);
  const [accountDevices, setAccountDevices] = useState<AccountDevice[]>([]);
  const [onboarding, setOnboarding] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [creatorsOpen, setCreatorsOpen] = useState(false);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [materialsStatus, setMaterialsStatus] =
    useState<MaterialsLoadStatus>("idle");
  const [query, setQuery] = useState("");
  const [searchKind, setSearchKind] = useState<SearchKind>("all");
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [college, setCollege] = useState(data.colleges[0]?.name ?? "");
  const [majorId, setMajorId] = useState(data.colleges[0]?.majorIds[0] ?? "");
  const [year, setYear] = useState(1);
  const [building, setBuilding] = useState(data.buildings[0]);
  const [date, setDate] = useState(todayISO);
  const [block, setBlock] = useState(currentBlock);
  const [roomQuery, setRoomQuery] = useState("");
  const [coursePoolQuery, setCoursePoolQuery] = useState("");
  const [calendarEditor, setCalendarEditor] =
    useState<CalendarEditorRequest | null>(null);
  const savedRef = useRef(saved);
  const termRef = useRef(term);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const materialsRequestRef = useRef<Promise<void> | null>(null);
  const [addFeedback, setAddFeedback] = useState("");

  const loadFullData = useCallback(() => {
    if (fullDataRequestRef.current) return fullDataRequestRef.current;
    setFullDataStatus("loading");
    const request = fetch("/data/course-data.json")
      .then((response) =>
        response.ok
          ? (response.json() as Promise<SiteData>)
          : Promise.reject(new Error("full course data unavailable")),
      )
      .then((payload) => {
        if (
          !COURSE_CATALOG_ID.test(payload.catalogId) ||
          payload.catalogId !== initialData.catalogId
        ) {
          throw new Error("course catalog identity mismatch");
        }
        setData(payload);
        setSelectedCourse((current) =>
          current
            ? payload.courses.find((course) => course.id === current.id) ??
              current
            : null,
        );
        setFullDataStatus("ready");
      })
      .catch(() => {
        setFullDataStatus("error");
        fullDataRequestRef.current = null;
      });
    fullDataRequestRef.current = request;
    return request;
  }, [initialData.catalogId]);

  const loadMaterials = useCallback(() => {
    if (materialsRequestRef.current) return materialsRequestRef.current;
    setMaterialsStatus("loading");
    const request = fetch("/data/resource-manifest.json")
      .then((response) =>
        response.ok
          ? (response.json() as Promise<MaterialManifest>)
          : Promise.reject(new Error("resource manifest unavailable")),
      )
      .then((payload) => {
        setMaterials(payload.materials);
        setMaterialsStatus("ready");
      })
      .catch(() => {
        setMaterials([]);
        setMaterialsStatus("error");
        materialsRequestRef.current = null;
      });
    materialsRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(
        () => void loadMaterials(),
        { timeout: 3500 },
      );
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(() => void loadMaterials(), 1200);
    return () => window.clearTimeout(timer);
  }, [loadMaterials]);

  useEffect(() => {
    if (commandOpen || selectedCourse) {
      void loadMaterials();
      void loadFullData();
    }
  }, [commandOpen, loadFullData, loadMaterials, selectedCourse]);

  const courses = useMemo(
    () => new Map(data.courses.map((item) => [item.id, item])),
    [data.courses],
  );
  const schedules = useMemo(
    () => new Map(data.schedules.map((item) => [item.id, item])),
    [data.schedules],
  );
  const majors = useMemo(
    () => new Map(data.majors.map((item) => [item.id, item])),
    [data.majors],
  );
  const activePlan =
    saved.plans.find((plan) => plan.id === saved.activePlanId) ??
    saved.plans[0];
  const activeSchedules = useMemo(
    () =>
      (activePlan?.scheduleIds ?? [])
        .map((id) => schedules.get(id))
        .filter((item): item is Schedule => Boolean(item)),
    [activePlan, schedules],
  );

  useEffect(() => {
    migrateLegacyPersonalStorage(localStorage);
    const restored = normalizeSavedState(
      readPersonalStorage(localStorage, anonymousPersonalScope),
    );
    queueMicrotask(() => {
      setPersonalScope(anonymousPersonalScope);
      setSaved(restored);
      savedRef.current = restored;
      setHydrated(true);
      if (!restored.profile && !restored.skipped) setOnboarding(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writePersonalStorage(localStorage, personalScope, saved);
  }, [hydrated, personalScope, saved]);

  useEffect(() => {
    savedRef.current = saved;
    termRef.current = term;
  }, [saved, term]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("session_status_unavailable");
        const session = (await response.json()) as {
          authenticated: boolean;
          user: {
            id: string;
            username?: string | null;
            displayName: string | null;
            avatarUrl: string | null;
            email?: string | null;
            emailVerified?: boolean;
            schoolAccount?: string | null;
            schoolAccountVerified?: boolean;
            createdAt?: string;
            lastLoginAt?: string | null;
            status?: string;
            role?: "user" | "moderator" | "admin";
          } | null;
          session?: { expiresAt: string; deviceId: string | null };
          login?: {
            credentialsAvailable?: boolean;
            passwordResetAvailable?: boolean;
            emailVerificationAvailable?: boolean;
            wechatAvailable?: boolean;
          };
        };
        if (!session.authenticated || !session.user?.id) {
          setCloudUserId("");
          setCloudSyncReady(false);
          setCloudSyncStatus("local");
          setCloudSyncedAt("");
          setAccountDevices([]);
          setAnonymousImportAvailable(false);
          setAccount({
            status: "anonymous",
            user: null,
            session: null,
            credentialsAvailable:
              session.login?.credentialsAvailable ?? false,
            passwordResetAvailable:
              session.login?.passwordResetAvailable ?? false,
            emailVerificationAvailable:
              session.login?.emailVerificationAvailable ?? false,
            wechatAvailable: session.login?.wechatAvailable ?? false,
          });
          return;
        }

        const userId = session.user.id;
        const userScope = userPersonalScope(userId);
        const localAccountState = normalizeSavedState(
          readPersonalStorage(localStorage, userScope),
        );
        const anonymousState = normalizeSavedState(
          readPersonalStorage(localStorage, anonymousPersonalScope),
        );
        const canImportAnonymous = hasMeaningfulSavedState(anonymousState);
        const localAtStart = toPersonalSyncState(
          localAccountState,
          termRef.current,
        );
        setPersonalScope(userScope);
        setSaved(localAccountState);
        savedRef.current = localAccountState;
        setOnboarding(
          !localAccountState.profile &&
            !localAccountState.skipped &&
            !canImportAnonymous,
        );
        setAnonymousImportAvailable(canImportAnonymous);
        setCloudUserId(userId);
        setCloudSyncStatus("syncing");
        setAccount({
          status: "authenticated",
          user: session.user,
          session: session.session ?? null,
          credentialsAvailable:
            session.login?.credentialsAvailable ?? false,
          passwordResetAvailable:
            session.login?.passwordResetAvailable ?? false,
          emailVerificationAvailable:
            session.login?.emailVerificationAvailable ?? false,
          wechatAvailable: session.login?.wechatAvailable ?? false,
        });
        const devicesResponse = await fetch("/api/auth/devices", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (devicesResponse.ok) {
          const devicePayload = (await devicesResponse.json()) as {
            devices: AccountDevice[];
          };
          setAccountDevices(devicePayload.devices);
        }
        const result = await synchronizePersonalState({
          userId,
          localState: localAtStart,
          priorMetadata: loadPersonalSyncMetadata(userId),
          signal: controller.signal,
        });
        if (!result) {
          setCloudSyncStatus("offline");
          return;
        }
        savePersonalSyncMetadata(result.metadata);
        setCloudSyncedAt(result.metadata.syncedAt);
        setCloudSyncStatus(
          result.status === "conflict" ? "conflict" : "synced",
        );
        if (
          result.status !== "conflict" &&
          JSON.stringify(
            toPersonalSyncState(savedRef.current, termRef.current),
          ) === JSON.stringify(localAtStart)
        ) {
          setSaved(fromPersonalSyncState(result.state));
          setTerm(result.state.preferredTerm);
        }
        setCloudSyncReady(true);
      } catch (error) {
        if ((error as { name?: string }).name !== "AbortError") {
          setCloudSyncStatus("offline");
          setAccount((current) =>
            current.status === "loading"
              ? {
                  status: "anonymous",
                  user: null,
                  session: null,
                  credentialsAvailable: true,
                  passwordResetAvailable: false,
                  emailVerificationAvailable: false,
                  wechatAvailable: false,
                }
              : current,
          );
          console.warn("个人数据暂未同步，将保留本机数据。");
        }
      }
    })();

    return () => controller.abort();
  }, [authRevision, hydrated]);

  useEffect(() => {
    if (!hydrated || !cloudSyncReady || !cloudUserId) return;
    const metadata = loadPersonalSyncMetadata(cloudUserId);
    if (metadata?.pendingConflicts.length) return;

    const timer = window.setTimeout(() => {
      const localAtStart = toPersonalSyncState(
        savedRef.current,
        termRef.current,
      );
      syncQueueRef.current = syncQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          setCloudSyncStatus("syncing");
          const result = await synchronizePersonalState({
            userId: cloudUserId,
            localState: localAtStart,
            priorMetadata: loadPersonalSyncMetadata(cloudUserId),
          });
          if (!result) return;
          savePersonalSyncMetadata(result.metadata);
          setCloudSyncedAt(result.metadata.syncedAt);
          setCloudSyncStatus(
            result.status === "conflict" ? "conflict" : "synced",
          );
          if (
            result.status !== "conflict" &&
            JSON.stringify(
              toPersonalSyncState(savedRef.current, termRef.current),
            ) === JSON.stringify(localAtStart)
          ) {
            setSaved(fromPersonalSyncState(result.state));
            setTerm(result.state.preferredTerm);
          }
        })
        .catch(() => {
          setCloudSyncStatus("offline");
          console.warn("个人数据暂未同步，将在下次修改后重试。");
        });
    }, 1_500);

    return () => window.clearTimeout(timer);
  }, [cloudSyncReady, cloudUserId, hydrated, saved, term]);

  useEffect(() => {
    document.documentElement.dataset.term = term;
  }, [term]);

  useEffect(() => {
    const syncView = () => setView(viewFromLocation());
    syncView();
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);

  useEffect(() => {
    if (view === "catalog" || view === "schedule" || view === "rooms") {
      void loadFullData();
    }
  }, [loadFullData, view]);

  useEffect(() => {
    if (onboarding) void loadFullData();
  }, [loadFullData, onboarding]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setSelectedCourse(null);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const searchItems = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return [] as SearchItem[];
    const items: Array<SearchItem & { score: number }> = [];
    for (const material of materials) {
      const title = normalize(material.name);
      const courseTitle = normalize(material.courseTitle);
      const haystack = normalize(
        [
          material.name,
          material.courseTitle,
          ...material.courseIds,
          ...(material.teachers ?? []),
          ...(material.tags ?? []),
          material.kind,
          material.extension,
        ].join(" "),
      );
      if (!haystack.includes(needle)) continue;
      items.push({
        key: `material-${material.id}`,
        kind: "material",
        title: material.name,
        meta: `${material.courseTitle} · ${material.kind} · ${formatFileSize(material.sizeBytes)}`,
        material,
        score:
          title === needle
            ? 0
            : title.includes(needle)
              ? 1
              : courseTitle === needle
                ? 2
                : 3,
      });
    }
    for (const course of data.courses) {
      const title = normalize(course.title);
      const aliases = aliasesForCourse(course).map(normalize);
      const haystack = normalize(
        [
          course.title,
          course.id,
          course.college,
          ...course.teachers,
          ...aliases,
        ].join(" "),
      );
      if (!haystack.includes(needle)) continue;
      const score =
        title === needle
          ? 0
          : aliases.includes(needle)
            ? 1
            : title.includes(needle)
              ? 2
              : 3;
      items.push({
        key: `course-${course.id}`,
        kind: "course",
        title: course.title,
        meta: `${course.id} · ${course.teachers.slice(0, 2).join(" / ") || course.college}`,
        course,
        score,
      });
    }
    const teacherSet = new Set<string>();
    const roomSet = new Set<string>();
    for (const schedule of data.schedules) {
      if (
        schedule.teacher &&
        normalize(schedule.teacher).includes(needle) &&
        !teacherSet.has(schedule.teacher)
      ) {
        teacherSet.add(schedule.teacher);
        items.push({
          key: `teacher-${schedule.teacher}`,
          kind: "teacher",
          title: schedule.teacher,
          meta: "查看任课课程与时间",
          teacher: schedule.teacher,
          score: normalize(schedule.teacher) === needle ? 0 : 2,
        });
      }
      const fullRoom = `${schedule.building}${schedule.room}`;
      if (normalize(fullRoom).includes(needle) && !roomSet.has(fullRoom)) {
        roomSet.add(fullRoom);
        items.push({
          key: `room-${fullRoom}`,
          kind: "room",
          title: fullRoom,
          meta: "查看今天哪些时段有课",
          room: schedule.room,
          score: 2,
        });
      }
    }
    return items
      .filter((item) => searchKind === "all" || item.kind === searchKind)
      .sort(
        (a, b) => a.score - b.score || a.title.localeCompare(b.title, "zh-CN"),
      )
      .slice(0, 18);
  }, [data.courses, data.schedules, materials, query, searchKind]);

  const currentWeek = schoolWeek(new Date(), term);
  const nowWeekday = new Date().getDay() || 7;
  const nowBlock = currentBlock();
  const nextClass = activeSchedules
    .filter(
      (item) =>
        item.term === term &&
        currentWeek.state === "active" &&
        scheduleOccursInWeek(item, currentWeek.week) &&
        (item.weekday > nowWeekday ||
          (item.weekday === nowWeekday && item.block >= nowBlock)),
    )
    .sort((a, b) => a.weekday - b.weekday || a.block - b.block)[0];

  function go(next: View) {
    setView(next);
    const url = new URL(window.location.href);
    if (next === "home") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    window.history.pushState({ view: next }, "", `${url.pathname}${url.search}${url.hash}`);
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }

  function updateActivePlan(transform: (ids: string[]) => string[]) {
    setSaved((state) => ({
      ...state,
      plans: state.plans.map((plan) =>
        plan.id === state.activePlanId
          ? { ...plan, scheduleIds: transform(plan.scheduleIds) }
          : plan,
      ),
    }));
  }

  function addSchedules(ids: string[], label?: string) {
    const existing = new Set(activePlan?.scheduleIds ?? []);
    const uniqueIds = [...new Set(ids)];
    const additions = uniqueIds.filter((id) => !existing.has(id));
    if (additions.length) {
      updateActivePlan((current) => [...current, ...additions]);
    }
    const schedule = schedules.get(uniqueIds[0]);
    const title = label || schedule?.title || "课程";
    setAddFeedback(
      additions.length
        ? `${title}的 ${additions.length} 个时段已加入课表`
        : `${title} 已在课表中`,
    );
    window.setTimeout(() => setAddFeedback(""), additions.length ? 1700 : 1300);
    if (additions.length && "vibrate" in navigator) navigator.vibrate(28);
  }

  function addSchedule(id: string) {
    addSchedules([id]);
  }

  function openSearch(kind: SearchKind = "all") {
    setSearchKind(kind);
    setCommandOpen(true);
  }

  function openOnboarding() {
    setOnboarding(true);
    void loadFullData();
  }

  function selectSearchItem(item: SearchItem) {
    setCommandOpen(false);
    if (item.material) {
      window.location.assign(`/materials/${encodeURIComponent(item.material.id)}`);
      return;
    }
    if (item.course) {
      setSelectedCourse(item.course);
      return;
    }
    if (item.teacher) {
      setCoursePoolQuery(item.teacher);
      go("schedule");
      return;
    }
    if (item.room) {
      setRoomQuery(item.room);
      go("rooms");
    }
  }

  const nav: Array<{ id: View; label: string; icon: UiIconName }> = [
    { id: "schedule", label: "我的课表", icon: "schedule" },
    { id: "rooms", label: "空教室", icon: "rooms" },
    { id: "home", label: "今日学习台", icon: "home" },
    { id: "catalog", label: "课程与资料", icon: "catalog" },
    { id: "me", label: "我的", icon: "user" },
  ];
  const fullDataRequired =
    view === "catalog" || view === "schedule" || view === "rooms";

  return (
    <main className="site-shell hub-v2" id="main-content">
      <header className="topbar hub-topbar">
        <button className="brand-button" onClick={() => go("home")}>
          <span>东财之影</span>
          <small>今天学什么，去哪儿学</small>
        </button>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => go(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <UiIcon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="hub-top-actions">
          <button
            className="command-trigger"
            aria-label="搜索全站"
            onClick={() => openSearch()}
          >
            <UiIcon name="search" />
            <span>搜索全站</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="term-switch" aria-label="切换学期">
            <button
              className={term === "fall" ? "active" : ""}
              onClick={() => setTerm("fall")}
            >
              上学期
            </button>
            <button
              className={term === "spring" ? "active" : ""}
              onClick={() => setTerm("spring")}
            >
              下学期
            </button>
          </div>
          <button
            className="profile-dot"
            onClick={() => go("me")}
            aria-label="我的"
          >
            {saved.profile
              ? courseMark(majors.get(saved.profile.majorId)?.name ?? "我")
              : "我"}
          </button>
        </div>
      </header>

      {view === "home" && (
        <HomePage
          data={data}
          saved={saved}
          activeSchedules={activeSchedules}
          nextClass={nextClass}
          week={currentWeek}
          term={term}
          onGo={go}
          onSearch={openSearch}
          onSetup={openOnboarding}
          onEditCalendar={setCalendarEditor}
          onToggleAssignment={(id) =>
            setSaved((state) => ({
              ...state,
              assignments: state.assignments.map((item) =>
                item.id === id
                  ? { ...item, completed: !item.completed }
                  : item,
              ),
            }))
          }
          onDeleteCalendar={(kind, id) =>
            setSaved((state) => ({
              ...state,
              activities:
                kind === "activity"
                  ? state.activities.filter((item) => item.id !== id)
                  : state.activities,
              assignments:
                kind === "assignment"
                  ? state.assignments.filter((item) => item.id !== id)
                  : state.assignments,
            }))
          }
        />
      )}
      {fullDataRequired && fullDataStatus !== "ready" && (
        <div className="page-wrap deferred-data-page" role="status">
          <div className="quiet-empty">
            <b>
              {fullDataStatus === "error"
                ? "完整课程数据没有加载成功"
                : "正在打开完整课程库"}
            </b>
            <p>
              {fullDataStatus === "error"
                ? "检查网络后重试，今日学习台仍可继续使用。"
                : "今日学习台已经可用，课程、课表和空教室数据正在按需加载。"}
            </p>
            {fullDataStatus === "error" && (
              <div>
                <button onClick={() => void loadFullData()}>重新加载</button>
                <button onClick={() => go("home")}>回到今日</button>
              </div>
            )}
          </div>
        </div>
      )}
      {view === "catalog" && fullDataStatus === "ready" && (
        <CatalogPage
          data={data}
          term={term}
          college={college}
          setCollege={setCollege}
          majorId={majorId}
          setMajorId={setMajorId}
          year={year}
          setYear={setYear}
          courses={courses}
          onCourse={setSelectedCourse}
          onSearch={() => window.location.assign("/materials")}
        />
      )}
      {view === "schedule" && fullDataStatus === "ready" && (
        <SchedulePage
          key={term}
          data={data}
          term={term}
          saved={saved}
          setSaved={setSaved}
          activePlan={activePlan}
          activeSchedules={activeSchedules}
          courses={courses}
          query={coursePoolQuery}
          setQuery={setCoursePoolQuery}
          onCourse={setSelectedCourse}
          onAdd={addSchedule}
          onRemove={(id) =>
            updateActivePlan((ids) => ids.filter((item) => item !== id))
          }
          onSetup={openOnboarding}
          onEditCalendar={setCalendarEditor}
        />
      )}
      {view === "rooms" && fullDataStatus === "ready" && (
        <RoomsPage
          data={data}
          term={term}
          building={building}
          setBuilding={setBuilding}
          date={date}
          setDate={setDate}
          block={block}
          setBlock={setBlock}
          query={roomQuery}
          setQuery={setRoomQuery}
          nextClass={nextClass}
          saved={saved}
          setSaved={setSaved}
        />
      )}
      {view === "me" && (
        <MePage
          data={data}
          saved={saved}
          setSaved={setSaved}
          onSetup={openOnboarding}
          account={account}
          devices={accountDevices}
          syncStatus={cloudSyncStatus}
          syncedAt={cloudSyncedAt}
          anonymousImportAvailable={anonymousImportAvailable}
          onLogin={() => {
            if (!account.wechatAvailable) return;
            window.location.assign(
              "/api/auth/wechat/start?returnTo=%2F%3Fview%3Dme",
            );
          }}
          onAuthChanged={() => setAuthRevision((current) => current + 1)}
          onLogout={async () => {
            const response = await fetch("/api/auth/logout", {
              method: "POST",
              credentials: "same-origin",
            });
            if (!response.ok) return;
            const signedOutUserId = cloudUserId || account.user?.id || "";
            if (signedOutUserId) {
              clearPersonalSyncMetadata(signedOutUserId);
              removePersonalStorage(
                localStorage,
                userPersonalScope(signedOutUserId),
              );
            }
            const anonymousState = normalizeSavedState(
              readPersonalStorage(localStorage, anonymousPersonalScope),
            );
            setPersonalScope(anonymousPersonalScope);
            setSaved(anonymousState);
            savedRef.current = anonymousState;
            setOnboarding(!anonymousState.profile && !anonymousState.skipped);
            setAnonymousImportAvailable(false);
            setCloudUserId("");
            setCloudSyncReady(false);
            setCloudSyncStatus("local");
            setCloudSyncedAt("");
            setAccountDevices([]);
            setAccount({
              status: "anonymous",
              user: null,
              session: null,
              credentialsAvailable: account.credentialsAvailable,
              passwordResetAvailable: account.passwordResetAvailable,
              emailVerificationAvailable: account.emailVerificationAvailable,
              wechatAvailable: account.wechatAvailable,
            });
          }}
          onRevokeDevice={async (deviceId) => {
            const response = await fetch("/api/auth/devices", {
              method: "DELETE",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deviceId }),
            });
            if (!response.ok) return;
            const result = (await response.json()) as {
              currentSessionRevoked: boolean;
            };
            if (result.currentSessionRevoked) {
              const revokedUserId = cloudUserId || account.user?.id || "";
              if (revokedUserId) {
                clearPersonalSyncMetadata(revokedUserId);
                removePersonalStorage(
                  localStorage,
                  userPersonalScope(revokedUserId),
                );
              }
              window.location.reload();
              return;
            }
            setAccountDevices((current) =>
              current.filter((device) => device.id !== deviceId),
            );
          }}
          onDeleteAccount={async () => {
            const response = await fetch("/api/auth/account/delete", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                confirmation: "DELETE_MY_ACCOUNT",
              }),
            });
            if (!response.ok) return false;
            const deletedUserId = cloudUserId || account.user?.id || "";
            if (deletedUserId) {
              clearPersonalSyncMetadata(deletedUserId);
              removePersonalStorage(
                localStorage,
                userPersonalScope(deletedUserId),
              );
            }
            const anonymousState = normalizeSavedState(
              readPersonalStorage(localStorage, anonymousPersonalScope),
            );
            setPersonalScope(anonymousPersonalScope);
            setSaved(anonymousState);
            savedRef.current = anonymousState;
            setOnboarding(!anonymousState.profile && !anonymousState.skipped);
            setAnonymousImportAvailable(false);
            setCloudUserId("");
            setCloudSyncReady(false);
            setCloudSyncStatus("local");
            setCloudSyncedAt("");
            setAccountDevices([]);
            setAccount({
              status: "anonymous",
              user: null,
              session: null,
              credentialsAvailable: account.credentialsAvailable,
              passwordResetAvailable: account.passwordResetAvailable,
              emailVerificationAvailable: account.emailVerificationAvailable,
              wechatAvailable: account.wechatAvailable,
            });
            return true;
          }}
          onImportAnonymousData={() => {
            if (!cloudUserId) return;
            const anonymousState = normalizeSavedState(
              readPersonalStorage(localStorage, anonymousPersonalScope),
            );
            const merged = mergeInitialPersonalState(
              toPersonalSyncState(anonymousState, term),
              toPersonalSyncState(savedRef.current, term),
            );
            const mergedSaved = fromPersonalSyncState(merged);
            setSaved(mergedSaved);
            savedRef.current = mergedSaved;
            setOnboarding(!mergedSaved.profile && !mergedSaved.skipped);
            removePersonalStorage(localStorage, anonymousPersonalScope);
            setAnonymousImportAvailable(false);
          }}
          onKeepAnonymousDataSeparate={() => {
            setAnonymousImportAvailable(false);
            setOnboarding(!savedRef.current.profile && !savedRef.current.skipped);
          }}
          onResolveSyncConflict={(choice) => {
            if (!cloudUserId) return;
            const metadata = loadPersonalSyncMetadata(cloudUserId);
            if (!metadata?.pendingConflicts.length) return;
            savePersonalSyncMetadata({
              ...metadata,
              pendingConflicts: [],
            });
            if (choice === "cloud") {
              setSaved(fromPersonalSyncState(metadata.baseState));
              setTerm(metadata.baseState.preferredTerm);
              setCloudSyncStatus("synced");
              return;
            }
            setCloudSyncStatus("syncing");
            setSaved((current) => ({ ...current }));
          }}
        />
      )}

      <footer className="hub-footer">
        <Wordmark />
        <div>
          <strong>非官方学生工具</strong>
          <p>课程、教室和通知如有变动，以学校官方系统为准。</p>
        </div>
        <div className="footer-links">
          <a href="/privacy">隐私政策</a>
          <a href="/terms">用户协议</a>
          <a href="/account/delete">账号注销</a>
          <a
            href="https://ginkgostu.dufe.edu.cn/"
            target="_blank"
            rel="noreferrer"
          >
            白果云 ↗
          </a>
          <a href="https://jwc.dufe.edu.cn/" target="_blank" rel="noreferrer">
            教务处 ↗
          </a>
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noreferrer"
          >
            辽ICP备2026016653号-1
          </a>
        </div>
        <button
          className="backstage-ticket"
          onClick={() => setCreatorsOpen(true)}
          aria-haspopup="dialog"
          aria-label="打开创作者合影"
        >
          <span>幕后 / 03</span>
          <b>谁在捣鼓这个网站？</b>
        </button>
      </footer>

      <nav className="mobile-nav" aria-label="手机主导航">
        {nav.map((item) => (
          <button
            key={item.id}
            className={view === item.id ? "active" : ""}
            onClick={() => go(item.id)}
            aria-current={view === item.id ? "page" : undefined}
          >
            <b><UiIcon name={item.icon} /></b>
            <span>
              {item.label.replace("与资料", "").replace("今日学习台", "今日")}
            </span>
          </button>
        ))}
      </nav>

      {commandOpen && (
        <SearchCommand
          query={query}
          setQuery={setQuery}
          kind={searchKind}
          setKind={setSearchKind}
          items={searchItems}
          onSelect={selectSearchItem}
          onClose={() => setCommandOpen(false)}
        />
      )}
      {selectedCourse && fullDataStatus !== "ready" && (
        <div
          className="modal-backdrop drawer-backdrop"
          onMouseDown={() => setSelectedCourse(null)}
        >
          <aside
            className="course-drawer"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="course-data-loading-title"
          >
            <header>
              <span>课程号 {selectedCourse.id}</span>
              <button
                onClick={() => setSelectedCourse(null)}
                aria-label="关闭课程详情"
              >
                ×
              </button>
            </header>
            <div className="quiet-empty">
              <b id="course-data-loading-title">
                {fullDataStatus === "error"
                  ? "教学班数据没有加载成功"
                  : `正在打开${selectedCourse.title}`}
              </b>
              <p>
                {fullDataStatus === "error"
                  ? "检查网络后重试，课程详情不会使用不完整数据。"
                  : "正在按需加载教师、周次和上课地点。"}
              </p>
              {fullDataStatus === "error" && (
                <button onClick={() => void loadFullData()}>重新加载</button>
              )}
            </div>
          </aside>
        </div>
      )}
      {selectedCourse && fullDataStatus === "ready" && (
        <CourseDrawer
          catalogId={data.catalogId}
          course={selectedCourse}
          materials={materials.filter(
            (item) =>
              item.courseIds.includes(selectedCourse.id) ||
              item.courseTitle === selectedCourse.title,
          )}
          materialsStatus={materialsStatus}
          offerings={data.schedules.filter(
            (item) => item.term === term && item.courseId === selectedCourse.id,
          )}
          activeIds={new Set(activePlan?.scheduleIds ?? [])}
          activeSchedules={activeSchedules}
          onAddMany={addSchedules}
          onClose={() => setSelectedCourse(null)}
        />
      )}
      {calendarEditor && (
        <CalendarEditor
          request={calendarEditor}
          saved={saved}
          setSaved={setSaved}
          courses={courses}
          activeSchedules={activeSchedules}
          onClose={() => setCalendarEditor(null)}
        />
      )}
      {addFeedback && (
        <div className="add-feedback" role="status">
          <i>✓</i>
          <span>{addFeedback}</span>
        </div>
      )}
      {onboarding && fullDataStatus !== "ready" && (
        <div className="modal-backdrop onboarding-backdrop">
          <section
            className="onboarding"
            role="dialog"
            aria-modal="true"
            aria-label="准备课表设置"
          >
            <header>
              <Wordmark />
              <button
                onClick={() => {
                  setSaved((state) => ({ ...state, skipped: true }));
                  setOnboarding(false);
                }}
              >
                暂时跳过
              </button>
            </header>
            <div className="onboarding-copy">
              <p>课表设置</p>
              <h2>
                {fullDataStatus === "error"
                  ? "完整课程数据没有加载成功"
                  : "正在准备班级与教学班数据"}
              </h2>
              <span>
                {fullDataStatus === "error"
                  ? "检查网络后重试，也可以先跳过，稍后从“我的”继续设置。"
                  : "今日学习台已经可用，这部分数据只在设置课表时按需加载。"}
              </span>
            </div>
            {fullDataStatus === "error" && (
              <button onClick={() => void loadFullData()}>重新加载课程数据</button>
            )}
          </section>
        </div>
      )}
      {onboarding && fullDataStatus === "ready" && (
        <Onboarding
          data={data}
          term={term}
          initial={saved.profile}
          onSkip={() => {
            setSaved((state) => ({ ...state, skipped: true }));
            setOnboarding(false);
          }}
          onSave={(profile, scheduleIds) => {
            setSaved((state) => ({
              ...state,
              profile,
              skipped: false,
              plans: state.plans.map((plan) =>
                plan.id === state.activePlanId
                  ? { ...plan, scheduleIds }
                  : plan,
              ),
            }));
            setCollege(profile.college);
            setMajorId(profile.majorId);
            setOnboarding(false);
          }}
        />
      )}
      <CreatorsCorner
        open={creatorsOpen}
        onClose={() => setCreatorsOpen(false)}
      />
    </main>
  );
}

function HomePage({
  data,
  saved,
  activeSchedules,
  nextClass,
  week,
  term,
  onGo,
  onSearch,
  onSetup,
  onEditCalendar,
  onToggleAssignment,
  onDeleteCalendar,
}: {
  data: SiteData;
  saved: SavedState;
  activeSchedules: Schedule[];
  nextClass?: Schedule;
  week: ReturnType<typeof schoolWeek>;
  term: Term;
  onGo: (view: View) => void;
  onSearch: (kind?: SearchKind) => void;
  onSetup: () => void;
  onEditCalendar: (request: CalendarEditorRequest) => void;
  onToggleAssignment: (id: string) => void;
  onDeleteCalendar: (
    kind: CalendarEditorRequest["kind"],
    id: string,
  ) => void;
}) {
  const profileMajor = data.majors.find(
    (item) => item.id === saved.profile?.majorId,
  );
  const today = weekdayNumber(new Date());
  const nowBlock = currentBlock();
  const todayCourses = activeSchedules
    .filter(
      (item) =>
        item.weekday === today &&
        week.state === "active" &&
        scheduleOccursInWeek(item, week.week),
    )
    .sort((a, b) => a.block - b.block);
  const todayActivities = saved.activities
    .filter((item) => item.weekday === today)
    .sort((a, b) => a.block - b.block);
  const todayAssignments = saved.assignments.filter(
    (item) => !item.completed && item.dueDate === todayISO(),
  );
  const freeByBuilding = data.buildings
    .map((name) => {
      const all = data.schedules.filter(
        (item) => item.term === term && item.building === name && item.room,
      );
      const rooms = new Set(all.map((item) => item.room));
      const busy = new Set(
        all
          .filter(
            (item) =>
              item.weekday === today &&
              item.block === nowBlock &&
              week.state === "active" &&
              scheduleOccursInWeek(item, week.week),
          )
          .map((item) => item.room),
      );
      return { name, free: Math.max(rooms.size - busy.size, 0) };
    })
    .sort((a, b) => b.free - a.free);
  const dateText = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
  const weekText =
    week.state === "before"
      ? `距开学 ${week.days} 天`
      : week.state === "active"
        ? `第 ${week.week} 周`
        : "学期已结束";
  const bestBuilding = freeByBuilding[0];
  const nextAssignment = saved.assignments
    .filter((item) => !item.completed)
    .sort(
      (a, b) =>
        new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
    )[0];
  const assignmentCourse = nextAssignment
    ? data.courses.find((item) => item.id === nextAssignment.courseId)
    : undefined;
  const assignmentDays = nextAssignment
    ? daysUntil(nextAssignment.dueDate)
    : null;
  const todayAgenda = [
    ...todayCourses.map((item) => ({
      key: `course-${item.id}`,
      kind: "course" as const,
      order: item.block * 100,
      eyebrow: data.periods[item.block - 1]?.short || `第 ${item.block} 大节`,
      title: item.title,
      meta: `${item.building}${item.room} · ${item.teacher || "教师未标注"}`,
      item,
    })),
    ...todayActivities.map((item) => ({
      key: `activity-${item.id}`,
      kind: "activity" as const,
      order: item.block * 100 + 1,
      eyebrow: data.periods[item.block - 1]?.short || `第 ${item.block} 大节`,
      title: item.title,
      meta: `${item.location || "未设置地点"} · 个人日程`,
      item,
    })),
    ...todayAssignments.map((item) => ({
      key: `assignment-${item.id}`,
      kind: "assignment" as const,
      order: 999,
      eyebrow: "今天截止",
      title: item.title,
      meta: data.courses.find((course) => course.id === item.courseId)?.title ||
        "未关联课程",
      item,
    })),
  ].sort((a, b) => a.order - b.order);
  const upcomingAgenda = Array.from({ length: 7 }, (_, index) => {
    const date = dateAtOffset(index + 1);
    const iso = dateISO(date);
    const weekday = weekdayNumber(date);
    const dateWeek = schoolWeek(date, term);
    const classes = activeSchedules
      .filter(
        (item) =>
          item.weekday === weekday &&
          dateWeek.state === "active" &&
          scheduleOccursInWeek(item, dateWeek.week),
      )
      .map((item) => ({
        key: `future-course-${iso}-${item.id}`,
        kind: "course" as const,
        order: item.block,
        title: item.title,
        meta: `${data.periods[item.block - 1]?.short} · ${item.building}${item.room}`,
        item,
      }));
    const activities = saved.activities
      .filter((item) => item.weekday === weekday)
      .map((item) => ({
        key: `future-activity-${iso}-${item.id}`,
        kind: "activity" as const,
        order: item.block + 0.1,
        title: item.title,
        meta: `${data.periods[item.block - 1]?.short} · ${item.location || "个人日程"}`,
        item,
      }));
    const assignments = saved.assignments
      .filter((item) => !item.completed && item.dueDate === iso)
      .map((item) => ({
        key: `future-assignment-${item.id}`,
        kind: "assignment" as const,
        order: 99,
        title: item.title,
        meta: `${data.courses.find((course) => course.id === item.courseId)?.title || "未关联课程"} · 截止`,
        item,
      }));
    return {
      iso,
      label: new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        weekday: "short",
      }).format(date),
      items: [...classes, ...activities, ...assignments].sort(
        (a, b) => a.order - b.order,
      ),
    };
  }).filter((group) => group.items.length);
  const primaryClass =
    todayCourses.find((item) => item.block >= nowBlock) ?? nextClass;
  const nextThree = todayAgenda
    .filter((item) => item.order >= nowBlock * 100 || item.kind === "assignment")
    .slice(0, 3);
  const campusSuggestion =
    assignmentDays !== null && assignmentDays <= 2
      ? {
          label: "作业提醒",
          title:
            assignmentDays < 0
              ? `${nextAssignment?.title}已经逾期`
              : assignmentDays === 0
                ? `${nextAssignment?.title}今天截止`
                : `${nextAssignment?.title}只剩 ${assignmentDays} 天`,
          detail: assignmentCourse?.title || "课程任务",
          action: "查看作业",
          onClick: () =>
            nextAssignment &&
            onEditCalendar({ kind: "assignment", id: nextAssignment.id }),
        }
      : {
          label: "去自习",
          title: primaryClass
            ? `下一站 ${primaryClass.building}${primaryClass.room}`
            : `${bestBuilding?.name || "教学楼"}当前有 ${bestBuilding?.free ?? 0} 间可用教室`,
          detail: primaryClass
            ? `${data.periods[primaryClass.block - 1]?.time} · 提前查看同楼空教室`
            : `${bestBuilding?.free ?? 0} 间教室在当前节次可用`,
          action: "查看空教室",
          onClick: () => onGo("rooms"),
        };

  return (
    <div className="page-wrap today-page focus-page focus-page-v5">
      <header className="focus-head focus-head-v5">
        <div>
          <span>东财日月志 · {dateText}</span>
          <h1>今日学习台</h1>
        </div>
        <button onClick={() => onSearch()} aria-label="全站搜索">
          <UiIcon name="search" />
        </button>
        <p>
          {term === "fall" ? "上学期" : "下学期"} · {weekText}
          {saved.profile && (
            <small>
              {profileMajor?.name ?? "我的专业"} ·{" "}
              {saved.profile.className || `${saved.profile.entranceYear} 级`}
            </small>
          )}
        </p>
        <CampusTimeMark
          nextLabel={
            primaryClass
              ? primaryClass.title
              : saved.profile
                ? "今天没有后续课程"
                : "先选班级，我来排出今天"
          }
          nextMeta={
            primaryClass
              ? `${data.periods[primaryClass.block - 1]?.short || `第 ${primaryClass.block} 大节`} · ${primaryClass.building}${primaryClass.room}`
              : "课表、日程和空教室都会排到这里"
          }
        />
      </header>

      <nav className="campus-pins" aria-label="东财常用服务">
        <span>校园直达</span>
        <a href={campusLinks.library} target="_blank" rel="noreferrer">
          <i>座</i>
          我去图书馆
          <em>↗</em>
        </a>
        <a href={campusLinks.campusCard} target="_blank" rel="noreferrer">
          <i>码</i>
          校园码
          <em>↗</em>
        </a>
        <a href={campusLinks.ginkgo} target="_blank" rel="noreferrer">
          <i>果</i>
          白果云
          <em>↗</em>
        </a>
      </nav>

      {!saved.profile && (
        <button className="focus-setup" onClick={onSetup}>
          <span>选好专业和班级，就能带入本学期课程</span>
          <b>设置我的课表 →</b>
        </button>
      )}

      <section className="today-command-deck" aria-label="今日关键信息">
        <article className="now-card">
          <header>
            <span>{primaryClass ? "接下来" : "此刻"}</span>
            <small>
              {primaryClass
                ? data.periods[primaryClass.block - 1]?.short
                : "今天没有后续课程"}
            </small>
          </header>
          <div>
            <i>{primaryClass ? courseMark(primaryClass.title) : "空"}</i>
            <span>
              <h2>
                {primaryClass
                  ? primaryClass.title
                  : saved.profile
                    ? "把今天留给自己的安排"
                    : "先选专业和班级"}
              </h2>
              <p>
                {primaryClass
                  ? `${data.periods[primaryClass.block - 1]?.time} · ${primaryClass.building}${primaryClass.room}`
                  : "选好班级后，这里会显示下一节课。"}
              </p>
              {primaryClass && (
                <small>
                  {primaryClass.teacher || "教师未标注"} ·{" "}
                  {scheduleWeeksLabel(primaryClass)}
                </small>
              )}
            </span>
          </div>
          <footer>
            <button onClick={() => onGo("schedule")}>打开课表</button>
            <button onClick={() => onGo("rooms")}>找空教室</button>
          </footer>
        </article>

        <div className="today-side-stack">
          {nextAssignment && (
            <button
              className="assignment-glance"
              onClick={() =>
                onEditCalendar({ kind: "assignment", id: nextAssignment.id })
              }
            >
              <span>最近作业</span>
              <b>
                {assignmentDays !== null && assignmentDays < 0
                  ? `已逾期 ${Math.abs(assignmentDays)} 天`
                  : assignmentDays === 0
                    ? "今天截止"
                    : `${assignmentDays} 天后截止`}
              </b>
              <strong>{nextAssignment.title}</strong>
              <small>{assignmentCourse?.title || "未关联课程"} →</small>
            </button>
          )}
          <button className="campus-suggestion" onClick={campusSuggestion.onClick}>
            <span>{campusSuggestion.label}</span>
            <b>{campusSuggestion.title}</b>
            <small>{campusSuggestion.detail}</small>
            <em>{campusSuggestion.action} →</em>
          </button>
        </div>

        <article className="agenda-glance">
          <header>
            <div>
              <span>今天余下</span>
              <b>{nextThree.length} 项</b>
            </div>
            <button onClick={() => onEditCalendar({ kind: "activity" })}>
              ＋ 日程
            </button>
          </header>
          <div>
            {nextThree.length ? (
              nextThree.map((item) => (
                <button
                  key={`glance-${item.key}`}
                  onClick={() =>
                    item.kind === "course"
                      ? onGo("schedule")
                      : onEditCalendar({ kind: item.kind, id: item.item.id })
                  }
                >
                  <time>{item.eyebrow}</time>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.meta}</small>
                  </span>
                  <em>→</em>
                </button>
              ))
            ) : (
              <div className="agenda-glance-empty">
                <b>眼下没有要紧的事</b>
                <small>要不要找间空教室坐会儿？</small>
              </div>
            )}
          </div>
        </article>
      </section>

      <section className="focus-timeline unified-agenda">
        <header>
          <div>
            <span>今天</span>
            <b>{todayAgenda.length} 项安排</b>
          </div>
          <button onClick={() => onEditCalendar({ kind: "activity" })}>
            ＋ 添加日程
          </button>
        </header>
        <div>
          {todayAgenda.length ? (
            todayAgenda.map((agenda) => (
              <article
                key={agenda.key}
                className={`agenda-row ${agenda.kind} ${agenda.order < nowBlock * 100 ? "past" : ""}`}
              >
                <time>{agenda.eyebrow}</time>
                <span>
                  <em>{agenda.kind === "course" ? "课程" : agenda.kind === "activity" ? "日程" : "作业"}</em>
                  <strong>{agenda.title}</strong>
                  <small>{agenda.meta}</small>
                </span>
                {agenda.kind === "course" ? (
                  <button onClick={() => onGo("schedule")}>查看</button>
                ) : (
                  <div>
                    {agenda.kind === "assignment" && (
                      <button onClick={() => onToggleAssignment(agenda.item.id)}>
                        完成
                      </button>
                    )}
                    <button
                      onClick={() =>
                        onEditCalendar({
                          kind: agenda.kind,
                          id: agenda.item.id,
                        })
                      }
                    >
                      编辑
                    </button>
                    <button
                      className="danger"
                      onClick={() =>
                        onDeleteCalendar(agenda.kind, agenda.item.id)
                      }
                    >
                      删除
                    </button>
                  </div>
                )}
              </article>
            ))
          ) : (
            <div className="agenda-empty">
              <b>今天还没有安排</b>
              <p>上课、自习、社团都可以记在这里。</p>
              <button onClick={() => onEditCalendar({ kind: "activity" })}>
                添加第一项日程
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="week-ahead">
        <header>
          <div>
            <span>接下来七天</span>
            <b>已有安排</b>
          </div>
          <button onClick={() => onGo("schedule")}>管理全部 →</button>
        </header>
        <div>
          {upcomingAgenda.length ? (
            upcomingAgenda.map((group) => (
              <article key={group.iso}>
                <time>{group.label}</time>
                <div>
                  {group.items.map((agenda) => (
                    <button
                      key={agenda.key}
                      onClick={() =>
                        agenda.kind === "course"
                          ? onGo("schedule")
                          : onEditCalendar({
                              kind: agenda.kind,
                              id: agenda.item.id,
                            })
                      }
                    >
                      <i>{agenda.kind === "course" ? "课" : agenda.kind === "activity" ? "程" : "交"}</i>
                      <span>
                        <strong>{agenda.title}</strong>
                        <small>{agenda.meta}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </article>
            ))
          ) : (
            <p>接下来七天还没有安排。</p>
          )}
        </div>
      </section>

      <section className="study-management">
        <header>
          <span>编辑</span>
          <h2>管理学习安排</h2>
        </header>
        <div>
          <button onClick={() => onGo("schedule")}>
            <i>表</i>
            <b>编辑我的课表</b>
            <span>添加、移除课程或导出图片</span>
          </button>
          <button onClick={() => onEditCalendar({ kind: "activity" })}>
            <i>程</i>
            <b>添加个人日程</b>
            <span>自习、社团、考试或生活安排</span>
          </button>
          <button onClick={() => onEditCalendar({ kind: "assignment" })}>
            <i>交</i>
            <b>添加课程作业</b>
            <span>记下截止日，首页会提醒</span>
          </button>
        </div>
      </section>

      <a className="today-community-note" href="/community">
        <span>课间有空再看</span>
        <b>校园回廊</b>
        <em>同学们的讨论 →</em>
      </a>

    </div>
  );
}

function CatalogPage({
  data,
  term,
  college,
  setCollege,
  majorId,
  setMajorId,
  year,
  setYear,
  courses,
  onCourse,
  onSearch,
}: {
  data: SiteData;
  term: Term;
  college: string;
  setCollege: (v: string) => void;
  majorId: string;
  setMajorId: (v: string) => void;
  year: number;
  setYear: (v: number) => void;
  courses: Map<string, Course>;
  onCourse: (c: Course) => void;
  onSearch: (kind?: SearchKind) => void;
}) {
  const collegeMajors = data.majors.filter((item) => item.college === college);
  const selected = data.majors.find((item) => item.id === majorId);
  const items = data.majorCourses
    .filter(
      (item) =>
        item.majorId === majorId && item.term === term && item.year === year,
    )
    .map((item) => courses.get(item.courseId))
    .filter((item): item is Course => Boolean(item))
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.id === item.id) === index,
    )
    .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  return (
    <div className="page-wrap catalog-page-v2">
      <header className="workspace-heading catalog-heading">
        <div>
          <h1>课程与资料</h1>
          <p>按专业浏览四年课程，或直接搜索课程资料。</p>
        </div>
        <button onClick={() => onSearch("material")}>
          <UiIcon name="search" />
          搜索资料
        </button>
      </header>
      <div className="catalog-workspace">
        <aside>
          <label>选择学院</label>
          {data.colleges.map((item, index) => (
            <button
              key={item.name}
              className={college === item.name ? "active" : ""}
              onClick={() => {
                setCollege(item.name);
                setMajorId(item.majorIds[0] ?? "");
              }}
            >
              <i>{String(index + 1).padStart(2, "0")}</i>
              <span>{item.name}</span>
            </button>
          ))}
        </aside>
        <section>
          <div className="catalog-selector">
            <label>
              <span>专业</span>
              <select
                name="catalog-major"
                value={majorId}
                onChange={(event) => setMajorId(event.target.value)}
              >
                {collegeMajors.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              {[1, 2, 3, 4].map((item) => (
                <button
                  key={item}
                  className={year === item ? "active" : ""}
                  onClick={() => setYear(item)}
                >
                  大{"一二三四"[item - 1]}
                </button>
              ))}
            </div>
          </div>
          <div className="major-summary">
            <p>{college}</p>
            <h2>{selected?.name}</h2>
            <span>
              {term === "fall" ? "上学期" : "下学期"} · 大{"一二三四"[year - 1]}{" "}
              · {items.length} 门课程
            </span>
          </div>
          <div className="course-card-grid">
            {items.map((course, index) => (
              <button key={course.id} onClick={() => onCourse(course)}>
                <i>{courseMark(course.title)}</i>
                <span>
                  <small>{course.property || course.category || "课程"}</small>
                  <strong>{course.title}</strong>
                  <p>
                    {course.teachers.slice(0, 2).join(" / ") || "查看课程信息"}
                  </p>
                </span>
                <b>{String(index + 1).padStart(2, "0")}</b>
              </button>
            ))}
          </div>
          {!items.length && (
            <div className="quiet-empty">
              <b>这里暂时没有课程</b>
              <p>换个年级或学期看看。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function DraggableScheduleCard({
  catalogId,
  schedule,
  onOpen,
  onRemove,
}: {
  catalogId: string;
  schedule: Schedule;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id: `schedule:${schedule.id}` });
  const style: CSSProperties | undefined = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : undefined;
  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`draggable-schedule ${isDragging ? "dragging" : ""}`}
      {...attributes}
    >
      <button
        className="schedule-card-main"
        onClick={onOpen}
        {...listeners}
      >
        <strong>{schedule.title}</strong>
        <small>
          {schedule.building}
          {schedule.room}
        </small>
      </button>
      {schedule.teacher && (
        <TeacherRecordLink
          className="schedule-card-teacher-link"
          catalogId={catalogId}
          scheduleId={schedule.id}
          teacherName={schedule.teacher}
        />
      )}
      <button
        className="schedule-card-remove"
        data-export-ignore="true"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        aria-label={`从课表移除 ${schedule.title}`}
      >
        移除
      </button>
    </article>
  );
}

function ScheduleTrash({ active }: { active: boolean }) {
  const { isOver, setNodeRef } = useDroppable({ id: "schedule-trash" });
  return (
    <div
      ref={setNodeRef}
      className={`schedule-trash ${active ? "visible" : ""} ${isOver ? "over" : ""}`}
      aria-hidden={!active}
    >
      <i>×</i>
      <span>{isOver ? "松手移除" : "拖到这里移除"}</span>
    </div>
  );
}

function SchedulePage({
  data,
  term,
  saved,
  setSaved,
  activePlan,
  activeSchedules,
  courses,
  query,
  setQuery,
  onCourse,
  onAdd,
  onRemove,
  onSetup,
  onEditCalendar,
}: {
  data: SiteData;
  term: Term;
  saved: SavedState;
  setSaved: React.Dispatch<React.SetStateAction<SavedState>>;
  activePlan?: Plan;
  activeSchedules: Schedule[];
  courses: Map<string, Course>;
  query: string;
  setQuery: (v: string) => void;
  onCourse: (c: Course) => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onSetup: () => void;
  onEditCalendar: (request: CalendarEditorRequest) => void;
}) {
  const [finderMode, setFinderMode] = useState<"search" | "major" | "time">(
    "search",
  );
  const [finderCollege, setFinderCollege] = useState(
    saved.profile?.college ?? data.colleges[0]?.name ?? "",
  );
  const [finderMajor, setFinderMajor] = useState(
    saved.profile?.majorId ?? data.colleges[0]?.majorIds[0] ?? "",
  );
  const [finderYear, setFinderYear] = useState(
    Math.min(
      4,
      Math.max(1, saved.profile ? 2026 - saved.profile.entranceYear + 1 : 1),
    ),
  );
  const [finderWeekday, setFinderWeekday] = useState(
    Math.min(5, Math.max(1, new Date().getDay())),
  );
  const [finderBlock, setFinderBlock] = useState(currentBlock);
  const [visibleWindow, setVisibleWindow] = useState({ key: "", limit: 40 });
  const [exporting, setExporting] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [mobileScheduleView, setMobileScheduleView] = useState<
    "agenda" | "week"
  >("week");
  const [draggingScheduleId, setDraggingScheduleId] = useState("");
  const [lastRemovedId, setLastRemovedId] = useState("");
  const timetableRef = useRef<HTMLElement>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 350, tolerance: 8 },
    }),
    useSensor(KeyboardSensor),
  );
  const offeringsByCourse = useMemo(() => {
    const grouped = new Map<string, Schedule[]>();
    for (const schedule of data.schedules) {
      if (schedule.term !== term) continue;
      const offerings = grouped.get(schedule.courseId);
      if (offerings) offerings.push(schedule);
      else grouped.set(schedule.courseId, [schedule]);
    }
    return grouped;
  }, [data.schedules, term]);
  const finderKey = JSON.stringify([
    term,
    finderMode,
    finderBlock,
    finderCollege,
    finderMajor,
    finderWeekday,
    finderYear,
    query,
  ]);
  const visibleLimit =
    visibleWindow.key === finderKey ? visibleWindow.limit : 40;
  function resetFinderWindow() {
    setVisibleWindow({ key: "", limit: 40 });
  }
  const needle = normalize(query);
  const searchPool = data.courses.filter(
    (course) =>
      course.terms.includes(term) &&
      (!needle ||
        normalize(
          [
            course.title,
            course.id,
            ...course.teachers,
            ...aliasesForCourse(course),
          ].join(" "),
        ).includes(needle)),
  );
  const majorCourseIds = new Set(
    data.majorCourses
      .filter(
        (item) =>
          item.term === term &&
          item.majorId === finderMajor &&
          item.year === finderYear,
      )
      .map((item) => item.courseId),
  );
  const timeCourseIds = new Set(
    data.schedules
      .filter(
        (item) =>
          item.term === term &&
          item.weekday === finderWeekday &&
          item.block === finderBlock,
      )
      .map((item) => item.courseId),
  );
  const poolAll = (
    finderMode === "search"
      ? searchPool
      : finderMode === "major"
        ? data.courses.filter((course) => majorCourseIds.has(course.id))
        : data.courses.filter((course) => timeCourseIds.has(course.id))
  );
  const pool = poolAll.slice(0, visibleLimit);
  const finderMajors = data.majors.filter(
    (item) => item.college === finderCollege,
  );
  const conflicts = new Set<string>();
  for (const item of activeSchedules)
    if (
      activeSchedules.some(
        (other) =>
          other.id !== item.id &&
          other.weekday === item.weekday &&
          other.block === item.block,
      )
    )
      conflicts.add(item.id);
  const mobileDays = Array.from({ length: 3 }, (_, index) => {
    const day = dateAtOffset(index);
    const weekday = weekdayNumber(day);
    const dateWeek = schoolWeek(day, term);
    return {
      iso: dateISO(day),
      label:
        index === 0
          ? "今天"
          : new Intl.DateTimeFormat("zh-CN", {
              month: "numeric",
              day: "numeric",
              weekday: "short",
            }).format(day),
      entries: [
        ...activeSchedules
          .filter(
            (item) =>
              item.weekday === weekday &&
              dateWeek.state === "active" &&
              scheduleOccursInWeek(item, dateWeek.week),
          )
          .map((item) => ({
            id: `course-${item.id}`,
            kind: "course" as const,
            block: item.block,
            title: item.title,
            meta: `${item.building}${item.room} · ${item.teacher || "教师未标注"}`,
            schedule: item,
          })),
        ...saved.activities
          .filter((item) => item.weekday === weekday)
          .map((item) => ({
            id: `activity-${item.id}`,
            kind: "activity" as const,
            block: item.block,
            title: item.title,
            meta: item.location || "个人日程",
            activity: item,
          })),
      ].sort((a, b) => a.block - b.block),
    };
  });
  function newPlan() {
    const id = `plan-${Date.now()}`;
    setSaved((state) => ({
      ...state,
      plans: [
        ...state.plans,
        {
          id,
          name: `课表方案 ${state.plans.length + 1}`,
          scheduleIds: activePlan?.scheduleIds ?? [],
        },
      ],
      activePlanId: id,
    }));
  }
  function removeSchedule(id: string) {
    onRemove(id);
    setLastRemovedId(id);
    window.setTimeout(
      () => setLastRemovedId((current) => (current === id ? "" : current)),
      4500,
    );
  }
  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id).replace("schedule:", "");
    setDraggingScheduleId(id);
    if ("vibrate" in navigator) navigator.vibrate(12);
  }
  function handleDragEnd(event: DragEndEvent) {
    const id = String(event.active.id).replace("schedule:", "");
    setDraggingScheduleId("");
    if (event.over?.id === "schedule-trash") {
      removeSchedule(id);
      if ("vibrate" in navigator) navigator.vibrate([22, 30, 22]);
    }
  }
  function undoRemove() {
    if (!lastRemovedId) return;
    onAdd(lastRemovedId);
    setLastRemovedId("");
  }
  async function exportTimetable() {
    if (!timetableRef.current || exporting) return;
    setExporting(true);
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(timetableRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#f2eee6",
        filter: (node) =>
          !(node instanceof HTMLElement) ||
          node.dataset.exportIgnore !== "true",
      });
      const link = document.createElement("a");
      link.download = `${activePlan?.name ?? "我的课表"}-${todayISO()}.png`;
      link.href = dataUrl;
      link.click();
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="page-wrap schedule-page clean-workspace">
      <header className="workspace-heading">
        <div>
          <h1>我的课表</h1>
          <p>
            {saved.profile?.className || "还没导入班级课程，也可以手动选课。"}
          </p>
        </div>
        <div className="schedule-heading-actions">
          <button onClick={() => onEditCalendar({ kind: "activity" })}>
            ＋ 添加日程
          </button>
          <button onClick={() => onEditCalendar({ kind: "assignment" })}>
            ＋ 添加作业
          </button>
          <button onClick={onSetup}>
            {saved.profile ? "修改班级" : "导入班级课程"}
          </button>
        </div>
      </header>
      <div className="plan-tabs">
        {saved.plans.map((plan) => (
          <button
            key={plan.id}
            className={saved.activePlanId === plan.id ? "active" : ""}
            onClick={() =>
              setSaved((state) => ({ ...state, activePlanId: plan.id }))
            }
          >
            {plan.name}
            <small>{plan.scheduleIds.length}</small>
          </button>
        ))}
        <button onClick={newPlan}>＋ 新建方案</button>
      </div>
      {finderOpen && (
        <button
          className="finder-backdrop"
          onClick={() => setFinderOpen(false)}
          aria-label="关闭找课程"
        />
      )}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragCancel={() => setDraggingScheduleId("")}
        onDragEnd={handleDragEnd}
      >
        <div className="lineup-workspace">
        <aside className={`course-pool finder-pool ${finderOpen ? "open" : ""}`}>
          <header>
            <div className="finder-title">
              <h2>找课程</h2>
              <button onClick={() => setFinderOpen(false)} aria-label="关闭">
                完成
              </button>
            </div>
            <div className="finder-tabs">
              <button
                className={finderMode === "search" ? "active" : ""}
                onClick={() => {
                  resetFinderWindow();
                  setFinderMode("search");
                }}
              >
                全校搜索
              </button>
              <button
                className={finderMode === "major" ? "active" : ""}
                onClick={() => {
                  resetFinderWindow();
                  setFinderMode("major");
                }}
              >
                按专业
              </button>
              <button
                className={finderMode === "time" ? "active" : ""}
                onClick={() => {
                  resetFinderWindow();
                  setFinderMode("time");
                }}
              >
                按时间
              </button>
            </div>
            {finderMode === "search" && (
              <input
                aria-label="搜索全校课程"
                name="course-search"
                autoComplete="off"
                value={query}
                onChange={(event) => {
                  resetFinderWindow();
                  setQuery(event.target.value);
                }}
                placeholder="课程、简称或教师…"
              />
            )}
            {finderMode === "major" && (
              <div className="major-finder">
                <select
                  aria-label="选择学院"
                  name="finder-college"
                  value={finderCollege}
                  onChange={(event) => {
                    const value = event.target.value;
                    resetFinderWindow();
                    setFinderCollege(value);
                    setFinderMajor(
                      data.colleges.find((item) => item.name === value)
                        ?.majorIds[0] ?? "",
                    );
                  }}
                >
                  {data.colleges.map((item) => (
                    <option key={item.name}>{item.name}</option>
                  ))}
                </select>
                <select
                  aria-label="选择专业"
                  name="finder-major"
                  value={finderMajor}
                  onChange={(event) => {
                    resetFinderWindow();
                    setFinderMajor(event.target.value);
                  }}
                >
                  {finderMajors.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <div>
                  {[1, 2, 3, 4].map((item) => (
                    <button
                      key={item}
                      className={finderYear === item ? "active" : ""}
                      onClick={() => {
                        resetFinderWindow();
                        setFinderYear(item);
                      }}
                    >
                      大{"一二三四"[item - 1]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {finderMode === "time" && (
              <div className="time-finder">
                <div>
                  {weekdayShort.slice(0, 5).map((item, index) => (
                    <button
                      key={item}
                      className={finderWeekday === index + 1 ? "active" : ""}
                      onClick={() => {
                        resetFinderWindow();
                        setFinderWeekday(index + 1);
                      }}
                    >
                      周{item}
                    </button>
                  ))}
                </div>
                <div>
                  {data.periods.map((item) => (
                    <button
                      key={item.block}
                      className={finderBlock === item.block ? "active" : ""}
                      onClick={() => {
                        resetFinderWindow();
                        setFinderBlock(item.block);
                      }}
                    >
                      {item.short}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p>
              {finderMode === "search"
                ? "全校课程"
                : finderMode === "major"
                  ? `大${"一二三四"[finderYear - 1]}课程`
                  : `周${weekdayShort[finderWeekday - 1]} · ${data.periods[finderBlock - 1]?.short}`}{" "}
              · {poolAll.length} 个结果
            </p>
          </header>
          <div>
            {pool.length ? (
              pool.map((course) => {
                const courseOfferings = offeringsByCourse.get(course.id) ?? [];
                const offerings =
                  finderMode === "time"
                    ? courseOfferings.filter(
                        (item) =>
                          item.weekday === finderWeekday &&
                          item.block === finderBlock,
                      )
                    : courseOfferings;
                const first = offerings[0];
                const sectionIds = [
                  ...new Set(
                    offerings.map((item) => item.sectionId ?? item.id),
                  ),
                ];
                const teacherCount = new Set(
                  offerings.map((item) => item.teacher).filter(Boolean),
                ).size;
                return (
                  <article key={course.id}>
                    <button
                      className="course-token"
                      onClick={() => onCourse(course)}
                    >
                      <i>{courseMark(course.title)}</i>
                      <span>
                        <strong>{course.title}</strong>
                        <small>
                          {first
                            ? `${sectionIds.length} 个教学班 · ${teacherCount || 1} 位教师`
                            : course.teachers.slice(0, 2).join(" / ") ||
                              course.id}
                        </small>
                      </span>
                    </button>
                    {first && (
                      <button
                        className="quick-add"
                        onClick={() => {
                          if (sectionIds.length > 1) {
                            onCourse(course);
                            return;
                          }
                          offerings.forEach((item) => onAdd(item.id));
                        }}
                        aria-label={
                          sectionIds.length > 1
                            ? `选择${course.title}的教师和教学班`
                            : `添加${course.title}`
                        }
                      >
                        {sectionIds.length > 1 ? "选" : "＋"}
                      </button>
                    )}
                  </article>
                );
              })
            ) : (
              <p className="pool-empty">没找到课程，换个关键词或条件试试。</p>
            )}
            {pool.length < poolAll.length && (
              <button
                className="load-more-courses"
                onClick={() =>
                  setVisibleWindow({ key: finderKey, limit: visibleLimit + 40 })
                }
              >
                再显示 40 门
                <small>
                  已显示 {pool.length} / {poolAll.length}
                </small>
              </button>
            )}
          </div>
        </aside>
        <section
          className={`timetable-panel ${exporting ? "export-canvas" : ""}`}
          ref={timetableRef}
        >
          <header>
            <div>
              <h2>{activePlan?.name ?? "我的课表"}</h2>
            </div>
            <div className="timetable-tools">
              <p>
                {activeSchedules.length} 个课程时段 ·{" "}
                {conflicts.size ? `${conflicts.size} 个冲突` : "无冲突"}
              </p>
              <button
                className="open-course-finder"
                data-export-ignore="true"
                onClick={() => setFinderOpen(true)}
              >
                ＋ 添加课程
              </button>
              <button
                data-export-ignore="true"
                onClick={exportTimetable}
                disabled={exporting}
              >
                {exporting ? "正在生成…" : "导出图片"}
              </button>
            </div>
          </header>
          <div
            className="mobile-schedule-switch"
            data-export-ignore="true"
            aria-label="切换课表视图"
          >
            <button
              className={mobileScheduleView === "week" ? "active" : ""}
              onClick={() => setMobileScheduleView("week")}
            >
              五天
            </button>
            <button
              className={mobileScheduleView === "agenda" ? "active" : ""}
              onClick={() => setMobileScheduleView("agenda")}
            >
              近日
            </button>
          </div>
          <div
            className={`mobile-schedule-agenda ${mobileScheduleView === "agenda" ? "active" : ""}`}
            data-export-ignore="true"
          >
            {mobileDays.map((day) => (
              <article key={day.iso}>
                <header>
                  <b>{day.label}</b>
                  <small>{day.entries.length} 项</small>
                </header>
                <div>
                  {day.entries.length ? (
                    day.entries.map((entry) => (
                      <button
                        key={entry.id}
                        className={entry.kind}
                        onClick={() =>
                          entry.kind === "course"
                            ? onCourse(courses.get(entry.schedule.courseId)!)
                            : onEditCalendar({
                                kind: "activity",
                                id: entry.activity.id,
                              })
                        }
                      >
                        <time>{data.periods[entry.block - 1]?.short}</time>
                        <span>
                          <strong>{entry.title}</strong>
                          <small>{entry.meta}</small>
                        </span>
                        <em>→</em>
                      </button>
                    ))
                  ) : (
                    <p>这几天没有课或日程</p>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div
            className={`week-overview-scroll ${mobileScheduleView === "week" ? "mobile-active" : ""}`}
          >
          <div className="week-grid">
            <div className="grid-corner">节次</div>
            {weekdayShort.slice(0, 5).map((day) => (
              <div className="day-head" key={day}>
                周{day}
              </div>
            ))}
            {[1, 2, 3, 4].flatMap((itemBlock) => [
              <div className="block-head" key={`b-${itemBlock}`}>
                <b>{itemBlock}</b>
                <span>{data.periods[itemBlock - 1]?.short}</span>
              </div>,
              ...[1, 2, 3, 4, 5].map((weekday) => {
                const cell = activeSchedules.filter(
                  (item) =>
                    item.weekday === weekday && item.block === itemBlock,
                );
                const personal = saved.activities.filter(
                  (item) =>
                    item.weekday === weekday && item.block === itemBlock,
                );
                return (
                  <div
                    className={`schedule-cell ${cell.length + personal.length > 1 ? "conflict" : ""}`}
                    key={`${weekday}-${itemBlock}`}
                    onDoubleClick={() =>
                      onEditCalendar({
                        kind: "activity",
                        weekday,
                        block: itemBlock,
                      })
                    }
                  >
                    {cell.map((item) => (
                      <DraggableScheduleCard
                        key={item.id}
                        catalogId={data.catalogId}
                        schedule={item}
                        onOpen={() => onCourse(courses.get(item.courseId)!)}
                        onRemove={() => removeSchedule(item.id)}
                      />
                    ))}
                    {personal.map((item) => (
                      <button
                        key={item.id}
                        className={`personal-event ${item.color}`}
                        onClick={() =>
                          onEditCalendar({ kind: "activity", id: item.id })
                        }
                      >
                        <strong>{item.title}</strong>
                        <span>个人日程</span>
                        <small>{item.location || "未设置地点"}</small>
                      </button>
                    ))}
                    {!cell.length && !personal.length && (
                      <button
                        className="empty-cell-add"
                        data-export-ignore="true"
                        onClick={() =>
                          onEditCalendar({
                            kind: "activity",
                            weekday,
                            block: itemBlock,
                          })
                        }
                        aria-label={`添加周${weekdayShort[weekday - 1]}第${itemBlock}大节日程`}
                      >
                        ＋
                      </button>
                    )}
                  </div>
                );
              }),
            ])}
          </div>
          </div>
          {!activeSchedules.length && (
            <div className="timetable-empty">
              <b>这张课表还是空的</b>
              <p>点“添加课程”开始选课。</p>
            </div>
          )}
          <section className="personal-planner">
            <header>
              <div>
                <span>我的日程</span>
                <h3>活动与作业</h3>
              </div>
              <div>
                <button
                  onClick={() => onEditCalendar({ kind: "activity" })}
                  data-export-ignore="true"
                >
                  ＋ 活动
                </button>
                <button
                  onClick={() => onEditCalendar({ kind: "assignment" })}
                  data-export-ignore="true"
                >
                  ＋ 作业
                </button>
              </div>
            </header>
            <div className="planner-stream">
              {[
                ...saved.activities.map((item) => ({
                  key: `activity-${item.id}`,
                  kind: "activity" as const,
                  order: item.weekday * 100 + item.block,
                  label: `周${weekdayShort[item.weekday - 1]} · ${data.periods[item.block - 1]?.short}`,
                  title: item.title,
                  meta: item.location || "未设置地点",
                  completed: false,
                  item,
                })),
                ...saved.assignments.map((item) => ({
                  key: `assignment-${item.id}`,
                  kind: "assignment" as const,
                  order: 1000 + new Date(item.dueDate).getTime(),
                  label: item.completed
                    ? "已完成"
                    : daysUntil(item.dueDate) < 0
                      ? `逾期 ${Math.abs(daysUntil(item.dueDate))} 天`
                      : daysUntil(item.dueDate) === 0
                        ? "今天截止"
                        : `${daysUntil(item.dueDate)} 天后`,
                  title: item.title,
                  meta: `${courses.get(item.courseId)?.title || "未关联课程"} · ${item.dueDate}`,
                  completed: item.completed,
                  item,
                })),
              ]
                .sort((a, b) => Number(a.completed) - Number(b.completed) || a.order - b.order)
                .map((entry) => (
                  <article
                    key={entry.key}
                    className={entry.completed ? "completed" : ""}
                  >
                    <time>{entry.label}</time>
                    <span>
                      <em>{entry.kind === "activity" ? "日程" : "作业"}</em>
                      <strong>{entry.title}</strong>
                      <small>{entry.meta}</small>
                    </span>
                    <div>
                      {entry.kind === "assignment" && (
                        <button
                          onClick={() =>
                            setSaved((state) => ({
                              ...state,
                              assignments: state.assignments.map((item) =>
                                item.id === entry.item.id
                                  ? { ...item, completed: !item.completed }
                                  : item,
                              ),
                            }))
                          }
                        >
                          {entry.completed ? "恢复" : "完成"}
                        </button>
                      )}
                      <button
                        onClick={() =>
                          onEditCalendar({
                            kind: entry.kind,
                            id: entry.item.id,
                          })
                        }
                      >
                        编辑
                      </button>
                      <button
                        className="danger"
                        onClick={() =>
                          setSaved((state) => ({
                            ...state,
                            activities:
                              entry.kind === "activity"
                                ? state.activities.filter(
                                    (item) => item.id !== entry.item.id,
                                  )
                                : state.activities,
                            assignments:
                              entry.kind === "assignment"
                                ? state.assignments.filter(
                                    (item) => item.id !== entry.item.id,
                                  )
                                : state.assignments,
                          }))
                        }
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              {!saved.activities.length && !saved.assignments.length && (
                <div className="planner-empty">
                  <b>还没有个人安排</b>
                  <p>把自习、社团或作业截止日记在这里。</p>
                </div>
              )}
            </div>
          </section>
        </section>
      </div>
        <ScheduleTrash active={Boolean(draggingScheduleId)} />
        <DragOverlay>
          {draggingScheduleId ? (
            <div className="schedule-drag-overlay">
              <strong>
                {activeSchedules.find((item) => item.id === draggingScheduleId)
                  ?.title || "课程"}
              </strong>
              <small>拖到下方即可移除</small>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {lastRemovedId && (
        <div className="remove-undo" role="status">
          <span>课程已从当前课表移除</span>
          <button onClick={undoRemove}>撤销</button>
        </div>
      )}
    </div>
  );
}

function CalendarEditor({
  request,
  saved,
  setSaved,
  courses,
  activeSchedules,
  onClose,
}: {
  request: CalendarEditorRequest;
  saved: SavedState;
  setSaved: React.Dispatch<React.SetStateAction<SavedState>>;
  courses: Map<string, Course>;
  activeSchedules: Schedule[];
  onClose: () => void;
}) {
  const activity =
    request.kind === "activity"
      ? saved.activities.find((item) => item.id === request.id)
      : undefined;
  const assignment =
    request.kind === "assignment"
      ? saved.assignments.find((item) => item.id === request.id)
      : undefined;
  const activeCourseIds = [
    ...new Set(activeSchedules.map((item) => item.courseId)),
  ];
  const courseChoices = activeCourseIds
    .map((id) => courses.get(id))
    .filter((item): item is Course => Boolean(item));
  const [title, setTitle] = useState(
    activity?.title ?? assignment?.title ?? "",
  );
  const [weekday, setWeekday] = useState(
    activity?.weekday ??
      (request.kind === "activity" ? request.weekday : undefined) ??
      Math.min(5, Math.max(1, new Date().getDay())),
  );
  const [block, setBlock] = useState(
    activity?.block ??
      (request.kind === "activity" ? request.block : undefined) ??
      currentBlock(),
  );
  const [location, setLocation] = useState(activity?.location ?? "");
  const [color, setColor] = useState<PersonalActivity["color"]>(
    activity?.color ?? "red",
  );
  const [courseId, setCourseId] = useState(
    assignment?.courseId ??
      (request.kind === "assignment" ? request.courseId : undefined) ??
      courseChoices[0]?.id ??
      "",
  );
  const [dueDate, setDueDate] = useState(() => {
    if (assignment?.dueDate) return assignment.dueDate;
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return date.toISOString().slice(0, 10);
  });
  const [notes, setNotes] = useState(
    activity?.notes ?? assignment?.notes ?? "",
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function remove() {
    setSaved((state) => ({
      ...state,
      activities:
        request.kind === "activity"
          ? state.activities.filter((item) => item.id !== request.id)
          : state.activities,
      assignments:
        request.kind === "assignment"
          ? state.assignments.filter((item) => item.id !== request.id)
          : state.assignments,
    }));
    onClose();
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    if (request.kind === "activity") {
      const next: PersonalActivity = {
        id: activity?.id ?? `activity-${Date.now()}`,
        title: cleanTitle,
        weekday,
        block,
        location: location.trim(),
        notes: notes.trim(),
        color,
      };
      setSaved((state) => ({
        ...state,
        activities: activity
          ? state.activities.map((item) => (item.id === activity.id ? next : item))
          : [...state.activities, next],
      }));
    } else {
      const next: Assignment = {
        id: assignment?.id ?? `assignment-${Date.now()}`,
        courseId,
        title: cleanTitle,
        dueDate,
        notes: notes.trim(),
        completed: assignment?.completed ?? false,
      };
      setSaved((state) => ({
        ...state,
        assignments: assignment
          ? state.assignments.map((item) =>
              item.id === assignment.id ? next : item,
            )
          : [...state.assignments, next],
      }));
    }
    onClose();
  }

  return (
    <div className="modal-backdrop calendar-editor-backdrop" onMouseDown={onClose}>
      <form
        className="calendar-editor"
        onSubmit={save}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-editor-title"
      >
        <header>
          <div>
            <span>{request.kind === "activity" ? "个人日程" : "课程任务"}</span>
            <h2 id="calendar-editor-title">
              {request.id
                ? request.kind === "activity"
                  ? "编辑活动"
                  : "编辑作业"
                : request.kind === "activity"
                  ? "添加活动"
                  : "添加作业"}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <label className="editor-title">
          <span>标题</span>
          <input
            name="calendar-title"
            autoComplete="off"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={
              request.kind === "activity" ? "例如：社团例会" : "例如：完成第三章习题"
            }
            required
          />
        </label>

        {request.kind === "activity" ? (
          <>
            <div className="editor-grid">
              <label>
                <span>星期</span>
                <select
                  name="calendar-weekday"
                  value={weekday}
                  onChange={(event) => setWeekday(Number(event.target.value))}
                >
                  {weekdayShort.slice(0, 5).map((day, index) => (
                    <option key={day} value={index + 1}>
                      周{day}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>时间段</span>
                <select
                  name="calendar-block"
                  value={block}
                  onChange={(event) => setBlock(Number(event.target.value))}
                >
                  {[1, 2, 3, 4].map((item) => (
                    <option key={item} value={item}>
                      第 {item} 大节
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              <span>地点</span>
              <input
                name="calendar-location"
                autoComplete="off"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="例如：图书馆三楼"
              />
            </label>
            <fieldset className="event-colors">
              <legend>颜色</legend>
              {(["red", "blue", "green", "amber"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`${item} ${color === item ? "active" : ""}`}
                  onClick={() => setColor(item)}
                  aria-label={`选择${({ red: "朱红", blue: "炭墨", green: "松针", amber: "金色" } as const)[item]}`}
                />
              ))}
            </fieldset>
          </>
        ) : (
          <div className="editor-grid">
            <label>
              <span>关联课程</span>
              <select
                name="assignment-course"
                value={courseId}
                onChange={(event) => setCourseId(event.target.value)}
              >
                <option value="">不关联课程</option>
                {courseChoices.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>截止日期</span>
              <input
                type="date"
                name="assignment-due-date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                required
              />
            </label>
          </div>
        )}

        <label>
          <span>备注</span>
          <textarea
            name="calendar-notes"
            autoComplete="off"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="选填"
            rows={3}
          />
        </label>

        <footer>
          {request.id && (
            <button type="button" className="danger" onClick={remove}>
              删除
            </button>
          )}
          <span />
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit">保存</button>
        </footer>
      </form>
    </div>
  );
}

function RoomsPage({
  data,
  term,
  building,
  setBuilding,
  date,
  setDate,
  block,
  setBlock,
  query,
  setQuery,
  nextClass,
  saved,
  setSaved,
}: {
  data: SiteData;
  term: Term;
  building: string;
  setBuilding: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
  block: number;
  setBlock: (v: number) => void;
  query: string;
  setQuery: (v: string) => void;
  nextClass?: Schedule;
  saved: SavedState;
  setSaved: React.Dispatch<React.SetStateAction<SavedState>>;
}) {
  type RoomStartMode = "now" | "next" | "manual";
  type RoomDuration = "one" | "two" | "until-class";
  const [startMode, setStartMode] = useState<RoomStartMode>("now");
  const [duration, setDuration] = useState<RoomDuration>("one");
  const [floorChoice, setFloorChoice] = useState("");
  const [selectedRoom, setSelectedRoom] = useState("");
  const selectedDate = new Date(`${date}T12:00:00`);
  const weekday = selectedDate.getDay() || 7;
  const selectedWeek = schoolWeek(selectedDate, term);
  const activeThisWeek = (item: Schedule) =>
    selectedWeek.state === "active" &&
    scheduleOccursInWeek(item, selectedWeek.week);
  const nextClassToday =
    nextClass &&
    nextClass.weekday === weekday &&
    selectedWeek.state === "active" &&
    scheduleOccursInWeek(nextClass, selectedWeek.week)
      ? nextClass
      : undefined;
  const targetBlocks =
    duration === "one"
      ? [block]
      : duration === "two"
        ? block < 4
          ? [block, block + 1]
          : []
        : nextClassToday
          ? nextClassToday.block > block
            ? Array.from(
                { length: nextClassToday.block - block },
                (_, index) => block + index,
              )
            : []
          : Array.from({ length: 5 - block }, (_, index) => block + index);
  const roomSchedules = data.schedules.filter(
    (item) =>
      item.term === term && data.buildings.includes(item.building) && item.room,
  );
  const schedulesByRoom = new Map<string, Schedule[]>();
  const roomsByBuilding = new Map<string, string[]>();
  for (const item of roomSchedules) {
    const key = `${item.building}|${item.room}`;
    const schedules = schedulesByRoom.get(key) ?? [];
    schedules.push(item);
    schedulesByRoom.set(key, schedules);
    const rooms = roomsByBuilding.get(item.building) ?? [];
    if (!rooms.includes(item.room)) rooms.push(item.room);
    roomsByBuilding.set(item.building, rooms);
  }
  for (const rooms of roomsByBuilding.values()) {
    rooms.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  }
  const buildingSchedules = roomSchedules.filter(
    (item) => item.building === building,
  );
  const rooms = [...new Set(buildingSchedules.map((item) => item.room))].sort(
    (a, b) => a.localeCompare(b, "zh-CN", { numeric: true }),
  );

  function roomKey(buildingName: string, room: string) {
    return `${buildingName}|${room}`;
  }

  function conflictFor(buildingName: string, room: string) {
    if (!targetBlocks.length) return undefined;
    return (schedulesByRoom.get(roomKey(buildingName, room)) ?? [])
      .filter(
        (item) =>
          item.weekday === weekday &&
          targetBlocks.includes(item.block) &&
          activeThisWeek(item),
      )
      .sort((a, b) => a.block - b.block)[0];
  }

  function roomIsAvailable(buildingName: string, room: string) {
    return targetBlocks.length > 0 && !conflictFor(buildingName, room);
  }

  function roomNextUse(buildingName: string, room: string) {
    const afterBlock = Math.max(block, ...targetBlocks);
    return (schedulesByRoom.get(roomKey(buildingName, room)) ?? [])
      .filter(
        (item) =>
          item.weekday === weekday &&
          item.block > afterBlock &&
          activeThisWeek(item),
      )
      .sort((a, b) => a.block - b.block)[0];
  }

  function availableUntil(buildingName: string, room: string) {
    const next = roomNextUse(buildingName, room);
    return next
      ? `可用至 ${data.periods[next.block - 1]?.time.split("–")[0]}`
      : "今天后面都空着";
  }

  const occupied = new Map(
    rooms
      .map((room) => [room, conflictFor(building, room)] as const)
      .filter(
        (entry): entry is readonly [string, Schedule] => Boolean(entry[1]),
      ),
  );
  const unavailableRooms = new Set(
    rooms.filter((room) => !roomIsAvailable(building, room)),
  );
  const floors = new Map<string, string[]>();
  for (const room of rooms) {
    const floor = room.match(/\d/)?.[0] ?? "?";
    if (!floors.has(floor)) floors.set(floor, []);
    floors.get(floor)!.push(room);
  }
  const sortedFloors = [...floors.entries()].sort(
    (a, b) => Number(b[0]) - Number(a[0]),
  );
  const defaultFloor =
    sortedFloors.find(([floor]) => floor === "1")?.[0] ??
    sortedFloors.at(-1)?.[0] ??
    "";
  const activeFloor = sortedFloors.some(([floor]) => floor === floorChoice)
    ? floorChoice
    : defaultFloor;
  const activeFloorRooms =
    sortedFloors.find(([floor]) => floor === activeFloor)?.[1] ?? [];
  const needle = normalize(query);
  const visibleActiveRooms = activeFloorRooms.filter(
    (room) => !needle || normalize(room).includes(needle),
  );

  const recommendations = data.buildings
    .flatMap((buildingName) =>
      (roomsByBuilding.get(buildingName) ?? []).map((room) => {
        const key = roomKey(buildingName, room);
        const nextUse = roomNextUse(buildingName, room);
        const favorite = saved.favoriteRooms.includes(key);
        const recentIndex = saved.recentRooms.indexOf(key);
        let score = nextUse?.block ?? 5;
        if (buildingName === nextClassToday?.building) score += 30;
        if (buildingName === building) score += 12;
        if (favorite) score += 22;
        if (recentIndex >= 0) score += Math.max(0, 8 - recentIndex);
        const reason = favorite
          ? "你收藏过"
          : buildingName === nextClassToday?.building
            ? "和下一节课同楼"
            : recentIndex >= 0
              ? "最近看过"
              : nextUse
                ? "空闲时间更长"
                : "今天后面没有排课";
        return {
          key,
          building: buildingName,
          room,
          score,
          favorite,
          reason,
          until: availableUntil(buildingName, room),
        };
      }),
    )
    .filter((item) => roomIsAvailable(item.building, item.room))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.building.localeCompare(b.building, "zh-CN") ||
        a.room.localeCompare(b.room, "zh-CN", { numeric: true }),
    )
    .slice(0, 3);

  const startOptions: Array<{
    id: RoomStartMode;
    label: string;
    detail: string;
  }> = [
    { id: "now", label: "现在", detail: "从当前大节开始" },
    { id: "next", label: "下一大节", detail: "提前找好位置" },
    { id: "manual", label: "自己选时间", detail: "用下方日期和节次" },
  ];
  const durationOptions: Array<{
    id: RoomDuration;
    label: string;
    detail: string;
  }> = [
    { id: "one", label: "一大节", detail: "适合短时自习" },
    { id: "two", label: "连续两大节", detail: "中途不用换教室" },
    {
      id: "until-class",
      label: "直到我的下节课",
      detail: nextClassToday ? `空到去${nextClassToday.building}` : "今天剩余时间",
    },
  ];
  const periodLabel = targetBlocks.length
    ? targetBlocks
        .map((item) => data.periods[item - 1]?.short)
        .filter(Boolean)
        .join("、")
    : "今天没有足够的连续时段";
  const selectedPeriod = data.periods[block - 1];
  const startLabel =
    startMode === "now"
      ? `现在 · ${selectedPeriod?.short}`
      : startMode === "next"
        ? `下一大节 · ${selectedPeriod?.short}`
        : `${date.replaceAll("-", "/")} · ${selectedPeriod?.short}`;
  const durationLabel =
    duration === "one"
      ? "一大节"
      : duration === "two"
        ? "连续两大节"
        : "直到我的下节课";
  const querySummary = targetBlocks.length
    ? `${startLabel} · ${durationLabel}`
    : periodLabel;
  const selectedRoomInfo = selectedRoom
    ? {
        key: selectedRoom,
        building: selectedRoom.split("|")[0],
        room: selectedRoom.split("|")[1],
      }
    : null;

  function selectRoom(buildingName: string, room: string) {
    const key = roomKey(buildingName, room);
    setSelectedRoom(key);
    setBuilding(buildingName);
    setFloorChoice(room.match(/\d/)?.[0] ?? "");
    setSaved((state) => ({
      ...state,
      recentRooms: [key, ...state.recentRooms.filter((item) => item !== key)].slice(
        0,
        8,
      ),
    }));
  }

  function toggleFavorite(key: string) {
    setSaved((state) => ({
      ...state,
      favoriteRooms: state.favoriteRooms.includes(key)
        ? state.favoriteRooms.filter((item) => item !== key)
        : [key, ...state.favoriteRooms],
    }));
  }

  function chooseStart(nextMode: RoomStartMode) {
    setStartMode(nextMode);
    if (nextMode === "now") {
      setDate(todayISO());
      setBlock(currentBlock());
      return;
    }
    if (nextMode === "next") {
      const current = currentBlock();
      if (current < 4) {
        setDate(todayISO());
        setBlock(current + 1);
      } else {
        setDate(dateISO(dateAtOffset(1)));
        setBlock(1);
      }
    }
  }

  return (
    <div className="page-wrap rooms-page living-spaces rooms-v5">
      <header className="map-heading">
        <div>
          <span>校园空间</span>
          <h1>空教室</h1>
          <p>
            {nextClass
              ? `下一节在 ${nextClass.building}${nextClass.room}，先找个顺路的位置。`
              : "看看哪间教室正好适合你。"}
          </p>
        </div>
        <div className="room-current-context" aria-label="当前查询时间">
          <span>{weekdayLabels[weekday % 7]} · {date.replaceAll("-", "/")}</span>
          <strong>{selectedPeriod?.short}</strong>
          <small>{selectedPeriod?.time}</small>
        </div>
      </header>

      <nav className="building-tabs" aria-label="选择教学楼">
        {data.buildings.map((item) => {
          const available = (roomsByBuilding.get(item) ?? []).filter((room) =>
            roomIsAvailable(item, room),
          );
          return (
            <button
              key={item}
              className={building === item ? "active" : ""}
              onClick={() => {
                setBuilding(item);
                setFloorChoice("");
              }}
            >
              <span>{item}</span>
              <b>{available.length}</b>
              <small>间空闲</small>
            </button>
          );
        })}
      </nav>

      <section className="indoor-map">
        <nav className="floor-selector" aria-label="选择楼层">
          <span>楼层</span>
          {sortedFloors.map(([floor, floorRooms]) => {
            const free = floorRooms.filter(
              (room) => roomIsAvailable(building, room),
            ).length;
            return (
              <button
                key={floor}
                className={activeFloor === floor ? "active" : ""}
                aria-pressed={activeFloor === floor}
                onClick={() => setFloorChoice(floor)}
              >
                <b>{floor}F</b>
                <small>{free}</small>
              </button>
            );
          })}
        </nav>

        <div className="floor-canvas">
          <header>
            <div>
              <span>
                {building} · {activeFloor} 层
              </span>
              <h2>
                {
                  visibleActiveRooms.filter((room) =>
                    roomIsAvailable(building, room),
                  ).length
                }{" "}
                间可用
              </h2>
            </div>
            <div className="map-legend">
              <span>
                <i className="free" />
                空闲
              </span>
              <span>
                <i className="busy" />
                有课
              </span>
            </div>
          </header>
          <div className="floor-corridor">
            <div className="corridor-line">
              <span>楼层入口</span>
              <i />
              <span>教室区</span>
            </div>
            <div className="floor-rooms-v5">
              {visibleActiveRooms.length ? (
                visibleActiveRooms.map((room, index) => {
                  const lesson = occupied.get(room);
                  const available = !unavailableRooms.has(room);
                  const key = roomKey(building, room);
                  return (
                    <button
                      key={room}
                      className={`${available ? "free" : "busy"} ${selectedRoom === key ? "selected" : ""} ${saved.favoriteRooms.includes(key) ? "favorite" : ""}`}
                      style={{ "--room-order": index } as CSSProperties}
                      onClick={() => selectRoom(building, room)}
                    >
                      <strong>{room}</strong>
                      <span>
                        {available
                          ? availableUntil(building, room)
                          : lesson?.title || "这段时间不连续空闲"}
                      </span>
                    </button>
                  );
                })
              ) : (
                <p>这一层暂时没有符合条件的空教室。</p>
              )}
            </div>
          </div>
        </div>

        <aside className="map-summary">
          <span>符合条件</span>
          <strong>
            {rooms.filter((room) => roomIsAvailable(building, room)).length}
          </strong>
          <small>间教室</small>
          <div>
            <b>
              {selectedWeek.state === "active"
                ? `第 ${selectedWeek.week} 周 · `
                : ""}
              {weekdayLabels[weekday % 7]} · {data.periods[block - 1]?.short}
            </b>
            <p>
              {nextClass
                ? `下一节在${nextClass.building}，同楼的教室已经排在前面。`
                : "空闲教室已按所选时段筛好。"}
            </p>
          </div>
          {selectedRoomInfo && (
            <div className="selected-room-card">
              <span>刚刚查看</span>
              <b>{selectedRoomInfo.building}{selectedRoomInfo.room}</b>
              <small>
                {availableUntil(
                  selectedRoomInfo.building,
                  selectedRoomInfo.room,
                )}
              </small>
              <button onClick={() => toggleFavorite(selectedRoomInfo.key)}>
                {saved.favoriteRooms.includes(selectedRoomInfo.key)
                  ? "★ 已收藏"
                  : "☆ 设为常用"}
              </button>
            </div>
          )}
          <p>{data.disclaimer}</p>
        </aside>
      </section>

      {(saved.favoriteRooms.length > 0 || saved.recentRooms.length > 0) && (
        <nav className="room-memory" aria-label="常用和最近查看的教室">
          <span>{saved.favoriteRooms.length ? "常用" : "最近看过"}</span>
          {(saved.favoriteRooms.length
            ? saved.favoriteRooms
            : saved.recentRooms
          )
            .slice(0, 6)
            .map((key) => {
              const [buildingName, room] = key.split("|");
              return (
                <button
                  key={key}
                  onClick={() => selectRoom(buildingName, room)}
                >
                  {buildingName}{room}
                </button>
              );
            })}
        </nav>
      )}

      <details className="room-tools">
        <summary>
          <span>
            <b>换时间 · 找连续空闲</b>
            <small>{querySummary}</small>
          </span>
          <i aria-hidden="true">展开</i>
        </summary>
        <div className="room-tools-body">
          <section className="room-intents" aria-label="空教室高级筛选">
            <div className="room-intent-groups">
              <div className="room-intent-group">
                <p><span>时间快捷选择</span></p>
                <div>
                  {startOptions.map((item) => (
                    <button
                      key={item.id}
                      className={startMode === item.id ? "active" : ""}
                      onClick={() => chooseStart(item.id)}
                    >
                      <b>{item.label}</b>
                      <span>{item.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="room-intent-group">
                <p><span>连续空闲</span></p>
                <div>
                  {durationOptions.map((item) => (
                    <button
                      key={item.id}
                      className={duration === item.id ? "active" : ""}
                      disabled={item.id === "two" && block >= 4}
                      onClick={() => setDuration(item.id)}
                    >
                      <b>{item.label}</b>
                      <span>{item.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="map-time">
            <label>
              <span>日期</span>
              <input
                type="date"
                name="room-date"
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                  setStartMode("manual");
                }}
              />
            </label>
            <div className="manual-periods">
              <span>起始节次</span>
              <div>
                {data.periods.map((item) => (
                  <button
                    key={item.block}
                    className={block === item.block ? "active" : ""}
                    onClick={() => {
                      setBlock(item.block);
                      setStartMode("manual");
                    }}
                  >
                    <b>{item.short}</b>
                    <span>{item.time}</span>
                  </button>
                ))}
              </div>
            </div>
            <label>
              <span>教室号</span>
              <input
                name="room-number"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如：301…"
              />
            </label>
          </section>

          <section className="room-recommendations">
            <header>
              <div>
                <span>可选建议</span>
                <h2>{recommendations.length ? "优先看看这三间" : "这段时间没有合适的教室"}</h2>
              </div>
              <small>{weekdayLabels[weekday % 7]} · {querySummary}</small>
            </header>
            <div>
              {recommendations.map((item) => (
                <article key={item.key}>
                  <button
                    className="recommendation-main"
                    onClick={() => selectRoom(item.building, item.room)}
                  >
                    <span>{item.reason}</span>
                    <strong>{item.building}{item.room}</strong>
                    <small>{item.until}</small>
                  </button>
                  <button
                    className={item.favorite ? "favorite active" : "favorite"}
                    onClick={() => toggleFavorite(item.key)}
                    aria-label={item.favorite ? "取消收藏" : "收藏教室"}
                  >
                    {item.favorite ? "★" : "☆"}
                  </button>
                </article>
              ))}
              {!recommendations.length && (
                <p>换一个起始节次，或者只查一大节试试。</p>
              )}
            </div>
          </section>
        </div>
      </details>

      <section className="floor-overview">
        <header>
          <h2>整栋楼一览</h2>
          <span>点按楼层进入详细视图</span>
        </header>
        <div>
          {sortedFloors.map(([floor, floorRooms]) => {
            const free = floorRooms.filter((room) =>
              roomIsAvailable(building, room),
            );
            return (
              <button
                key={floor}
                className={activeFloor === floor ? "active" : ""}
                onClick={() => setFloorChoice(floor)}
              >
                <b>{floor}F</b>
                <span>{free.length} 间空闲</span>
                <i
                  style={
                    {
                      "--fill": `${Math.round((free.length / Math.max(1, floorRooms.length)) * 100)}%`,
                    } as CSSProperties
                  }
                />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function MePage({
  data,
  saved,
  setSaved,
  onSetup,
  account,
  devices,
  syncStatus,
  syncedAt,
  anonymousImportAvailable,
  onLogin,
  onAuthChanged,
  onLogout,
  onRevokeDevice,
  onDeleteAccount,
  onImportAnonymousData,
  onKeepAnonymousDataSeparate,
  onResolveSyncConflict,
}: {
  data: SiteData;
  saved: SavedState;
  setSaved: React.Dispatch<React.SetStateAction<SavedState>>;
  onSetup: () => void;
  account: AccountState;
  devices: AccountDevice[];
  syncStatus: CloudSyncStatus;
  syncedAt: string;
  anonymousImportAvailable: boolean;
  onLogin: () => void;
  onAuthChanged: () => void;
  onLogout: () => Promise<void>;
  onRevokeDevice: (deviceId: string) => Promise<void>;
  onDeleteAccount: () => Promise<boolean>;
  onImportAnonymousData: () => void;
  onKeepAnonymousDataSeparate: () => void;
  onResolveSyncConflict: (choice: "local" | "cloud") => void;
}) {
  const major = data.majors.find((item) => item.id === saved.profile?.majorId);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [accountBusy, setAccountBusy] = useState("");
  const [credentialMode, setCredentialMode] = useState<
    "login" | "register" | "reset"
  >("login");
  const [credentialForm, setCredentialForm] = useState({
    username: "",
    email: "",
    identifier: "",
    password: "",
    schoolAccount: "",
    resetToken: "",
  });
  const [credentialFeedback, setCredentialFeedback] = useState("");
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileForm, setProfileForm] = useState({
    username: "",
    displayName: "",
    schoolAccount: "",
  });
  const [profileFeedback, setProfileFeedback] = useState("");
  const [emailVerificationToken, setEmailVerificationToken] = useState("");
  useEffect(() => {
    if (!deleteOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeleteOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deleteOpen]);
  const syncCopy = {
    local: ["只在本机", "登录后可在不同设备继续使用"],
    syncing: ["正在同步", "刚才的修改正在保存"],
    synced: [
      "云端已同步",
      syncedAt
        ? `最近同步 ${new Date(syncedAt).toLocaleString("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}`
        : "课表、日程和作业已保存",
    ],
    conflict: ["需要确认", "同一项内容在两台设备都被修改"],
    offline: ["暂时离线", "本机修改仍会保留，联网后再同步"],
  }[syncStatus];

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    setAccountBusy(`credential-${credentialMode}`);
    setCredentialFeedback("");
    try {
      const isResetConfirmation =
        credentialMode === "reset" && Boolean(credentialForm.resetToken);
      const endpoint =
        credentialMode === "register"
          ? "/api/auth/register"
          : credentialMode === "login"
            ? "/api/auth/login"
            : isResetConfirmation
              ? "/api/auth/password/reset/confirm"
              : "/api/auth/password/reset/request";
      const body =
        credentialMode === "register"
          ? {
              username: credentialForm.username,
              email: credentialForm.email,
              password: credentialForm.password,
              schoolAccount: credentialForm.schoolAccount,
            }
          : credentialMode === "login"
            ? {
                identifier: credentialForm.identifier,
                password: credentialForm.password,
              }
            : isResetConfirmation
              ? {
                  token: credentialForm.resetToken,
                  password: credentialForm.password,
                }
              : { identifier: credentialForm.identifier };
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        debugToken?: string;
        fields?: Record<string, string>;
      };

      if (!response.ok) {
        const fieldMessage = payload.fields
          ? Object.values(payload.fields)[0]
          : "";
        const messages: Record<string, string> = {
          invalid_credentials: "用户名、邮箱或密码不正确。",
          invalid_registration: fieldMessage || "请检查注册信息。",
          registration_conflict: fieldMessage || "用户名或邮箱已被使用。",
          credential_rate_limit_exceeded: "尝试次数过多，请稍后再试。",
          password_reset_rate_limit_exceeded: "请求太频繁，请稍后再试。",
          password_reset_delivery_unavailable:
            "暂时无法通过邮件找回密码；你的原密码不会被更改。",
          invalid_password_reset: "重置链接已失效，或新密码不符合要求。",
        };
        setCredentialFeedback(
          messages[payload.error ?? ""] || "暂时无法连接账号服务，请稍后再试。",
        );
        return;
      }

      if (credentialMode === "reset" && !isResetConfirmation) {
        if (payload.debugToken) {
          setCredentialForm((current) => ({
            ...current,
            resetToken: payload.debugToken ?? "",
            password: "",
          }));
          setCredentialFeedback("已生成一次性重置码，请设置新密码。");
        } else {
          setCredentialFeedback(
            "如果账号存在，重置邮件会在几分钟内到达。",
          );
        }
        return;
      }

      if (credentialMode === "reset") {
        setCredentialMode("login");
        setCredentialForm((current) => ({
          ...current,
          password: "",
          resetToken: "",
        }));
        setCredentialFeedback("密码已更新，请重新登录。所有旧设备已退出。");
        return;
      }

      setCredentialForm((current) => ({ ...current, password: "" }));
      onAuthChanged();
    } catch {
      setCredentialFeedback("账号服务暂时离线，本机课表仍可继续使用。");
    } finally {
      setAccountBusy("");
    }
  };

  const saveAccountProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setAccountBusy("profile");
    setProfileFeedback("");
    try {
      const response = await fetch("/api/auth/profile", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profileForm),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        fields?: Record<string, string>;
      };
      if (!response.ok) {
        const fieldMessage = payload.fields
          ? Object.values(payload.fields)[0]
          : "";
        setProfileFeedback(
          fieldMessage ||
            (payload.error === "profile_conflict"
              ? "这个用户名已被使用。"
              : "资料暂时无法保存，请稍后再试。"),
        );
        return;
      }
      setProfileEditing(false);
      setProfileFeedback("账号资料已保存。");
      onAuthChanged();
    } catch {
      setProfileFeedback("账号服务暂时离线，资料没有更改。");
    } finally {
      setAccountBusy("");
    }
  };

  const uploadAccountAvatar = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setProfileFeedback("头像原图不能超过 5MB。");
      return;
    }
    setAccountBusy("avatar");
    setProfileFeedback("");
    try {
      const response = await fetch("/api/auth/profile/avatar", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        const messages: Record<string, string> = {
          avatar_too_large: "头像原图不能超过 5MB。",
          avatar_type_unsupported: "请使用 JPEG、PNG 或 WebP 图片。",
          avatar_invalid: "图片无法识别，或尺寸不符合要求。",
          avatar_rate_limit_exceeded: "头像修改太频繁，请稍后再试。",
        };
        setProfileFeedback(
          messages[payload.error ?? ""] || "头像暂时无法保存，请稍后再试。",
        );
        return;
      }
      setProfileFeedback("头像已更新；原图与定位信息没有保留。");
      onAuthChanged();
    } catch {
      setProfileFeedback("账号服务暂时离线，头像没有更改。");
    } finally {
      setAccountBusy("");
    }
  };

  const deleteAccountAvatar = async () => {
    setAccountBusy("avatar-delete");
    setProfileFeedback("");
    try {
      const response = await fetch("/api/auth/profile/avatar", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        setProfileFeedback("头像暂时无法删除，请稍后再试。");
        return;
      }
      setProfileFeedback("头像已删除。");
      onAuthChanged();
    } catch {
      setProfileFeedback("账号服务暂时离线，头像没有更改。");
    } finally {
      setAccountBusy("");
    }
  };

  const requestEmailVerification = async () => {
    setAccountBusy("email-verification-request");
    setProfileFeedback("");
    try {
      const response = await fetch("/api/auth/email/verification/request", {
        method: "POST",
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        debugToken?: string;
        alreadyVerified?: boolean;
      };
      if (!response.ok) {
        const messages: Record<string, string> = {
          email_verification_delivery_unavailable:
            "暂时无法发送验证邮件，请稍后再试。",
          email_verification_delivery_failed:
            "验证邮件没有发出，请稍后再试。",
          email_verification_rate_limit_exceeded:
            "验证邮件请求太频繁，请稍后再试。",
          email_verification_unavailable:
            "当前邮箱无法发起验证，请刷新账号资料后重试。",
        };
        setProfileFeedback(
          messages[payload.error ?? ""] || "验证请求没有完成，请稍后再试。",
        );
        return;
      }
      if (payload.alreadyVerified) {
        setProfileFeedback("邮箱已经验证。无需重复操作。");
        onAuthChanged();
      } else if (payload.debugToken) {
        setEmailVerificationToken(payload.debugToken);
        setProfileFeedback("已生成一次性验证令牌，请继续完成验证。");
      } else {
        setProfileFeedback("验证邮件已发送，请在 24 小时内完成验证。");
      }
    } catch {
      setProfileFeedback("账号服务暂时离线，没有发起验证。");
    } finally {
      setAccountBusy("");
    }
  };

  const confirmEmailVerification = async (event: React.FormEvent) => {
    event.preventDefault();
    setAccountBusy("email-verification-confirm");
    setProfileFeedback("");
    try {
      const response = await fetch("/api/auth/email/verification/confirm", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: emailVerificationToken.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setProfileFeedback(
          payload.error === "invalid_email_verification"
            ? "验证令牌无效、已使用或已过期。"
            : "邮箱验证没有完成，请稍后再试。",
        );
        return;
      }
      setEmailVerificationToken("");
      setProfileFeedback("邮箱验证完成。");
      onAuthChanged();
    } catch {
      setProfileFeedback("账号服务暂时离线，邮箱状态没有更改。");
    } finally {
      setAccountBusy("");
    }
  };

  return (
    <div className="page-wrap me-page">
      <header className="workspace-heading">
        <div>
          <h1>我的</h1>
          <p>
            {account.status === "authenticated"
              ? "课表、日程和作业跟着账号走。"
              : "现在可以直接用；注册账号后，课表也能跟你去另一台设备。"}
          </p>
        </div>
        <button onClick={onSetup}>
          {saved.profile ? "修改专业班级" : "设置专业班级"}
        </button>
      </header>
      <div className="me-grid">
        <article className="identity-card">
          <span>个人档案</span>
          <i>{saved.profile ? courseMark(major?.name ?? "我") : "我"}</i>
          <h2>{major?.name ?? "尚未设置专业"}</h2>
          <p>
            {saved.profile
              ? `${saved.profile.entranceYear} 级 · ${saved.profile.className || "未选择班级"}`
              : "选好班级，就能看到自己的课表。"}
          </p>
          <button onClick={onSetup}>编辑</button>
        </article>
        <article>
          <span>课表方案</span>
          <strong>{saved.plans.length}</strong>
          <p>默认、旁听和备选课表分别保存。</p>
        </article>
        <article>
          <span>保存状态</span>
          <strong>{syncCopy[0]}</strong>
          <p>{syncCopy[1]}。</p>
        </article>
        <article>
          <span>隐私</span>
          <strong>只留必要数据</strong>
          <p>不会读取 GPS；只保存你主动填写或使用功能时产生的数据。</p>
        </article>
      </div>
      <section
        className={`account-center account-${account.status}`}
        aria-labelledby="account-center-title"
      >
        <header>
          <div>
            <span>账号与同步</span>
            <h2 id="account-center-title">
              {account.status === "authenticated"
                ? account.user?.displayName || account.user?.username || "同学"
                : account.status === "loading"
                  ? "正在查看登录状态"
                  : "在别的设备继续用"}
            </h2>
            <p>
              {account.status === "authenticated"
                ? "这里管理同步、登录设备和账号。"
                : "登录后由你决定是否导入本机内容，云端课表不会被直接覆盖。"}
            </p>
          </div>
          {account.status === "authenticated" ? (
            account.user?.avatarUrl ? (
              <span
                className="account-avatar"
                aria-hidden="true"
                style={{
                  backgroundImage: `url("${account.user.avatarUrl.replaceAll('"', "%22")}")`,
                }}
              />
            ) : (
              <i>{courseMark(account.user?.displayName || "我")}</i>
            )
          ) : (
            <i>云</i>
          )}
        </header>

        {account.status === "loading" && (
          <div className="account-loading" aria-live="polite">
            <span />
            <p>正在确认这台设备的登录状态…</p>
          </div>
        )}

        {account.status === "anonymous" && (
          <div className="account-login account-login-v2">
            <div className="account-local-note">
              <b>现在的数据只保存在这台设备</b>
              <p>清理微信或浏览器缓存前，请先导出课表图片留存。</p>
            </div>
            {account.credentialsAvailable ? (
              <div className="credential-gateway">
                <nav aria-label="账号操作">
                  <button
                    type="button"
                    aria-pressed={credentialMode === "login"}
                    onClick={() => {
                      setCredentialMode("login");
                      setCredentialFeedback("");
                    }}
                  >
                    登录
                  </button>
                  <button
                    type="button"
                    aria-pressed={credentialMode === "register"}
                    onClick={() => {
                      setCredentialMode("register");
                      setCredentialFeedback("");
                    }}
                  >
                    创建账号
                  </button>
                </nav>
                <form onSubmit={submitCredentials}>
                  {credentialMode === "register" && (
                    <FormField label="用户名" className="credential-field">
                      <input
                        required
                        minLength={3}
                        maxLength={24}
                        autoComplete="username"
                        value={credentialForm.username}
                        onChange={(event) =>
                          setCredentialForm((current) => ({
                            ...current,
                            username: event.target.value,
                          }))
                        }
                        placeholder="以后也可以用它登录"
                      />
                    </FormField>
                  )}
                  {credentialMode === "register" ? (
                    <FormField label="邮箱" className="credential-field">
                      <input
                        required
                        type="email"
                        maxLength={254}
                        autoComplete="email"
                        value={credentialForm.email}
                        onChange={(event) =>
                          setCredentialForm((current) => ({
                            ...current,
                            email: event.target.value,
                          }))
                        }
                        placeholder="用于登录和找回密码"
                      />
                    </FormField>
                  ) : (
                    !credentialForm.resetToken && (
                      <FormField
                        label={credentialMode === "login" ? "用户名或邮箱" : "账号邮箱"}
                        className="credential-field"
                      >
                        <input
                          required
                          maxLength={254}
                          autoComplete={
                            credentialMode === "login" ? "username" : "email"
                          }
                          value={credentialForm.identifier}
                          onChange={(event) =>
                            setCredentialForm((current) => ({
                              ...current,
                              identifier: event.target.value,
                            }))
                          }
                          placeholder={
                            credentialMode === "login"
                              ? "海边自习室 / you@example.com"
                              : "you@example.com"
                          }
                        />
                      </FormField>
                    )
                  )}
                  {(credentialMode !== "reset" || credentialForm.resetToken) && (
                    <FormField
                      label={credentialMode === "reset" ? "新密码" : "密码"}
                      className="credential-field"
                    >
                      <input
                        required
                        type="password"
                        minLength={10}
                        maxLength={128}
                        autoComplete={
                          credentialMode === "login"
                            ? "current-password"
                            : "new-password"
                        }
                        value={credentialForm.password}
                        onChange={(event) =>
                          setCredentialForm((current) => ({
                            ...current,
                            password: event.target.value,
                          }))
                        }
                        placeholder={
                          credentialMode === "login"
                            ? "输入密码"
                            : "至少 10 位，包含文字与数字或符号"
                        }
                      />
                    </FormField>
                  )}
                  {credentialMode === "register" && (
                    <FormField
                      label="校园账号"
                      hint="选填，不会自动认证身份"
                      className="credential-field"
                    >
                      <input
                        maxLength={32}
                        autoComplete="off"
                        value={credentialForm.schoolAccount}
                        onChange={(event) =>
                          setCredentialForm((current) => ({
                            ...current,
                            schoolAccount: event.target.value,
                          }))
                        }
                        placeholder="学号或校园账号"
                      />
                    </FormField>
                  )}
                  {credentialFeedback && (
                    <p className="credential-feedback" aria-live="polite">
                      {credentialFeedback}
                    </p>
                  )}
                  <button
                    className="credential-submit"
                    disabled={accountBusy.startsWith("credential-")}
                  >
                    {credentialMode === "login"
                      ? "登录并同步"
                      : credentialMode === "register"
                        ? "创建账号"
                        : credentialForm.resetToken
                          ? "保存新密码"
                          : "发送重置邮件"}
                  </button>
                </form>
                <footer>
                  {credentialMode === "login" && (
                    <button
                      type="button"
                      disabled={!account.passwordResetAvailable}
                      title={
                        account.passwordResetAvailable
                          ? "找回密码"
                          : "暂时无法通过邮件找回密码"
                      }
                      onClick={() => {
                        setCredentialMode("reset");
                        setCredentialFeedback("");
                      }}
                    >
                      {account.passwordResetAvailable
                        ? "忘记密码？"
                        : "暂不支持邮件找回"}
                    </button>
                  )}
                  <span>密码只以 Argon2id 安全哈希保存</span>
                </footer>
              </div>
            ) : (
              <p className="credential-unavailable">
                账号服务正在维护，本机功能不受影响。
              </p>
            )}
            <div className="wechat-login-row">
              <span>微信入口</span>
              <button
                onClick={onLogin}
                disabled={!account.wechatAvailable}
                title={
                  account.wechatAvailable
                    ? "使用微信账号登录"
                    : "微信登录暂未开放"
                }
              >
                {account.wechatAvailable ? "微信登录" : "暂未开放"}
              </button>
            </div>
          </div>
        )}

        {account.status === "authenticated" && (
          <>
            <section className="account-profile" aria-labelledby="account-profile-title">
              <header>
                <div>
                  <span>账号资料</span>
                  <h3 id="account-profile-title">
                    @{account.user?.username || "未设置用户名"}
                  </h3>
                </div>
                <div className="account-profile-actions">
                  <label>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={accountBusy === "avatar"}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void uploadAccountAvatar(file);
                      }}
                    />
                    <span>
                      {accountBusy === "avatar" ? "正在处理" : "更换头像"}
                    </span>
                  </label>
                  {account.user?.avatarUrl && (
                    <button
                      type="button"
                      disabled={accountBusy === "avatar-delete"}
                      onClick={() => void deleteAccountAvatar()}
                    >
                      删除头像
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (!profileEditing) {
                        setProfileForm({
                          username: account.user?.username ?? "",
                          displayName: account.user?.displayName ?? "",
                          schoolAccount: account.user?.schoolAccount ?? "",
                        });
                      }
                      setProfileEditing((current) => !current);
                      setProfileFeedback("");
                    }}
                  >
                    {profileEditing ? "取消" : "编辑资料"}
                  </button>
                </div>
              </header>
              {profileEditing ? (
                <form onSubmit={saveAccountProfile}>
                  <FormField label="用户名" className="profile-field">
                    <input
                      required
                      minLength={3}
                      maxLength={24}
                      autoComplete="username"
                      value={profileForm.username}
                      onChange={(event) =>
                        setProfileForm((current) => ({
                          ...current,
                          username: event.target.value,
                        }))
                      }
                    />
                  </FormField>
                  <FormField label="显示名" className="profile-field">
                    <input
                      required
                      maxLength={40}
                      autoComplete="nickname"
                      value={profileForm.displayName}
                      onChange={(event) =>
                        setProfileForm((current) => ({
                          ...current,
                          displayName: event.target.value,
                        }))
                      }
                    />
                  </FormField>
                  <FormField
                    label="校园账号"
                    hint="选填，修改后需重新验证"
                    className="profile-field"
                  >
                    <input
                      maxLength={32}
                      autoComplete="off"
                      value={profileForm.schoolAccount}
                      onChange={(event) =>
                        setProfileForm((current) => ({
                          ...current,
                          schoolAccount: event.target.value,
                        }))
                      }
                    />
                  </FormField>
                  {profileFeedback && (
                    <p aria-live="polite">{profileFeedback}</p>
                  )}
                  <button disabled={accountBusy === "profile"}>
                    保存资料
                  </button>
                </form>
              ) : (
                <dl>
                  <div>
                    <dt>邮箱</dt>
                    <dd>{account.user?.email || "未绑定"}</dd>
                    <small>
                      {account.user?.emailVerified ? "已验证" : "待验证"}
                    </small>
                  </div>
                  <div>
                    <dt>校园账号</dt>
                    <dd>{account.user?.schoolAccount || "未填写"}</dd>
                    <small>
                      {account.user?.schoolAccountVerified
                        ? "已验证"
                        : account.user?.schoolAccount
                          ? "未验证，不作为学生身份凭据"
                          : "选填"}
                    </small>
                  </div>
                  <div>
                    <dt>加入时间</dt>
                    <dd>
                      {account.user?.createdAt
                        ? new Date(account.user.createdAt).toLocaleDateString(
                            "zh-CN",
                          )
                        : "—"}
                    </dd>
                    <small>账号状态：正常</small>
                  </div>
                </dl>
              )}
              {!profileEditing &&
                account.user?.email &&
                !account.user.emailVerified && (
                  <div className="account-email-verification">
                    <div>
                      <b>验证邮箱</b>
                      <p>
                        验证后可用于找回账号；验证令牌仅能使用一次。
                      </p>
                    </div>
                    {emailVerificationToken ? (
                      <form onSubmit={confirmEmailVerification}>
                        <FormField label="一次性验证令牌" className="verification-field">
                          <input
                            required
                            maxLength={64}
                            autoComplete="one-time-code"
                            value={emailVerificationToken}
                            onChange={(event) =>
                              setEmailVerificationToken(event.target.value)
                            }
                          />
                        </FormField>
                        <button
                          disabled={
                            accountBusy === "email-verification-confirm"
                          }
                        >
                          {accountBusy === "email-verification-confirm"
                            ? "正在验证"
                            : "完成验证"}
                        </button>
                      </form>
                    ) : account.emailVerificationAvailable ? (
                      <button
                        type="button"
                        disabled={
                          accountBusy === "email-verification-request"
                        }
                        onClick={() => void requestEmailVerification()}
                      >
                        {accountBusy === "email-verification-request"
                          ? "正在生成"
                          : "发送验证邮件"}
                      </button>
                    ) : (
                      <small>验证邮件通道待开通</small>
                    )}
                  </div>
                )}
              {!profileEditing && profileFeedback && (
                <p className="account-profile-feedback" aria-live="polite">
                  {profileFeedback}
                </p>
              )}
            </section>
            {anonymousImportAvailable && (
              <div className="account-import-notice" role="status">
                <div>
                  <b>这台设备还有未登录时保存的内容</b>
                  <p>
                    只有你确认后，才会把那份课表、日程和任务并入当前账号。
                  </p>
                </div>
                <div>
                  <button onClick={onImportAnonymousData}>
                    导入当前账号
                  </button>
                  <button onClick={onKeepAnonymousDataSeparate}>
                    暂不导入
                  </button>
                </div>
              </div>
            )}
            <div className={`sync-state sync-${syncStatus}`}>
              <span>{syncStatus === "synced" ? "✓" : syncStatus === "conflict" ? "!" : "↻"}</span>
              <div>
                <b>{syncCopy[0]}</b>
                <p>{syncCopy[1]}</p>
              </div>
              {syncStatus === "conflict" && (
                <div className="sync-conflict-actions">
                  <button onClick={() => onResolveSyncConflict("local")}>
                    保留本机修改
                  </button>
                  <button onClick={() => onResolveSyncConflict("cloud")}>
                    使用云端版本
                  </button>
                </div>
              )}
            </div>

            <div className="device-center">
              <header>
                <div>
                  <span>登录设备</span>
                  <h3>{devices.length || 1} 台设备</h3>
                </div>
                <small>不认识的设备可以立即退出</small>
              </header>
              <div>
                {devices.map((device) => (
                  <article key={device.id}>
                    <i>{device.current ? "本" : "端"}</i>
                    <div>
                      <b>
                        {device.current ? "当前设备" : device.label}
                        {device.active && <em>在线</em>}
                      </b>
                      <small>
                        最近使用{" "}
                        {new Date(device.lastSeenAt).toLocaleString("zh-CN", {
                          month: "numeric",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </small>
                    </div>
                    <button
                      disabled={accountBusy === device.id}
                      onClick={async () => {
                        setAccountBusy(device.id);
                        await onRevokeDevice(device.id);
                        setAccountBusy("");
                      }}
                    >
                      {device.current ? "退出此设备" : "移除"}
                    </button>
                  </article>
                ))}
              </div>
            </div>

            <footer className="account-actions">
              {account.user?.role === "admin" && (
                <a href="/admin">进入值守台</a>
              )}
              <button
                disabled={Boolean(accountBusy)}
                onClick={async () => {
                  setAccountBusy("logout");
                  await onLogout();
                  setAccountBusy("");
                }}
              >
                退出登录
              </button>
              <button onClick={() => setDeleteOpen(true)}>注销账号</button>
            </footer>
          </>
        )}
      </section>
      <a className="community-corridor-entry" href="/community">
        <i aria-hidden="true" />
        <span>
          <small>校园回廊</small>
          <b>看看同学们最近在讨论什么</b>
        </span>
        <em>进入 →</em>
      </a>
      <section className="campus-gateway" aria-labelledby="campus-gateway-title">
        <header>
          <span>东财常用</span>
          <h2 id="campus-gateway-title">学校服务直达</h2>
          <p>在当前手机打开学校服务，不经过本站中转。</p>
        </header>
        <nav aria-label="东财常用服务">
          <a href={campusLinks.library} target="_blank" rel="noreferrer">
            <i>座</i>
            <span>
              <b>我去图书馆</b>
              <small>预约常用座位</small>
            </span>
            <em>↗</em>
          </a>
          <a href={campusLinks.campusCard} target="_blank" rel="noreferrer">
            <i>码</i>
            <span>
              <b>东财校园码</b>
              <small>打开个人校园码</small>
            </span>
            <em>↗</em>
          </a>
          <a href={campusLinks.ginkgo} target="_blank" rel="noreferrer">
            <i>果</i>
            <span>
              <b>白果云</b>
              <small>签到与课程通知</small>
            </span>
            <em>↗</em>
          </a>
        </nav>
        {xiaoyingServiceUrl && (
          <a className="campus-lab-entry" href={xiaoyingServiceUrl}>
            小影内测 · <span>需邀请码</span> →
          </a>
        )}
      </section>
      <CampusAlmanac />
      <KnowledgeTribute />
      <section className="trust-panel">
        <div>
          <h2>本机数据由你控制</h2>
        </div>
        <p>
          清除后，这台设备上的专业、课表、日程和作业会被移除；已登录账号的云端内容不受影响。
        </p>
        <button
          onClick={() => {
            if (confirm("确认清除这台设备上的专业、课表、日程和作业吗？"))
              setSaved(emptySavedState);
          }}
        >
          清除本机数据
        </button>
      </section>
      {deleteOpen && (
        <div
          className="modal-backdrop account-delete-backdrop"
          onMouseDown={() => setDeleteOpen(false)}
        >
          <section
            className="account-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span>不可撤销</span>
            <h2 id="delete-account-title">注销东财之影账号</h2>
            <p>
              所有设备都会退出，云端课表、日程、作业和偏好将永久删除。
            </p>
            <label>
              <span>输入“注销账号”继续</span>
              <input
                name="delete-account-confirmation"
                autoComplete="off"
                value={deletePhrase}
                onChange={(event) => setDeletePhrase(event.target.value)}
                placeholder="注销账号"
              />
            </label>
            <div>
              <button onClick={() => setDeleteOpen(false)}>取消</button>
              <button
                disabled={
                  deletePhrase !== "注销账号" || accountBusy === "delete"
                }
                onClick={async () => {
                  setAccountBusy("delete");
                  const deleted = await onDeleteAccount();
                  setAccountBusy("");
                  if (deleted) {
                    setDeleteOpen(false);
                    setDeletePhrase("");
                  }
                }}
              >
                确认注销
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SearchCommand({
  query,
  setQuery,
  kind,
  setKind,
  items,
  onSelect,
  onClose,
}: {
  query: string;
  setQuery: (v: string) => void;
  kind: SearchKind;
  setKind: (v: SearchKind) => void;
  items: SearchItem[];
  onSelect: (item: SearchItem) => void;
  onClose: () => void;
}) {
  const kinds: Array<[SearchKind, string]> = [
    ["all", "全部"],
    ["material", "资料"],
    ["course", "课程"],
    ["teacher", "教师"],
    ["room", "教室"],
  ];
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="command-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="全站搜索"
      >
        <header>
          <span><UiIcon name="search" /></span>
          <input
            autoFocus
            aria-label="搜索课程、资料、教师或教室"
            name="global-search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索课程、资料、教师或教室…"
          />
          <button onClick={onClose} aria-label="关闭全站搜索">ESC</button>
        </header>
        <nav>
          {kinds.map(([id, label]) => (
            <button
              key={id}
              className={kind === id ? "active" : ""}
              onClick={() => setKind(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="command-results">
          {query.trim() ? (
            items.length ? (
              items.map((item) => (
                <button key={item.key} onClick={() => onSelect(item)}>
                  <i>
                    {item.kind === "material"
                      ? "资料"
                      : item.kind === "course"
                        ? "课程"
                        : item.kind === "teacher"
                          ? "教师"
                          : "教室"}
                  </i>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.meta}</small>
                  </span>
                  <b>↗</b>
                </button>
              ))
            ) : (
              <div className="search-zero">
                <strong>没搜到</strong>
                <p>
                  试试课程简称、课程号、教师姓名或教室。
                </p>
              </div>
            )
          ) : (
            <div className="search-hints">
              <span>试着搜</span>
              <button onClick={() => setQuery("中财")}>中财</button>
              <button onClick={() => setQuery("高数")}>高数</button>
              <button onClick={() => setQuery("笃行楼")}>笃行楼</button>
            </div>
          )}
        </div>
        <footer>
          <span>↑↓ 浏览</span>
          <span>Enter 打开</span>
          <span>Ctrl / ⌘ K 唤起</span>
        </footer>
      </section>
    </div>
  );
}

function CourseDrawer({
  catalogId,
  course,
  materials,
  materialsStatus,
  offerings,
  activeIds,
  activeSchedules,
  onAddMany,
  onClose,
}: {
  catalogId: string;
  course: Course;
  materials: Material[];
  materialsStatus: MaterialsLoadStatus;
  offerings: Schedule[];
  activeIds: Set<string>;
  activeSchedules: Schedule[];
  onAddMany: (ids: string[], label?: string) => void;
  onClose: () => void;
}) {
  const [sectionQuery, setSectionQuery] = useState("");
  const [teacherFilter, setTeacherFilter] = useState("all");
  const [weekdayFilter, setWeekdayFilter] = useState(0);
  const [blockFilter, setBlockFilter] = useState(0);
  const [weekFilter, setWeekFilter] = useState(0);
  const [buildingFilter, setBuildingFilter] = useState("all");
  const [conflictFilter, setConflictFilter] = useState<
    "all" | "available" | "conflict"
  >("all");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const sectionMap = new Map<string, Schedule[]>();
  for (const offering of offerings) {
    const sectionKey =
      offering.sectionId ??
      `${offering.courseId}-${offering.teacher}-${offering.classNames}`;
    const section = sectionMap.get(sectionKey) ?? [];
    section.push(offering);
    sectionMap.set(sectionKey, section);
  }
  const sections = [...sectionMap.entries()]
    .map(([id, meetings]) => ({
      id,
      meetings: meetings.sort(
        (a, b) => a.weekday - b.weekday || a.block - b.block,
      ),
      conflict: meetings.some((meeting) =>
        activeSchedules.some(
          (active) =>
            active.id !== meeting.id && schedulesOverlap(meeting, active),
        ),
      ),
    }))
    .sort((a, b) => {
      const firstA = a.meetings[0];
      const firstB = b.meetings[0];
      return (
        firstA.teacher.localeCompare(firstB.teacher, "zh-CN") ||
        firstA.classNames.localeCompare(firstB.classNames, "zh-CN")
      );
    });
  const teachers = [
    ...new Set(sections.map((section) => section.meetings[0]?.teacher).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const offeringBuildings = [
    ...new Set(
      offerings.map((offering) => offering.building).filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const sectionNeedle = normalize(sectionQuery);
  const filteredSections = sections.filter((section) => {
    const first = section.meetings[0];
    if (!first) return false;
    if (teacherFilter !== "all" && first.teacher !== teacherFilter) return false;
    if (
      weekdayFilter &&
      !section.meetings.some((meeting) => meeting.weekday === weekdayFilter)
    ) {
      return false;
    }
    if (
      blockFilter &&
      !section.meetings.some((meeting) => meeting.block === blockFilter)
    ) {
      return false;
    }
    if (
      weekFilter &&
      !section.meetings.some((meeting) =>
        scheduleOccursInWeek(meeting, weekFilter),
      )
    ) {
      return false;
    }
    if (
      buildingFilter !== "all" &&
      !section.meetings.some(
        (meeting) => meeting.building === buildingFilter,
      )
    ) {
      return false;
    }
    if (conflictFilter === "available" && section.conflict) return false;
    if (conflictFilter === "conflict" && !section.conflict) return false;
    if (
      sectionNeedle &&
      !normalize(
        section.meetings
          .map(
            (meeting) =>
              `${meeting.teacher} ${meeting.classNames} ${meeting.building}${meeting.room} ${meeting.timeText}`,
          )
          .join(" "),
      ).includes(sectionNeedle)
    ) {
      return false;
    }
    return true;
  });
  const comparedSections = compareIds
    .map((id) => sections.find((section) => section.id === id))
    .filter((section): section is (typeof sections)[number] => Boolean(section));

  function toggleCompare(id: string) {
    setCompareIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length < 4
          ? [...current, id]
          : [...current.slice(1), id],
    );
  }

  return (
    <div className="modal-backdrop drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="course-drawer"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="course-drawer-title"
      >
        <header>
          <span>课程号 {course.id}</span>
          <button onClick={onClose} aria-label="关闭课程详情">×</button>
        </header>
        <div className="course-drawer-title">
          <i>{courseMark(course.title)}</i>
          <div>
            <p>{course.college}</p>
            <h2 id="course-drawer-title">{course.title}</h2>
            <span>
              {course.credits
                ? `${Number(course.credits)} 学分`
                : course.property || course.category}
            </span>
          </div>
        </div>
        <section className="course-offerings-section">
          <div className="drawer-section-heading">
            <div>
              <span className="drawer-label">选择教学班</span>
              <small>
                {sections.length} 个教学班 ·{" "}
                {new Set(offerings.map((item) => item.teacher).filter(Boolean)).size}{" "}
                位教师
              </small>
            </div>
            <em>最多同时比较 4 个教学班</em>
          </div>
          <div className="section-filter-bar">
            <input
              aria-label="搜索教学班"
              name="section-search"
              autoComplete="off"
              value={sectionQuery}
              onChange={(event) => setSectionQuery(event.target.value)}
              placeholder="搜教师、班级或教室…"
            />
            <select
              value={teacherFilter}
              onChange={(event) => setTeacherFilter(event.target.value)}
              aria-label="按教师筛选"
            >
              <option value="all">全部教师</option>
              {teachers.map((teacher) => (
                <option key={teacher} value={teacher}>
                  {teacher}
                </option>
              ))}
            </select>
            <select
              value={weekdayFilter}
              onChange={(event) => setWeekdayFilter(Number(event.target.value))}
              aria-label="按星期筛选"
            >
              <option value={0}>全部星期</option>
              {weekdayShort.slice(0, 5).map((day, index) => (
                <option key={day} value={index + 1}>
                  周{day}
                </option>
              ))}
            </select>
            <select
              value={blockFilter}
              onChange={(event) => setBlockFilter(Number(event.target.value))}
              aria-label="按节次筛选"
            >
              <option value={0}>全部节次</option>
              {[1, 2, 3, 4].map((item) => (
                <option key={item} value={item}>
                  第 {item} 大节
                </option>
              ))}
            </select>
            <select
              value={weekFilter}
              onChange={(event) => setWeekFilter(Number(event.target.value))}
              aria-label="按周次筛选"
            >
              <option value={0}>全部周次</option>
              {Array.from({ length: 18 }, (_, index) => index + 1).map(
                (item) => (
                  <option key={item} value={item}>
                    第 {item} 周
                  </option>
                ),
              )}
            </select>
            <select
              value={buildingFilter}
              onChange={(event) => setBuildingFilter(event.target.value)}
              aria-label="按地点筛选"
            >
              <option value="all">全部地点</option>
              {offeringBuildings.map((building) => (
                <option key={building} value={building}>
                  {building}
                </option>
              ))}
            </select>
            <select
              value={conflictFilter}
              onChange={(event) =>
                setConflictFilter(
                  event.target.value as "all" | "available" | "conflict",
                )
              }
              aria-label="按冲突筛选"
            >
              <option value="all">全部状态</option>
              <option value="available">只看不冲突</option>
              <option value="conflict">只看冲突</option>
            </select>
          </div>
          <div className="section-filter-summary">
            <span>找到 {filteredSections.length} 个教学班</span>
            {(sectionQuery ||
              teacherFilter !== "all" ||
              weekdayFilter ||
              blockFilter ||
              weekFilter ||
              buildingFilter !== "all" ||
              conflictFilter !== "all") && (
              <button
                onClick={() => {
                  setSectionQuery("");
                  setTeacherFilter("all");
                  setWeekdayFilter(0);
                  setBlockFilter(0);
                  setWeekFilter(0);
                  setBuildingFilter("all");
                  setConflictFilter("all");
                }}
              >
                清空筛选
              </button>
            )}
          </div>
          <div className="offering-list">
            {filteredSections.length ? (
              filteredSections.map((section) => {
                const first = section.meetings[0];
                const added = section.meetings.every((other) =>
                  activeIds.has(other.id),
                );
                const compared = compareIds.includes(section.id);
                return (
                  <article
                    key={section.id}
                    className={`${section.conflict ? "has-conflict" : ""} ${compared ? "is-compared" : ""}`}
                  >
                    <div>
                      <header>
                        {first.teacher ? (
                          <TeacherRecordLink
                            className="teacher-record-link"
                            catalogId={catalogId}
                            scheduleId={first.id}
                            teacherName={first.teacher}
                          />
                        ) : <strong>教师未标注</strong>}
                        <span className={section.conflict ? "conflict" : "available"}>
                          {section.conflict ? "与当前课表冲突" : "与课表不冲突"}
                        </span>
                      </header>
                      <small>
                        {first.classNames || "班级未标注"} · {section.id}
                      </small>
                      <div className="section-meetings">
                        {section.meetings.map((meeting) => (
                          <span key={meeting.id}>
                            {weekdayLabels[meeting.weekday % 7]} ·{" "}
                            {meeting.timeText} · {meeting.building}
                            {meeting.room} · {scheduleWeeksLabel(meeting)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <footer>
                      <button
                        className={`compare-button ${compared ? "active" : ""}`}
                        onClick={() => toggleCompare(section.id)}
                      >
                        {compared ? "已选作比较" : "加入比较"}
                      </button>
                      <button
                        className={added ? "added" : ""}
                        disabled={added}
                        onClick={() =>
                          onAddMany(
                            section.meetings.map((meeting) => meeting.id),
                            course.title,
                          )
                        }
                      >
                        {added ? "已在课表" : "加入课表"}
                      </button>
                    </footer>
                  </article>
                );
              })
            ) : (
              <p className="quiet-empty">没找到合适的教学班，少选一个条件试试。</p>
            )}
          </div>
        </section>

        {(course.textbook ||
          materials.length > 0 ||
          materialsStatus !== "ready") && (
          <section className="drawer-resources">
            <div className="drawer-section-heading">
              <div>
                <span className="drawer-label">教材与学习资料</span>
                <small>
                  {materialsStatus === "idle" || materialsStatus === "loading"
                    ? "正在读取资料…"
                    : materialsStatus === "error"
                      ? "资料清单暂不可用"
                      : `${materials.length} 份资料 · 原件可下载`}
                </small>
              </div>
            </div>
            {materialsStatus === "error" && (
              <p className="quiet-empty" role="alert">
                资料清单没有加载成功。关闭课程后重新打开即可再试。
              </p>
            )}
            {course.textbook && (
              <div className="material-block">
                <span>教材信息</span>
                <strong>{course.textbook}</strong>
                {course.author && (
                  <p>
                    {course.author}
                    {course.publisher ? ` · ${course.publisher}` : ""}
                  </p>
                )}
              </div>
            )}
            {materials.length > 0 && (
              <div className="course-materials">
                <div className="course-material-list">
                  {materials.slice(0, 40).map((item) => (
                    <article key={`${item.id}-${item.courseTitle}-${item.name}`}>
                      <div className="material-file-mark">{item.kind}</div>
                      <div>
                        <small>
                          {item.category || "其他"} · {formatFileSize(item.sizeBytes)}
                        </small>
                        <strong title={item.name}>{item.name}</strong>
                      </div>
                      <div className="material-actions">
                        {item.previewable && (
                          <a href={item.previewUrl} target="_blank" rel="noreferrer">
                            预览
                          </a>
                        )}
                        <a href={item.downloadUrl} download>
                          下载
                        </a>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {comparedSections.length > 0 && (
          <section className="section-compare-tray" aria-label="教学班比较">
            <header>
              <div>
                <span>教学班比较</span>
                <b>{comparedSections.length} / 4</b>
              </div>
              <button onClick={() => setCompareIds([])}>清空</button>
            </header>
            <div>
              {comparedSections.map((section) => {
                const first = section.meetings[0];
                return (
                  <article key={`compare-${section.id}`}>
                    <span className={section.conflict ? "conflict" : "available"}>
                      {section.conflict ? "冲突" : "可用"}
                    </span>
                    {first.teacher ? (
                      <TeacherRecordLink
                        className="teacher-record-link"
                        catalogId={catalogId}
                        scheduleId={first.id}
                        teacherName={first.teacher}
                      />
                    ) : <strong>教师未标注</strong>}
                    <small>
                      {section.meetings
                        .map(
                          (meeting) =>
                            `${weekdayLabels[meeting.weekday % 7]} ${meeting.timeText}`,
                        )
                        .join(" / ")}
                    </small>
                    <button
                      onClick={() =>
                        onAddMany(
                          section.meetings.map((meeting) => meeting.id),
                          course.title,
                        )
                      }
                    >
                      选择此班
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}

function Onboarding({
  data,
  term,
  initial,
  onSkip,
  onSave,
}: {
  data: SiteData;
  term: Term;
  initial: Profile | null;
  onSkip: () => void;
  onSave: (profile: Profile, scheduleIds: string[]) => void;
}) {
  const [step, setStep] = useState(1);
  const [entranceYear, setEntranceYear] = useState(
    initial?.entranceYear ?? 2025,
  );
  const [college, setCollege] = useState(initial?.college ?? "");
  const [majorId, setMajorId] = useState(initial?.majorId ?? "");
  const [className, setClassName] = useState(initial?.className ?? "");
  const majors = data.majors.filter(
    (item) => !college || item.college === college,
  );
  const major = data.majors.find((item) => item.id === majorId);
  const code = String(entranceYear).slice(-2);
  const aliases = major?.aliases ?? [];
  const classes = [
    ...new Set(
      data.schedules
        .flatMap((item) => splitClasses(item.classNames))
        .filter((name) =>
          aliases.some((alias) => name.startsWith(`${alias}${code}`)),
        ),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  function chooseCollege(value: string) {
    setCollege(value);
    setMajorId("");
    setClassName("");
    setStep(2);
  }
  function chooseMajor(value: string) {
    setMajorId(value);
    setClassName("");
    setStep(3);
  }
  function finish() {
    if (!college || !majorId) return;
    const selected = className
      ? data.schedules
          .filter(
            (item) =>
              item.term === term &&
              splitClasses(item.classNames).includes(className),
          )
          .map((item) => item.id)
      : [];
    // 没选具体班级时不能替用户猜教师或课序号；专业课程索引仍可浏览，
    // 具体班次由用户在课程池中选择。
    onSave({ entranceYear, college, majorId, className }, selected);
  }
  return (
    <div className="modal-backdrop onboarding-backdrop">
      <section
        className="onboarding"
        role="dialog"
        aria-modal="true"
        aria-label="建立个人档案"
      >
        <header>
          <Wordmark />
          <button onClick={onSkip}>暂时跳过</button>
        </header>
        <div className="onboarding-progress">
          <span className={step >= 1 ? "active" : ""}>01 年级</span>
          <i />
          <span className={step >= 2 ? "active" : ""}>02 学院与专业</span>
          <i />
          <span className={step >= 3 ? "active" : ""}>03 班级</span>
        </div>
        <div className="onboarding-copy">
          <p>课表设置</p>
          <h2>选择年级、专业和班级</h2>
          <span>选到具体班级后可带入本学期课程；跳过班级也能稍后手动选课。</span>
        </div>
        {step === 1 && (
          <div className="choice-grid years">
            {[2026, 2025, 2024, 2023].map((item) => (
              <button
                key={item}
                className={entranceYear === item ? "active" : ""}
                onClick={() => {
                  setEntranceYear(item);
                  setStep(2);
                }}
              >
                <strong>{item}</strong>
                <span>
                  {item === 2026
                    ? "新生"
                    : `当前大${"一二三四"[Math.min(3, 2026 - item)]}`}
                </span>
              </button>
            ))}
          </div>
        )}
        {step === 2 && (
          <div className="onboarding-two">
            <div>
              <label>学院</label>
              {data.colleges.map((item) => (
                <button
                  key={item.name}
                  className={college === item.name ? "active" : ""}
                  onClick={() => chooseCollege(item.name)}
                >
                  {item.name}
                </button>
              ))}
            </div>
            <div>
              <label>专业</label>
              {college ? (
                majors.map((item) => (
                  <button
                    key={item.id}
                    className={majorId === item.id ? "active" : ""}
                    onClick={() => chooseMajor(item.id)}
                  >
                    {item.name}
                  </button>
                ))
              ) : (
                <p>请先选择学院</p>
              )}
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="class-choice">
            <label>班级（可跳过）</label>
            <div>
              {classes.map((item) => (
                <button
                  key={item}
                  className={className === item ? "active" : ""}
                  onClick={() => setClassName(item)}
                >
                  {item}
                </button>
              ))}
              {!classes.length && (
                <p>没有匹配班级。跳过后可自行选择教学班。</p>
              )}
            </div>
            <button className="finish-button" onClick={finish}>
              {className ? `导入 ${className} 的课程` : "保存设置"}
            </button>
          </div>
        )}
        <footer>
          <button
            disabled={step === 1}
            onClick={() => setStep((value) => Math.max(1, value - 1))}
          >
            ← 上一步
          </button>
          <span>设置会保存在当前设备，可随时清除。</span>
        </footer>
      </section>
    </div>
  );
}
