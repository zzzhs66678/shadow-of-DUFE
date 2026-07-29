"use client";

import {
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

type Term = "fall" | "spring";
type View = "home" | "catalog" | "schedule" | "rooms" | "me";
type SearchKind = "all" | "course" | "material" | "teacher" | "room";

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
};
type CalendarEditorRequest =
  | { kind: "activity"; weekday?: number; block?: number; id?: string }
  | { kind: "assignment"; courseId?: string; id?: string };
type SearchItem = {
  key: string;
  kind: Exclude<SearchKind, "all">;
  title: string;
  meta: string;
  course?: Course;
  teacher?: string;
  room?: string;
};
type Material = {
  id: string;
  courseTitle: string;
  courseIds: string[];
  category: string;
  name: string;
  kind: string;
  extension: string;
  sizeBytes: number;
  previewable: boolean;
  previewUrl: string;
  downloadUrl: string;
};
type MaterialManifest = {
  previewLimitBytes: number;
  materials: Material[];
};

const STORAGE_KEY = "dufesh:student-profile:v2";
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
};

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
  if (!weeks.length) return "周次待补";
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
        <span>学生学习与空间入口</span>
      </div>
    </div>
  );
}

export function DufeHubV2() {
  const [data, setData] = useState<SiteData | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/data/course-data.json")
      .then((response) => response.json() as Promise<SiteData>)
      .then((payload) => live && setData(payload));
    fetch("/data/resource-manifest.json")
      .then((response) =>
        response.ok
          ? (response.json() as Promise<MaterialManifest>)
          : Promise.reject(new Error("resource manifest unavailable")),
      )
      .then((payload) => live && setMaterials(payload.materials))
      .catch(() => {
        if (live) setMaterials([]);
      });
    return () => {
      live = false;
    };
  }, []);
  if (!data) {
    return (
      <main className="data-loading" aria-live="polite">
        <Wordmark />
        <div>
          <span>正在展开校园索引</span>
          <i />
        </div>
        <p>课程、教室与资料关系正在抵达。</p>
      </main>
    );
  }
  return <HubApp data={data} materials={materials} />;
}

function HubApp({ data, materials }: { data: SiteData; materials: Material[] }) {
  const [view, setView] = useState<View>("home");
  const [term, setTerm] = useState<Term>("fall");
  const [saved, setSaved] = useState<SavedState>(emptySavedState);
  const [hydrated, setHydrated] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
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
  const [addFeedback, setAddFeedback] = useState("");

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
    let restored = emptySavedState;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        restored = {
          ...emptySavedState,
          ...parsed,
          activities: Array.isArray(parsed.activities) ? parsed.activities : [],
          assignments: Array.isArray(parsed.assignments)
            ? parsed.assignments
            : [],
        };
      }
    } catch {
      /* damaged local data falls back safely */
    }
    queueMicrotask(() => {
      setSaved(restored);
      setHydrated(true);
      if (!restored.profile && !restored.skipped) setOnboarding(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }, [hydrated, saved]);

  useEffect(() => {
    document.documentElement.dataset.term = term;
  }, [term]);

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
      if (course.textbook)
        items.push({
          key: `material-${course.id}`,
          kind: "material",
          title: `${course.title} · 教材`,
          meta: `${course.textbook}${course.author ? ` · ${course.author}` : ""}`,
          course,
          score: score + 0.5,
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
          meta: "查看教室当前与后续状态",
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
  }, [data.courses, data.schedules, query, searchKind]);

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
    window.scrollTo({ top: 0, behavior: "smooth" });
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

  function selectSearchItem(item: SearchItem) {
    setCommandOpen(false);
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

  const nav: Array<{ id: View; label: string; icon: string }> = [
    { id: "schedule", label: "我的课表", icon: "▦" },
    { id: "rooms", label: "空教室", icon: "◇" },
    { id: "home", label: "今日学习台", icon: "⌂" },
    { id: "catalog", label: "课程与资料", icon: "⌕" },
    { id: "me", label: "我的", icon: "○" },
  ];

  return (
    <main className="site-shell hub-v2">
      <header className="topbar hub-topbar">
        <button className="brand-button" onClick={() => go("home")}>
          <span>东财之影</span>
          <small>今天学什么，去哪里学</small>
        </button>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => go(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="hub-top-actions">
          <button className="command-trigger" onClick={() => openSearch()}>
            <span>搜索全站</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="term-switch" aria-label="切换学期">
            <button
              className={term === "fall" ? "active" : ""}
              onClick={() => setTerm("fall")}
            >
              <span>☀</span>上学期
            </button>
            <button
              className={term === "spring" ? "active" : ""}
              onClick={() => setTerm("spring")}
            >
              <span>☾</span>下学期
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
          onSetup={() => setOnboarding(true)}
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
      {view === "catalog" && (
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
          onSearch={openSearch}
        />
      )}
      {view === "schedule" && (
        <SchedulePage
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
          onSetup={() => setOnboarding(true)}
          onEditCalendar={setCalendarEditor}
        />
      )}
      {view === "rooms" && (
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
        />
      )}
      {view === "me" && (
        <MePage
          data={data}
          saved={saved}
          setSaved={setSaved}
          onSetup={() => setOnboarding(true)}
        />
      )}

      <footer className="hub-footer">
        <Wordmark />
        <div>
          <strong>非官方学生工具</strong>
          <p>课程、教室与通知请以东北财经大学官方系统为准。</p>
        </div>
        <div className="footer-links">
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
          <span>dufesh.cn</span>
        </div>
      </footer>

      <nav className="mobile-nav" aria-label="手机主导航">
        {nav.map((item) => (
          <button
            key={item.id}
            className={view === item.id ? "active" : ""}
            onClick={() => go(item.id)}
          >
            <b>{item.icon}</b>
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
      {selectedCourse && (
        <CourseDrawer
          course={selectedCourse}
          materials={materials.filter(
            (item) =>
              item.courseIds.includes(selectedCourse.id) ||
              item.courseTitle === selectedCourse.title,
          )}
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
      {onboarding && (
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
      meta: `${item.building}${item.room} · ${item.teacher || "教师待补"}`,
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
          label: "优先级提醒",
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
          label: "校园建议",
          title: primaryClass
            ? `下一站 ${primaryClass.building}${primaryClass.room}`
            : `${bestBuilding?.name || "教学楼"}此刻更容易找到座位`,
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
          <span>{dateText}</span>
          <h1>今日学习台</h1>
        </div>
        <button onClick={() => onSearch()} aria-label="全站搜索">
          ⌕
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
      </header>

      {!saved.profile && (
        <button className="focus-setup" onClick={onSetup}>
          <span>选择专业和班级，自动生成我的课表</span>
          <b>开始设置 →</b>
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
                    : "先建立你的专业与班级"}
              </h2>
              <p>
                {primaryClass
                  ? `${data.periods[primaryClass.block - 1]?.time} · ${primaryClass.building}${primaryClass.room}`
                  : "课程、日程与作业会在这里自动汇成一张今日卡片。"}
              </p>
              {primaryClass && (
                <small>
                  {primaryClass.teacher || "教师待补"} ·{" "}
                  {scheduleWeeksLabel(primaryClass)}
                </small>
              )}
            </span>
          </div>
          <footer>
            <button onClick={() => onGo("schedule")}>打开课表</button>
            <button onClick={() => onGo("rooms")}>附近空教室</button>
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
                <b>没有必须处理的事项</b>
                <small>可以去看看当前可用的自习空间。</small>
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
              <p>把学习、社团或个人计划加进来，学习台会替你按时间排好。</p>
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
            <b>课程、日程和截止日期放在同一条时间线上</b>
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
            <p>未来七天暂时没有课程、日程或截止任务。</p>
          )}
        </div>
      </section>

      <section className="study-management">
        <header>
          <span>管理我的学习</span>
          <h2>需要操作的内容，放在信息之后。</h2>
        </header>
        <div>
          <button onClick={() => onGo("schedule")}>
            <i>01</i>
            <b>编辑我的课表</b>
            <span>添加、移除课程或导出图片</span>
          </button>
          <button onClick={() => onEditCalendar({ kind: "activity" })}>
            <i>02</i>
            <b>添加个人日程</b>
            <span>自习、社团、考试或生活安排</span>
          </button>
          <button onClick={() => onEditCalendar({ kind: "assignment" })}>
            <i>03</i>
            <b>添加课程作业</b>
            <span>记录截止日期并自动倒计时</span>
          </button>
        </div>
      </section>

      <nav className="campus-services" aria-label="校园服务">
        <header>
          <span>校园服务</span>
          <p>常用入口留在学习流的下方，不打断你查看今天。</p>
        </header>
        <a href="https://ginkgostu.dufe.edu.cn/" target="_blank" rel="noreferrer">
          <i>果</i><span><b>白果云</b><small>学生服务</small></span><em>↗</em>
        </a>
        <a href="https://jwc.dufe.edu.cn/" target="_blank" rel="noreferrer">
          <i>教</i><span><b>教务处</b><small>官方教学信息</small></span><em>↗</em>
        </a>
        <button onClick={() => onSearch("course")}>
          <i>课</i><span><b>找课程</b><small>全校、专业与教师</small></span><em>→</em>
        </button>
        <button onClick={() => onSearch("material")}>
          <i>文</i><span><b>找资料</b><small>教材、课件与题库</small></span><em>→</em>
        </button>
      </nav>

      <section className="knowledge-tribute">
        <figure className="tribute-photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/alexandra-elbakyan.jpg"
            alt="Alexandra Elbakyan 在 2010 年 Humanity+ 峰会上"
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
          <h2>愿知识更容易抵达每一个人。</h2>
          <p>
            她在 2011 年创建
            Sci-Hub，让学术知识的获取方式进入全球公共讨论。东财之影致敬的是这份让知识抵达普通人的愿望；本站只收录可合法分享或已获授权的资料。
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
        <button onClick={() => onSearch("material")}>⌕ 搜索资料</button>
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
              <b>这里暂时没有匹配课程</b>
              <p>切换年级或学期继续查看。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function DraggableScheduleCard({
  schedule,
  onOpen,
  onRemove,
}: {
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
        <span>{schedule.teacher}</span>
        <small>
          {schedule.building}
          {schedule.room}
        </small>
      </button>
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
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [exporting, setExporting] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [mobileScheduleView, setMobileScheduleView] = useState<
    "agenda" | "week"
  >("agenda");
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
            meta: `${item.building}${item.room} · ${item.teacher || "教师待补"}`,
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
            {saved.profile?.className || "自由组合课程，冲突只提醒、不阻止。"}
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
                onClick={() => setFinderMode("search")}
              >
                全校搜索
              </button>
              <button
                className={finderMode === "major" ? "active" : ""}
                onClick={() => setFinderMode("major")}
              >
                按专业
              </button>
              <button
                className={finderMode === "time" ? "active" : ""}
                onClick={() => setFinderMode("time")}
              >
                按时间
              </button>
            </div>
            {finderMode === "search" && (
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="课程、简称或教师"
              />
            )}
            {finderMode === "major" && (
              <div className="major-finder">
                <select
                  value={finderCollege}
                  onChange={(event) => {
                    const value = event.target.value;
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
                  value={finderMajor}
                  onChange={(event) => setFinderMajor(event.target.value)}
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
                      onClick={() => setFinderYear(item)}
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
                      onClick={() => setFinderWeekday(index + 1)}
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
                      onClick={() => setFinderBlock(item.block)}
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
                const offerings = data.schedules.filter(
                  (item) =>
                    item.term === term &&
                    item.courseId === course.id &&
                    (finderMode !== "time" ||
                      (item.weekday === finderWeekday &&
                        item.block === finderBlock)),
                );
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
                            ? `${sectionIds.length} 个班次 · ${teacherCount || 1} 位教师`
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
                            ? `选择${course.title}的教师和班次`
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
              <p className="pool-empty">这个条件下暂时没有课程。</p>
            )}
            {pool.length < poolAll.length && (
              <button
                className="load-more-courses"
                onClick={() => setVisibleLimit((value) => value + 80)}
              >
                再显示 80 门
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
              className={mobileScheduleView === "agenda" ? "active" : ""}
              onClick={() => setMobileScheduleView("agenda")}
            >
              近日
            </button>
            <button
              className={mobileScheduleView === "week" ? "active" : ""}
              onClick={() => setMobileScheduleView("week")}
            >
              整周
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
                    <p>没有课程或日程</p>
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
              <b>课表还是空的</b>
              <p>从左侧按任意一种方式找课。</p>
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
                  <p>添加活动或作业后，它们会按时间出现在同一条列表里。</p>
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
    activity?.color ?? "blue",
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
      >
        <header>
          <div>
            <span>{request.kind === "activity" ? "个人日程" : "课程任务"}</span>
            <h2>
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
            autoFocus
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
                  aria-label={`选择${item}颜色`}
                />
              ))}
            </fieldset>
          </>
        ) : (
          <div className="editor-grid">
            <label>
              <span>关联课程</span>
              <select
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
}) {
  const selectedDate = new Date(`${date}T12:00:00`);
  const weekday = selectedDate.getDay() || 7;
  const selectedWeek = schoolWeek(selectedDate, term);
  const activeThisWeek = (item: Schedule) =>
    selectedWeek.state === "active" &&
    scheduleOccursInWeek(item, selectedWeek.week);
  const buildingSchedules = data.schedules.filter(
    (item) => item.term === term && item.building === building && item.room,
  );
  const rooms = [...new Set(buildingSchedules.map((item) => item.room))].sort(
    (a, b) => a.localeCompare(b, "zh-CN", { numeric: true }),
  );
  const occupied = new Map(
    buildingSchedules
      .filter(
        (item) =>
          item.weekday === weekday &&
          item.block === block &&
          activeThisWeek(item),
      )
      .map((item) => [item.room, item]),
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
  const [floorChoice, setFloorChoice] = useState("");
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
  function nextUse(room: string) {
    const next = buildingSchedules
      .filter(
        (item) =>
          item.room === room &&
          item.weekday === weekday &&
          item.block > block &&
          activeThisWeek(item),
      )
      .sort((a, b) => a.block - b.block)[0];
    return next
      ? `可用至 ${data.periods[next.block - 1]?.time.split("–")[0]}`
      : "今日后续无课";
  }
  return (
    <div className="page-wrap rooms-page living-spaces rooms-v5">
      <header className="map-heading">
        <div>
          <span>校园空间</span>
          <h1>空教室</h1>
          <p>
            {nextClass
              ? `下一节在 ${nextClass.building}${nextClass.room}`
              : "按课表推算，抵达后请以现场为准。"}
          </p>
        </div>
        <label>
          <span>日期</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
      </header>

      <section className="map-time">
        <div>
          {data.periods.map((item) => (
            <button
              key={item.block}
              className={block === item.block ? "active" : ""}
              onClick={() => setBlock(item.block)}
            >
              <b>{item.short}</b>
              <span>{item.time}</span>
            </button>
          ))}
        </div>
        <label>
          <span>搜索教室</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如 301"
          />
        </label>
      </section>

      <nav className="building-tabs" aria-label="选择教学楼">
        {data.buildings.map((item) => {
          const all = data.schedules.filter(
            (entry) =>
              entry.term === term && entry.building === item && entry.room,
          );
          const allRooms = new Set(all.map((entry) => entry.room));
          const busyRooms = new Set(
            all
              .filter(
                (entry) =>
                  entry.weekday === weekday &&
                  entry.block === block &&
                  activeThisWeek(entry),
              )
              .map((entry) => entry.room),
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
              <b>{Math.max(0, allRooms.size - busyRooms.size)}</b>
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
              (room) => !occupied.has(room),
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
                  visibleActiveRooms.filter((room) => !occupied.has(room))
                    .length
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
                  return (
                    <button
                      key={room}
                      className={lesson ? "busy" : "free"}
                      style={{ "--room-order": index } as CSSProperties}
                    >
                      <strong>{room}</strong>
                      <span>{lesson ? lesson.title : nextUse(room)}</span>
                    </button>
                  );
                })
              ) : (
                <p>这一层没有匹配的教室。</p>
              )}
            </div>
          </div>
        </div>

        <aside className="map-summary">
          <span>当前可用</span>
          <strong>{rooms.length - occupied.size}</strong>
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
                ? `下一节在${nextClass.building}，可优先查看同楼教室。`
                : "绿色教室当前课表未发现占用。"}
            </p>
          </div>
          <p>{data.disclaimer}</p>
        </aside>
      </section>

      <section className="floor-overview">
        <header>
          <h2>整栋楼一览</h2>
          <span>点按楼层进入详细视图</span>
        </header>
        <div>
          {sortedFloors.map(([floor, floorRooms]) => {
            const free = floorRooms.filter((room) => !occupied.has(room));
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
}: {
  data: SiteData;
  saved: SavedState;
  setSaved: React.Dispatch<React.SetStateAction<SavedState>>;
  onSetup: () => void;
}) {
  const major = data.majors.find((item) => item.id === saved.profile?.majorId);
  return (
    <div className="page-wrap me-page">
      <header className="workspace-heading">
        <div>
          <h1>我的</h1>
          <p>专业、班级与课表保存在当前设备。</p>
        </div>
        <button onClick={onSetup}>
          {saved.profile ? "修改个人设置" : "建立我的档案"}
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
              : "设置后自动生成班级课程，之后仍可自由修改。"}
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
          <strong>已保存</strong>
          <p>当前无需密码，清除浏览器数据前请注意备份。</p>
        </article>
        <article>
          <span>隐私</span>
          <strong>最少采集</strong>
          <p>不使用 GPS，不采集与课程服务无关的信息。</p>
        </article>
      </div>
      <section className="trust-panel">
        <div>
          <h2>登录功能准备中</h2>
        </div>
        <p>
          备案和平台资质完成后，可以把当前课表同步到账号；不登录仍可使用公开功能。
        </p>
        <button
          onClick={() => {
            if (confirm("确认清除当前浏览器里的个人档案和课表吗？"))
              setSaved(emptySavedState);
          }}
        >
          清除本机数据
        </button>
      </section>
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
          <span>⌕</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索课程、资料、教师或教室…"
          />
          <button onClick={onClose}>ESC</button>
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
                <strong>没有直接结果</strong>
                <p>
                  试试简称、课程号或切换搜索类型。这个搜索词会作为后续补充别名的依据。
                </p>
              </div>
            )
          ) : (
            <div className="search-hints">
              <span>快速开始</span>
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
  course,
  materials,
  offerings,
  activeIds,
  activeSchedules,
  onAddMany,
  onClose,
}: {
  course: Course;
  materials: Material[];
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
      >
        <header>
          <span>课程号 {course.id}</span>
          <button onClick={onClose}>×</button>
        </header>
        <div className="course-drawer-title">
          <i>{courseMark(course.title)}</i>
          <div>
            <p>{course.college}</p>
            <h2>{course.title}</h2>
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
                {sections.length} 个班次 ·{" "}
                {new Set(offerings.map((item) => item.teacher).filter(Boolean)).size}{" "}
                位教师
              </small>
            </div>
            <em>最多保留 4 个候选比较</em>
          </div>
          <div className="section-filter-bar">
            <input
              value={sectionQuery}
              onChange={(event) => setSectionQuery(event.target.value)}
              placeholder="搜教师、班级或教室"
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
            <span>找到 {filteredSections.length} 个班次</span>
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
                        <strong>{first.teacher || "教师待补"}</strong>
                        <span className={section.conflict ? "conflict" : "available"}>
                          {section.conflict ? "与当前课表冲突" : "时间可用"}
                        </span>
                      </header>
                      <small>
                        {first.classNames || "班级待补"} · {section.id}
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
              <p className="quiet-empty">当前筛选下没有教学班，试试清空一个条件。</p>
            )}
          </div>
        </section>

        {(course.textbook || materials.length > 0) && (
          <section className="drawer-resources">
            <div className="drawer-section-heading">
              <div>
                <span className="drawer-label">教材与学习资料</span>
                <small>{materials.length} 份资料 · 原件可下载</small>
              </div>
            </div>
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
                <span>班次比较</span>
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
                    <strong>{first.teacher || "教师待补"}</strong>
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
          <p>个性化设置</p>
          <h2>先选你的基本信息</h2>
          <span>系统会生成本学期课表，你仍可以随时增删课程。</span>
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
            <label>选择班级（可跳过班级）</label>
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
                <p>当前数据中没有精确匹配的班级，可以先按专业生成默认课程。</p>
              )}
            </div>
            <button className="finish-button" onClick={finish}>
              {className ? `使用 ${className} 开始` : "按专业生成并开始"}
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
          <span>信息保存在当前浏览器，暂不需要账号或密码。</span>
        </footer>
      </section>
    </div>
  );
}
