"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

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
  term: Term;
  courseId: string;
  title: string;
  teacher: string;
  weekday: number;
  block: number;
  periods: number[];
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

  function addSchedule(id: string) {
    const schedule = schedules.get(id);
    const alreadyAdded = activePlan?.scheduleIds.includes(id) ?? false;
    if (!alreadyAdded) {
      updateActivePlan((ids) => [...ids, id]);
    }
    if (!alreadyAdded && schedule) {
      setAddFeedback(`${schedule.title} 已加入课表`);
      window.setTimeout(() => setAddFeedback(""), 1700);
      if ("vibrate" in navigator) navigator.vibrate(28);
    } else if (schedule) {
      setAddFeedback(`${schedule.title} 已在课表中`);
      window.setTimeout(() => setAddFeedback(""), 1300);
    }
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
          onAdd={addSchedule}
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
}) {
  const profileMajor = data.majors.find(
    (item) => item.id === saved.profile?.majorId,
  );
  const today = new Date().getDay() || 7;
  const nowBlock = currentBlock();
  const todayItems = activeSchedules
    .filter(
      (item) =>
        item.weekday === today &&
        week.state === "active" &&
        scheduleOccursInWeek(item, week.week),
    )
    .sort((a, b) => a.block - b.block);
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
  const remainingItems = todayItems.filter((item) => item.block >= nowBlock);
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
  return (
    <div className="page-wrap today-page focus-page">
      <header className="focus-head">
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

      <section className="focus-grid">
        <article className="focus-next">
          <header>
            <span>{nextClass ? "下一节" : "接下来"}</span>
            <time>
              {nextClass
                ? data.periods[nextClass.block - 1]?.time
                : data.periods[nowBlock - 1]?.short}
            </time>
          </header>
          <div>
            <i>{nextClass ? courseMark(nextClass.title) : "空"}</i>
            <span>
              <h2>
                {nextClass
                  ? nextClass.title
                  : saved.profile
                    ? "今天没有后续课程"
                    : "课表还没有生成"}
              </h2>
              <p>
                {nextClass
                  ? `${nextClass.teacher || "教师待补"} · ${nextClass.building}${nextClass.room}`
                  : saved.profile
                    ? "看看附近的空教室"
                    : "先设置你的专业和班级"}
              </p>
            </span>
          </div>
          <footer>
            <button onClick={() => onGo("schedule")}>我的课表</button>
            <button onClick={() => onSearch("material")}>课程资料</button>
          </footer>
        </article>

        <aside className="focus-side">
          <article className="focus-assignment">
            <header>
              <span>下次作业</span>
              <button
                onClick={() =>
                  onEditCalendar(
                    nextAssignment
                      ? { kind: "assignment", id: nextAssignment.id }
                      : { kind: "assignment" },
                  )
                }
              >
                {nextAssignment ? "编辑" : "＋ 添加"}
              </button>
            </header>
            {nextAssignment ? (
              <>
                <strong>
                  {assignmentDays !== null && assignmentDays < 0
                    ? `逾期 ${Math.abs(assignmentDays)} 天`
                    : assignmentDays === 0
                      ? "今天截止"
                      : `${assignmentDays} 天后`}
                </strong>
                <h3>{nextAssignment.title}</h3>
                <small>
                  {assignmentCourse?.title || "未关联课程"} ·{" "}
                  {nextAssignment.dueDate}
                </small>
                <button
                  className="assignment-done"
                  onClick={() => onToggleAssignment(nextAssignment.id)}
                >
                  标记完成
                </button>
              </>
            ) : (
              <button
                className="assignment-empty"
                onClick={() => onEditCalendar({ kind: "assignment" })}
              >
                <b>还没有待交作业</b>
                <small>添加截止日期后，这里会自动倒计时。</small>
              </button>
            )}
          </article>
          <button className="focus-room" onClick={() => onGo("rooms")}>
            <span>此刻空教室</span>
            <strong>{bestBuilding?.free ?? 0}</strong>
            <small>
              {bestBuilding ? `${bestBuilding.name} · 当前最多` : "查看教学楼"}
            </small>
            <b>查看全部 →</b>
          </button>
        </aside>
      </section>

      <section className="study-status-strip" aria-label="今日状态">
        <button onClick={() => onGo("schedule")}>
          <span>今天还剩</span>
          <b>{remainingItems.length} 个课程时段</b>
          <i>查看课表 →</i>
        </button>
        <button onClick={() => onEditCalendar({ kind: "activity" })}>
          <span>个人日程</span>
          <b>{saved.activities.length} 项活动</b>
          <i>添加活动 →</i>
        </button>
        <button onClick={() => onEditCalendar({ kind: "assignment" })}>
          <span>课程任务</span>
          <b>
            {saved.assignments.filter((item) => !item.completed).length} 项待办
          </b>
          <i>管理作业 →</i>
        </button>
      </section>

      <nav className="focus-actions" aria-label="常用入口">
        <button onClick={() => onSearch("course")}>
          <i>⌕</i>
          <span>找课程</span>
        </button>
        <button onClick={() => onSearch("material")}>
          <i>文</i>
          <span>找资料</span>
        </button>
        <a
          href="https://ginkgostu.dufe.edu.cn/"
          target="_blank"
          rel="noreferrer"
        >
          <i>果</i>
          <span>白果云</span>
        </a>
        <a href="https://jwc.dufe.edu.cn/" target="_blank" rel="noreferrer">
          <i>教</i>
          <span>教务处</span>
        </a>
      </nav>

      <section className="focus-timeline">
        <header>
          <div>
            <span>今日课表</span>
            <b>{todayItems.length} 个时段</b>
          </div>
          <button onClick={() => onGo("schedule")}>编辑课表</button>
        </header>
        <div>
          {todayItems.length ? (
            todayItems.map((item) => (
              <button
                key={item.id}
                className={item.block < nowBlock ? "past" : ""}
                onClick={() => onGo("schedule")}
              >
                <time>{data.periods[item.block - 1]?.short}</time>
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.building}
                    {item.room} · {item.teacher}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <p>今天没有课程安排。</p>
          )}
        </div>
      </section>

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
  const timetableRef = useRef<HTMLElement>(null);
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
  async function exportTimetable() {
    if (!timetableRef.current || exporting) return;
    setExporting(true);
    try {
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
      <div className="lineup-workspace">
        <aside className="course-pool finder-pool">
          <header>
            <h2>找课程</h2>
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
                            ? `${first.teacher} · ${first.building}${first.room}`
                            : course.teachers.slice(0, 2).join(" / ") ||
                              course.id}
                        </small>
                      </span>
                    </button>
                    {first && (
                      <button
                        className="quick-add"
                        onClick={() => onAdd(first.id)}
                        aria-label={`添加${course.title}`}
                      >
                        ＋
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
        <section className="timetable-panel" ref={timetableRef}>
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
                data-export-ignore="true"
                onClick={exportTimetable}
                disabled={exporting}
              >
                {exporting ? "正在生成…" : "导出图片"}
              </button>
            </div>
          </header>
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
                      <button
                        key={item.id}
                        onClick={() => onCourse(courses.get(item.courseId)!)}
                      >
                        <strong>{item.title}</strong>
                        <span>{item.teacher}</span>
                        <small>
                          {item.building}
                          {item.room}
                        </small>
                        <i
                          onClick={(event) => {
                            event.stopPropagation();
                            onRemove(item.id);
                          }}
                        >
                          ×
                        </i>
                      </button>
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
            <div className="planner-columns">
              <div>
                <b>每周活动</b>
                {saved.activities.length ? (
                  saved.activities
                    .slice()
                    .sort((a, b) => a.weekday - b.weekday || a.block - b.block)
                    .map((item) => (
                      <button
                        key={item.id}
                        onClick={() =>
                          onEditCalendar({ kind: "activity", id: item.id })
                        }
                      >
                        <i className={item.color} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            周{weekdayShort[item.weekday - 1]} · 第 {item.block}{" "}
                            大节
                            {item.location ? ` · ${item.location}` : ""}
                          </small>
                        </span>
                      </button>
                    ))
                ) : (
                  <p>点击课表空白格，也可以直接添加活动。</p>
                )}
              </div>
              <div>
                <b>课程作业</b>
                {saved.assignments.length ? (
                  saved.assignments
                    .slice()
                    .sort(
                      (a, b) =>
                        Number(a.completed) - Number(b.completed) ||
                        new Date(a.dueDate).getTime() -
                          new Date(b.dueDate).getTime(),
                    )
                    .map((item) => (
                      <button
                        key={item.id}
                        className={item.completed ? "completed" : ""}
                        onClick={() =>
                          onEditCalendar({ kind: "assignment", id: item.id })
                        }
                      >
                        <time>
                          {item.completed
                            ? "已完成"
                            : daysUntil(item.dueDate) < 0
                              ? `逾期 ${Math.abs(daysUntil(item.dueDate))} 天`
                              : `${daysUntil(item.dueDate)} 天`}
                        </time>
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {courses.get(item.courseId)?.title || "未关联课程"} ·{" "}
                            {item.dueDate}
                          </small>
                        </span>
                      </button>
                    ))
                ) : (
                  <p>添加作业后，学习台会自动显示最近截止日期。</p>
                )}
              </div>
            </div>
          </section>
        </section>
      </div>
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
  onAdd,
  onClose,
}: {
  course: Course;
  materials: Material[];
  offerings: Schedule[];
  activeIds: Set<string>;
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
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
        {course.textbook && (
          <section className="material-block">
            <span>教材信息</span>
            <strong>{course.textbook}</strong>
            {course.author && (
              <p>
                {course.author}
                {course.publisher ? ` · ${course.publisher}` : ""}
              </p>
            )}
          </section>
        )}
        {materials.length > 0 && (
          <section className="course-materials">
            <div className="drawer-section-heading">
              <div>
                <span className="drawer-label">学习资料</span>
                <small>{materials.length} 份 · 原件可下载</small>
              </div>
              <em>PDF ≤ 50 MB 可在线预览</em>
            </div>
            <div className="course-material-list">
              {materials.slice(0, 40).map((item) => (
                <article key={`${item.id}-${item.courseTitle}-${item.name}`}>
                  <div className="material-file-mark">{item.kind}</div>
                  <div>
                    <small>{item.category || "其他"} · {formatFileSize(item.sizeBytes)}</small>
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
            {materials.length > 40 && (
              <p className="quiet-empty">
                当前先显示 40 份，完整资料页将在下一步加入筛选与分页。
              </p>
            )}
          </section>
        )}
        <section>
          <span className="drawer-label">本学期开课</span>
          <div className="offering-list">
            {offerings.length ? (
              offerings.slice(0, 18).map((item) => {
                const sameSection = offerings.filter(
                  (other) =>
                    other.teacher === item.teacher &&
                    other.classNames === item.classNames,
                );
                const added = sameSection.every((other) =>
                  activeIds.has(other.id),
                );
                return (
                  <article key={item.id}>
                    <div>
                      <strong>{item.teacher || "教师待补"}</strong>
                      <span>
                        {weekdayLabels[item.weekday % 7]} · {item.timeText}
                      </span>
                      <small>
                        {item.building}
                        {item.room} · {item.classNames}
                      </small>
                    </div>
                    <button
                      className={added ? "added" : ""}
                      onClick={() =>
                        sameSection.forEach((other) => onAdd(other.id))
                      }
                    >
                      {added ? "已加入" : "加入该班次"}
                    </button>
                  </article>
                );
              })
            ) : (
              <p className="quiet-empty">本学期暂未匹配到具体开课时段。</p>
            )}
          </div>
        </section>
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
    const grade = Math.min(4, Math.max(1, 2026 - entranceYear + 1));
    let selected = className
      ? data.schedules
          .filter(
            (item) =>
              item.term === term &&
              splitClasses(item.classNames).includes(className),
          )
          .map((item) => item.id)
      : [];
    if (!selected.length) {
      const ids = new Set(
        data.majorCourses
          .filter(
            (item) =>
              item.majorId === majorId &&
              item.term === term &&
              item.year === grade,
          )
          .map((item) => item.courseId),
      );
      selected = data.schedules
        .filter((item) => item.term === term && ids.has(item.courseId))
        .filter(
          (item, index, all) =>
            all.findIndex((other) => other.courseId === item.courseId) ===
            index,
        )
        .map((item) => item.id);
    }
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
