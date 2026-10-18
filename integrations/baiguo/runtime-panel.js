  function runtimeStamp(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return "尚无记录";
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  }
  function renderRuntime() {
    const data = state.dashboard;
    const renewal = data.session_renewal || {};
    const events = Array.isArray(data.runtime_events) ? data.runtime_events : [];
    const rejected = data.last_auth_rejected_at || events.find(item => item.kind === "auth_rejected")?.at;
    const actions = (Array.isArray(data.recent_actions) ? data.recent_actions : []).map(item => ({ ...item, at: item.updated_at }));
    const confirmed = [...events.filter(item => item.kind === "attendance"), ...actions]
      .filter(item => ["confirmed", "observed_signed"].includes(item.status) && Number.isFinite(Date.parse(item.at)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const labels = { disabled: "自动重登已关闭", idle: "当前没有重登任务", waiting: "已排队，等待尝试", running: "正在自动重登", success: "凭据已更新，仍以学校验证结果为准", failed: "自动重登未成功", needs_manual_login: "需要人工重新登录", unavailable: "自动重登暂不可用", cooldown: "等待重试间隔", closed: "重登任务已停止", interrupted: "上次重登因服务重启中断" };
    let account = "学校登录尚未验证";
    if (data.authentication_state === "authenticated") account = `学校登录最近验证通过 · ${runtimeStamp(data.last_auth_accepted_at)}`;
    if (data.authentication_state === "auth_required") account = "学校登录已失效，当前无法自动签到";
    if (data.health_stale) account = "监控状态待更新，当前登录与签到情况暂不能确认";
    setText("runtime-account", account);
    setText("runtime-freshness", data.updated_at ? `北京时间 · 更新 ${runtimeStamp(data.updated_at)}` : "北京时间 · 状态尚未更新");
    setText("runtime-rejected", rejected ? runtimeStamp(rejected) : "尚无失效记录");
    setText("runtime-renewal-time", renewal.last_attempt ? runtimeStamp(renewal.last_attempt) : "尚无尝试记录");
    let renewalStatus = labels[renewal.status] || "状态尚未记录";
    if (["idle", "disabled", "closed"].includes(renewal.status) && renewal.last_result) renewalStatus += `；上次${labels[renewal.last_result] || "结果未记录"}`;
    setText("runtime-renewal-status", renewalStatus);
    setText("runtime-attendance-time", confirmed ? runtimeStamp(confirmed.at) : "尚无确认记录");
    setText("runtime-attendance-status", confirmed ? `活动 ${confirmed.activity_id} · ${actionResult(confirmed.status).label}` : "提交待确认不计为签到成功");
    const next = renewal.pending_at || renewal.next_attempt;
    setText("runtime-next", next && ["waiting", "cooldown"].includes(renewal.status) ? `最早尝试时间 ${runtimeStamp(next)}，仅在允许的课程监控时段内尝试。` : "课外待机不会主动检查学校登录；页面每15秒读取后台状态。");
    setText("runtime-count", events.length);
    const titles = { auth_rejected: "发现学校登录失效", auth_verified: "学校登录验证通过", renew_queued: "自动重登已排队", renew_started: "开始自动重登", renew_success: "自动重登已更新凭据", renew_failed: "自动重登未成功", renew_manual: "重登需要人工处理", renew_unavailable: "自动重登暂不可用", renew_interrupted: "自动重登因服务重启中断" };
    const nodes = events.slice(0, 100).map(item => {
      const row = element("li", "runtime-event");
      const time = element("time", "runtime-meta", runtimeStamp(item.at));
      time.dateTime = item.at;
      const title = item.kind === "attendance" ? `签到 ${item.activity_id} · ${actionResult(item.status).label}` : titles[item.kind] || "状态更新";
      row.append(time, element("span", "", title));
      return row;
    });
    if (!nodes.length) nodes.push(element("li", "runtime-meta", "尚无事件记录，后续登录变化与签到确认会显示在这里。"));
    $("runtime-events").replaceChildren(...nodes);
  }
