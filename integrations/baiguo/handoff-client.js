  let autoConnecting = false;
  window.addEventListener("message", async event => {
    if (new URLSearchParams(location.search).get("autoconnect") !== "1" || event.origin !== "https://dufesh.cn" || event.source !== window.parent || event.data?.type !== "dufesh:baiguo-login" || autoConnecting) return;
    const ticket = event.data.ticket;
    if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return;
    autoConnecting = true;
    try {
      const data = await api("/api/handoff/exchange", { method: "POST", body: JSON.stringify({ ticket }) });
      state.authenticated = true;
      state.csrf = data.csrf || "";
      await loadDashboard();
    } catch {
      window.parent.postMessage({ type: "dufesh:baiguo-auth-failed" }, "https://dufesh.cn");
    } finally { autoConnecting = false; }
  });
