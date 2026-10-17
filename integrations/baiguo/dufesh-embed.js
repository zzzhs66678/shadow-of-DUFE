"use strict";

if (new URLSearchParams(location.search).get("embed") === "dufesh") {
  document.documentElement.classList.add("dufesh-embed");
  document.addEventListener("DOMContentLoaded", () => {
    const logout = document.getElementById("logout-button");
    if (logout) logout.textContent = "退出白果云";
    const boundary = document.getElementById("boundary-note");
    if (boundary) boundary.textContent = "监控仅在淡红色时段内运行。";
    const grid = document.getElementById("week-grid");
    const weekToggle = document.createElement("button");
    weekToggle.type = "button";
    weekToggle.className = "button button-quiet button-small compact-week-toggle";
    weekToggle.setAttribute("aria-controls", "week-grid");
    let fullWeek = false;
    const compactWeek = () => {
      const weekendBusy = [...grid.querySelectorAll(".day-column.is-weekend")]
        .some(day => day.querySelector(".course-block, .monitor-band, .day-tag"));
      const expanded = fullWeek || weekendBusy;
      grid.dataset.visibleDays = expanded ? "7" : "5";
      weekToggle.hidden = weekendBusy;
      weekToggle.setAttribute("aria-pressed", String(expanded));
      weekToggle.textContent = expanded ? "隐藏空白周末" : "显示完整七天";
    };
    weekToggle.addEventListener("click", () => { fullWeek = !fullWeek; compactWeek(); });
    document.querySelector(".week-toolbar").append(weekToggle);
    new MutationObserver(compactWeek).observe(grid, { childList: true });
    compactWeek();
    let pending = 0;
    const notify = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        window.parent.postMessage({ type: "dufesh:baiguo-ready", height: document.body.scrollHeight }, "https://dufesh.cn");
      });
    };
    new ResizeObserver(notify).observe(document.body);
    const dialogs = [...document.querySelectorAll("dialog")];
    const watchDialogs = new MutationObserver(() => {
      window.parent.postMessage({ type: "dufesh:baiguo-dialog", open: dialogs.some(dialog => dialog.open) }, "https://dufesh.cn");
    });
    dialogs.forEach(dialog => watchDialogs.observe(dialog, { attributes: true, attributeFilter: ["open"] }));
    window.addEventListener("message", event => {
      if (event.origin !== "https://dufesh.cn" || event.source !== window.parent || event.data?.type !== "dufesh:baiguo-viewport") return;
      const height = event.data.height;
      if (typeof height === "number" && Number.isFinite(height)) {
        document.documentElement.style.setProperty("--embed-viewport-height", `${Math.max(240, Math.min(2400, height))}px`);
      }
    });
    notify();
  });
}
