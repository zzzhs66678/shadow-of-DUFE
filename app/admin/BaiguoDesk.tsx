"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./admin.module.css";

const origin = "https://baiguo.dufesh.cn";

export function BaiguoDesk({ onMfaExpired }: { onMfaExpired: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [access, setAccess] = useState<"checking" | "ready" | "error">("checking");
  const [connection, setConnection] = useState<"loading" | "ready" | "error">("loading");
  const [height, setHeight] = useState(680);
  const reload = useCallback(() => {
    setAccess("checking");
    setConnection("loading");
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let expiry: ReturnType<typeof setTimeout>;
    let checking = false;
    const check = async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const response = await fetch("/api/admin/session", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          onMfaExpired();
          return;
        }
        if (!response.ok) throw new Error("access_unavailable");
        const session = await response.json() as { role?: string; elevated?: boolean; elevatedUntil?: string };
        if (controller.signal.aborted) return;
        const remaining = Date.parse(session.elevatedUntil ?? "") - Date.now();
        if (session.role !== "admin" || !session.elevated || !(remaining > 0)) {
          onMfaExpired();
          return;
        }
        clearTimeout(expiry);
        expiry = setTimeout(onMfaExpired, Math.min(remaining, 2_147_483_647));
        if (!controller.signal.aborted) setAccess("ready");
      } catch {
        if (!controller.signal.aborted) setAccess("error");
      } finally {
        checking = false;
      }
    };
    const visible = () => { if (!document.hidden) void check(); };
    void check();
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(expiry);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [attempt, onMfaExpired]);

  useEffect(() => {
    if (access !== "ready") return;
    const timeout = setTimeout(() => setConnection("error"), 20_000);
    let previousScroll: number | null = null;
    const viewport = () => frame.current?.contentWindow?.postMessage({ type: "dufesh:baiguo-viewport", height: window.innerHeight }, origin);
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "dufesh:baiguo-dialog") {
        if (event.data.open === true && frame.current && previousScroll === null) {
          previousScroll = window.scrollY;
          viewport();
          window.scrollTo({ top: frame.current.getBoundingClientRect().top + window.scrollY, behavior: "instant" });
        } else if (event.data.open === false && previousScroll !== null) {
          window.scrollTo({ top: previousScroll, behavior: "instant" });
          previousScroll = null;
        }
        return;
      }
      if (event.data?.type !== "dufesh:baiguo-ready") return;
      clearTimeout(timeout);
      setConnection("ready");
      const value = event.data.height;
      if (typeof value === "number" && Number.isFinite(value)) {
        setHeight(Math.max(520, Math.min(8000, Math.ceil(value))));
      }
    };
    window.addEventListener("message", receive);
    window.addEventListener("resize", viewport);
    return () => { clearTimeout(timeout); window.removeEventListener("message", receive); window.removeEventListener("resize", viewport); };
  }, [access, attempt]);

  return (
    <section className={styles.baiguoDesk} aria-label="白果云私人课表">
      <div className={styles.baiguoToolbar}>
        <p>查看课程监控，处理单次调课、停课与补课。</p>
        <a href={origin} target="_blank" rel="noopener noreferrer">独立打开 ↗</a>
      </div>
      {(access !== "ready" || connection !== "ready") && (
        <div className={styles.baiguoState} role="status">
          {access === "error" || connection === "error" ? (
            <><p>暂时无法载入白果云课表。请重新载入，或独立打开。</p><button onClick={reload}>重新载入</button></>
          ) : <p>{access === "checking" ? "正在确认管理员身份…" : "正在连接白果云课表…"}</p>}
        </div>
      )}
      {access === "ready" && (
        <iframe
          key={attempt}
          ref={frame}
          className={styles.baiguoFrame}
          title="白果云私人课表管理"
          src={`${origin}/?embed=dufesh`}
          height={height}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
      <p className={styles.baiguoNote}>首次使用需输入白果云管理口令；退出白果云请使用课表内的退出按钮。</p>
    </section>
  );
}
