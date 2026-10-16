"use strict";

if (new URLSearchParams(location.search).get("embed") === "dufesh") {
  document.documentElement.classList.add("dufesh-embed");
  document.addEventListener("DOMContentLoaded", () => {
    const logout = document.getElementById("logout-button");
    if (logout) logout.textContent = "退出白果云";
    const boundary = document.getElementById("boundary-note");
    if (boundary) boundary.textContent = "监控仅在淡红色时段内运行。";
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
