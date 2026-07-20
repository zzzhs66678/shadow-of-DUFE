"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  useEffect,
  useMemo,
  useState,
} from "react";

type Term = "fall" | "spring";
type View = "home" | "catalog" | "rooms";

type Major = {
  id: string;
  college: string;
  name: string;
  aliases: string[];
};

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
  periods: Array<{
    block: number;
    label: string;
    short: string;
    time: string;
  }>;
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
  quality: {
    sourceRows: number;
    unmatchedClassLabels: number;
    roomScheduleRows: number;
  };
};

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

const buildingMarks: Record<string, string> = {
  之远楼: "ZY",
  笃行楼: "DX",
  书音楼: "SY",
  播慧楼: "BH",
  砺金楼: "LJ",
};

function getCurrentBlock() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 9 * 60 + 45) return 1;
  if (minutes < 12 * 60) return 2;
  if (minutes < 17 * 60) return 3;
  return 4;
}

function formatToday() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Wordmark() {
  return (
    <div className="wordmark" aria-label="DUFESH">
      <svg viewBox="0 0 72 72" role="img" aria-label="展开的书与坐标">
        <path d="M11 16c11 0 19 3 25 9v34c-6-6-14-9-25-9V16Z" />
        <path d="M61 16c-11 0-19 3-25 9v34c6-6 14-9 25-9V16Z" />
        <circle cx="54" cy="12" r="6" />
        <path className="mark-line" d="M36 25v34M18 26c6 .5 11 2 15 5M54 26c-6 .5-11 2-15 5" />
      </svg>
      <div>
        <strong>DUFE<br />SH</strong>
        <span>STUDENT HUB · BETA</span>
      </div>
    </div>
  );
}

export function DufeHub() {
  const [data, setData] = useState<SiteData | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/data/course-data.json")
      .then((response) => {
        if (!response.ok) throw new Error("课程索引加载失败");
        return response.json() as Promise<SiteData>;
      })
      .then((payload) => active && setData(payload))
      .catch(() => active && setData(null));
    return () => {
      active = false;
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

  return <DufeHubApp data={data} />;
}

function DufeHubApp({ data }: { data: SiteData }) {
  const [term, setTerm] = useState<Term>("fall");
  const [view, setView] = useState<View>("home");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [college, setCollege] = useState(data.colleges[0]?.name ?? "");
  const [majorId, setMajorId] = useState(data.colleges[0]?.majorIds[0] ?? "");
  const [building, setBuilding] = useState(data.buildings[0]);
  const [date, setDate] = useState(formatToday);
  const [block, setBlock] = useState(getCurrentBlock);
  const [roomQuery, setRoomQuery] = useState("");
  const [roomFilter, setRoomFilter] = useState<"free" | "all">("free");

  const courseById = useMemo(
    () => new Map(data.courses.map((course) => [course.id, course])),
    [data.courses],
  );
  const majorById = useMemo(
    () => new Map(data.majors.map((major) => [major.id, major])),
    [data.majors],
  );

  const collegeMajors = useMemo(
    () => data.majors.filter((major) => major.college === college),
    [college, data.majors],
  );

  useEffect(() => {
    document.documentElement.dataset.term = term;
  }, [term]);

  const searchResults = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return { majors: [] as Major[], courses: [] as Course[] };
    return {
      majors: data.majors
        .filter((major) =>
          [major.name, major.college, ...major.aliases]
            .join(" ")
            .toLocaleLowerCase("zh-CN")
            .includes(needle),
        )
        .slice(0, 5),
      courses: data.courses
        .filter((course) =>
          [course.title, course.id, course.college, ...course.teachers]
            .join(" ")
            .toLocaleLowerCase("zh-CN")
            .includes(needle),
        )
        .slice(0, 7),
    };
  }, [data.courses, data.majors, query]);

  const selectedMajor = majorById.get(majorId);
  const yearCourses = useMemo(() => {
    const buckets = new Map<number, Course[]>([
      [1, []],
      [2, []],
      [3, []],
      [4, []],
    ]);
    const seen = new Set<string>();
    for (const link of data.majorCourses) {
      if (link.majorId !== majorId || link.term !== term) continue;
      const key = `${link.year}-${link.courseId}`;
      if (seen.has(key)) continue;
      const course = courseById.get(link.courseId);
      if (course) buckets.get(link.year)?.push(course);
      seen.add(key);
    }
    for (const courses of buckets.values()) {
      courses.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    }
    return buckets;
  }, [courseById, data.majorCourses, majorId, term]);

  const roomState = useMemo(() => {
    const weekday = new Date(`${date}T12:00:00`).getDay() || 7;
    const buildingSchedules = data.schedules.filter(
      (item) => item.term === term && item.building === building && item.room,
    );
    const rooms = [...new Set(buildingSchedules.map((item) => item.room))].sort(
      (a, b) => a.localeCompare(b, "zh-CN", { numeric: true }),
    );
    const occupied = new Map(
      buildingSchedules
        .filter((item) => item.weekday === weekday && item.block === block)
        .map((item) => [item.room, item]),
    );
    const needle = roomQuery.trim().toLocaleLowerCase("zh-CN");
    const results = rooms
      .map((room) => ({ room, schedule: occupied.get(room) }))
      .filter((item) => roomFilter === "all" || !item.schedule)
      .filter((item) =>
        needle
          ? `${item.room} ${item.schedule?.title ?? ""} ${item.schedule?.teacher ?? ""}`
              .toLocaleLowerCase("zh-CN")
              .includes(needle)
          : true,
      );
    return {
      weekday,
      total: rooms.length,
      occupied: occupied.size,
      free: Math.max(rooms.length - occupied.size, 0),
      results,
    };
  }, [block, building, data.schedules, date, roomFilter, roomQuery, term]);

  function chooseMajor(id: string) {
    const major = majorById.get(id);
    if (!major) return;
    setCollege(major.college);
    setMajorId(id);
    setView("catalog");
    setSearchOpen(false);
    window.setTimeout(() => scrollToSection("catalog"), 80);
  }

  function selectView(next: View, id?: string) {
    setView(next);
    if (id) window.setTimeout(() => scrollToSection(id), 20);
  }

  function handleGlobalSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSearchOpen(true);
  }

  return (
    <main className="site-shell">
      <header className="topbar">
        <button className="brand-button" onClick={() => selectView("home", "top")}>
          <span>DUFESH</span>
          <small>东北财经大学学生工具</small>
        </button>
        <nav aria-label="主导航">
          <button className={view === "home" ? "active" : ""} onClick={() => selectView("home", "top")}>
            首页
          </button>
          <button className={view === "catalog" ? "active" : ""} onClick={() => selectView("catalog", "catalog")}>
            专业课程
          </button>
          <button className={view === "rooms" ? "active" : ""} onClick={() => selectView("rooms", "rooms")}>
            空教室
          </button>
        </nav>
        <div className="term-switch" aria-label="切换学期">
          <button
            className={term === "fall" ? "active" : ""}
            onClick={() => setTerm("fall")}
            title="切换到上学期"
          >
            <span aria-hidden="true">☀</span>
            上学期
          </button>
          <button
            className={term === "spring" ? "active" : ""}
            onClick={() => setTerm("spring")}
            title="切换到下学期"
          >
            <span aria-hidden="true">☾</span>
            下学期
          </button>
        </div>
      </header>

      <div id="top" className="hero-grid">
        <aside className="portal-card">
          <Wordmark />
          <form className="portal-search" onSubmit={handleGlobalSubmit}>
            <label htmlFor="global-search">搜索课程 / 专业 / 教师</label>
            <div>
              <input
                id="global-search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchOpen(Boolean(event.target.value.trim()));
                }}
                onFocus={() => query.trim() && setSearchOpen(true)}
                placeholder="例如：微观经济学"
                autoComplete="off"
              />
              <button type="submit">查找</button>
            </div>
          </form>
          {searchOpen && query.trim() && (
            <div className="search-popover" role="dialog" aria-label="搜索结果">
              <div className="search-head">
                <span>搜索结果</span>
                <button onClick={() => setSearchOpen(false)} aria-label="关闭搜索结果">
                  ×
                </button>
              </div>
              {searchResults.majors.length === 0 && searchResults.courses.length === 0 ? (
                <p className="empty-copy">没有找到，试试课程号、简称或教师姓名。</p>
              ) : (
                <>
                  {searchResults.majors.map((major) => (
                    <button className="search-result" key={major.id} onClick={() => chooseMajor(major.id)}>
                      <span className="result-type">专业</span>
                      <strong>{major.name}</strong>
                      <small>{major.college}</small>
                    </button>
                  ))}
                  {searchResults.courses.map((course) => (
                    <button
                      className="search-result"
                      key={course.id}
                      onClick={() => {
                        setRoomQuery(course.title);
                        setRoomFilter("all");
                        setSearchOpen(false);
                        selectView("rooms", "rooms");
                      }}
                    >
                      <span className="result-type">课程</span>
                      <strong>{course.title}</strong>
                      <small>{course.id} · {course.teachers.slice(0, 2).join(" / ") || "教师待补"}</small>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          <p className="portal-line">知道学什么，也知道现在去哪里学。</p>
          <div className="portal-actions">
            <button onClick={() => selectView("catalog", "catalog")}>进入课程索引 <span>→</span></button>
            <button onClick={() => selectView("rooms", "rooms")}>寻找空教室 <span>→</span></button>
          </div>
        </aside>

        <section className="hero-copy">
          <div className="edition">
            <span>{term === "fall" ? "DAY" : "NIGHT"}</span>
            <small>{term === "fall" ? "上学期 · 昼" : "下学期 · 夜"}</small>
          </div>
          <div>
            <p className="eyebrow">DUFE STUDENT KNOWLEDGE INDEX / 试运行</p>
            <h1>
              把散落的课程、
              <br />
              教室与资料
              <em>重新连起来。</em>
            </h1>
            <p className="lead">
              从学院进入专业，按年级看完整课程；从日期和节次进入校园，找到此刻可用的自习空间。
              同一门课只建立一份资料关系，避免重复上传。
            </p>
          </div>
          <div className="hero-now">
            <div>
              <span>今天 · 星期{weekdayLabels[new Date().getDay()]}</span>
              <strong>{data.periods[block - 1]?.label}</strong>
              <small>{data.periods[block - 1]?.time}</small>
            </div>
            <button onClick={() => selectView("rooms", "rooms")}>
              查看五栋楼的空教室
              <span>↘</span>
            </button>
          </div>
        </section>

        <aside className="utility-rail">
          <p className="rail-label">校园常用入口</p>
          <a href="https://ginkgostu.dufe.edu.cn/" target="_blank" rel="noreferrer">
            <span>白果云</span>
            <small>课表 · 作业 · 考试</small>
            <b>↗</b>
          </a>
          <a href="https://jwc.dufe.edu.cn/" target="_blank" rel="noreferrer">
            <span>教务处</span>
            <small>通知 · 校历 · 下载</small>
            <b>↗</b>
          </a>
          <div className="pulse-card">
            <span>已建立索引</span>
            <strong>{data.courses.length.toLocaleString("zh-CN")}</strong>
            <small>个独立课程号</small>
          </div>
          <div className="pulse-card">
            <span>教室课表记录</span>
            <strong>{data.quality.roomScheduleRows.toLocaleString("zh-CN")}</strong>
            <small>仅统计指定五栋楼</small>
          </div>
        </aside>
      </div>

      <section id="catalog" className="section catalog-section">
        <header className="section-heading">
          <div>
            <span className="section-number">01</span>
            <p className="eyebrow">学院 → 专业 → 年级 → 课程</p>
            <h2>一眼看懂一个专业四年学什么</h2>
          </div>
          <p>
            课程号是唯一身份；同名但课程号不同的课程不会自动合并。资料、教材与教师评价都挂在这个身份下。
          </p>
        </header>

        <div className="catalog-grid">
          <div className="college-index">
            <label>选择学院</label>
            <div>
              {data.colleges.map((item) => (
                <button
                  key={item.name}
                  className={college === item.name ? "active" : ""}
                  onClick={() => {
                    setCollege(item.name);
                    setMajorId(item.majorIds[0] ?? "");
                  }}
                >
                  <span>{String(data.colleges.indexOf(item) + 1).padStart(2, "0")}</span>
                  {item.name}
                </button>
              ))}
            </div>
          </div>

          <div className="major-panel">
            <div className="major-toolbar">
              <div>
                <span>{college}</span>
                <select value={majorId} onChange={(event) => setMajorId(event.target.value)}>
                  {collegeMajors.map((major) => (
                    <option key={major.id} value={major.id}>{major.name}</option>
                  ))}
                </select>
              </div>
              <span className="term-badge">{term === "fall" ? "上学期 · 昼" : "下学期 · 夜"}</span>
            </div>
            <div className="year-columns">
              {[1, 2, 3, 4].map((year) => {
                const courses = yearCourses.get(year) ?? [];
                return (
                  <article key={year}>
                    <header>
                      <div>
                        <span>YEAR {year}</span>
                        <h3>大{"一二三四"[year - 1]}</h3>
                      </div>
                      <b>{courses.length} 门</b>
                    </header>
                    <div className="course-list">
                      {courses.length ? courses.map((course) => (
                        <details key={course.id}>
                          <summary>
                            <span>{course.title}</span>
                            <small>{course.credits ? `${Number(course.credits)} 学分` : course.property || "课程"}</small>
                          </summary>
                          <div className="course-detail">
                            <p><b>课程号</b>{course.id}</p>
                            <p><b>任课教师</b>{course.teachers.slice(0, 4).join(" / ") || "待补充"}</p>
                            <div className="resource-slots">
                              <button disabled>教材索引 · 待接入</button>
                              <button disabled>学习资料 · 待上传</button>
                              <button disabled>课程评价 · 已预留</button>
                            </div>
                          </div>
                        </details>
                      )) : (
                        <p className="empty-copy">当前学期暂无可匹配课程。</p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            <p className="mapping-note">
              当前专业：{selectedMajor?.name ?? "—"} · 班级简称：
              {selectedMajor?.aliases.join(" / ") || "—"}
            </p>
          </div>
        </div>
      </section>

      <section id="rooms" className="section room-section">
        <header className="section-heading">
          <div>
            <span className="section-number">02</span>
            <p className="eyebrow">SPACE FINDER / 课表截面</p>
            <h2>拖动时间，看校园此刻的空间</h2>
          </div>
          <p>
            日期决定星期，时间轴决定课表截面。这里与专业课程索引相互独立，只回答“哪间教室可能空闲”。
          </p>
        </header>

        <div className="room-console">
          <div className="room-controls">
            <div className="control-row">
              <label>
                日期
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </label>
              <label>
                搜索教室 / 课程 / 教师
                <input
                  value={roomQuery}
                  onChange={(event) => setRoomQuery(event.target.value)}
                  placeholder="例如：514 或 财政学"
                />
              </label>
              <div className="segmented">
                <button className={roomFilter === "free" ? "active" : ""} onClick={() => setRoomFilter("free")}>只看空闲</button>
                <button className={roomFilter === "all" ? "active" : ""} onClick={() => setRoomFilter("all")}>全部教室</button>
              </div>
            </div>

            <div className="time-axis">
              <input
                aria-label="选择课程大节"
                type="range"
                min="1"
                max="4"
                step="1"
                value={block}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setBlock(Number(event.target.value))}
                style={{ "--progress": `${((block - 1) / 3) * 100}%` } as CSSProperties}
              />
              <div>
                {data.periods.map((period) => (
                  <button
                    key={period.block}
                    className={block === period.block ? "active" : ""}
                    onClick={() => setBlock(period.block)}
                  >
                    <b>{period.short}</b>
                    <span>{period.time}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="map-and-rooms">
            <div className="campus-map" aria-label="五栋教学楼创意空间图">
              <div className="map-caption">
                <span>星期{weekdayLabels[roomState.weekday % 7]}</span>
                <strong>{data.periods[block - 1]?.label}</strong>
                <small>{data.periods[block - 1]?.time}</small>
              </div>
              <div className="building-stage">
                {data.buildings.map((item, index) => (
                  <button
                    key={item}
                    className={`building building-${index + 1} ${building === item ? "active" : ""}`}
                    onClick={() => setBuilding(item)}
                    aria-label={`查看${item}`}
                  >
                    <i>
                      <span>{buildingMarks[item]}</span>
                    </i>
                    <b>{item}</b>
                  </button>
                ))}
                <svg className="map-lines" viewBox="0 0 700 420" aria-hidden="true">
                  <path d="M90 300C180 200 255 260 340 185S520 95 630 165" />
                  <path d="M115 110C220 145 248 90 350 105S500 300 620 275" />
                </svg>
              </div>
              <p>创意空间索引 · 非真实建筑比例或楼层结构</p>
            </div>

            <div className="room-list-panel">
              <header>
                <div>
                  <span>SELECTED BUILDING</span>
                  <h3>{building}</h3>
                </div>
                <div className="room-stats">
                  <span><b>{roomState.free}</b> 推算空闲</span>
                  <span><b>{roomState.occupied}</b> 有课</span>
                </div>
              </header>
              <div className="room-list">
                {roomState.results.length ? roomState.results.slice(0, 36).map((item) => (
                  <article key={item.room} className={item.schedule ? "occupied" : "free"}>
                    <div>
                      <span>{item.schedule ? "有课" : "可自习"}</span>
                      <strong>{item.room}</strong>
                    </div>
                    {item.schedule ? (
                      <p>{item.schedule.title}<small>{item.schedule.teacher || "教师待补"}</small></p>
                    ) : (
                      <p>课表未发现占用<small>到达后请以现场为准</small></p>
                    )}
                  </article>
                )) : (
                  <p className="empty-copy">没有匹配结果，试试清空搜索或切换“全部教室”。</p>
                )}
              </div>
              {roomState.results.length > 36 && (
                <p className="list-limit">当前先显示前 36 间，共 {roomState.results.length} 间匹配。</p>
              )}
              <p className="disclaimer">{data.disclaimer}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section library-section">
        <div className="library-card">
          <span className="section-number">03</span>
          <p className="eyebrow">RESOURCE RELATIONSHIP / 下一阶段</p>
          <h2>一份文件，只存一次；<br />在所有相关课程里被找到。</h2>
          <p>
            资料将用文件哈希去重，再通过“资料—课程号—专业”关系复用链接。上传新资料时采用版本化发布，
            访客继续读取旧版本，发布完成后再原子切换，因此不会因后台上传把正在访问的网站弄崩。
          </p>
          <div className="relation-demo">
            <span>同一资料</span>
            <i>→</i>
            <span>课程号</span>
            <i>→</i>
            <span>多个专业入口</span>
          </div>
        </div>
        <aside className="tribute-card">
          <span>致敬开放知识</span>
          <blockquote>
            这个项目最初受到 Alexandra Elbakyan 对知识可及性问题的关注所启发。
          </blockquote>
          <p>
            DUFESH 只收录公开、已获授权或由上传者拥有传播权的学习资料；致敬的是让知识更容易抵达人的愿望，
            不是复制任何网站或未经授权的内容机制。
          </p>
          <b>— 项目说明 / DRAFT 01</b>
        </aside>
      </section>

      <footer>
        <Wordmark />
        <div>
          <strong>非官方学生工具</strong>
          <p>课程、教室与通知以东北财经大学官方系统为准。</p>
        </div>
        <div className="footer-links">
          <a href="https://ginkgostu.dufe.edu.cn/" target="_blank" rel="noreferrer">白果云 ↗</a>
          <a href="https://jwc.dufe.edu.cn/" target="_blank" rel="noreferrer">教务处 ↗</a>
          <span>dufesh.cn</span>
        </div>
      </footer>
    </main>
  );
}
