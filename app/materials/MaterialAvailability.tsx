"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./materials.module.css";

export function MaterialAvailability({
  downloadUrl,
  previewUrl,
  previewable,
}: {
  downloadUrl: string;
  previewUrl: string;
  previewable: boolean;
}) {
  const [state, setState] = useState<"checking" | "ready" | "missing" | "denied" | "offline">("checking");

  useEffect(() => {
    const controller = new AbortController();
    fetch(downloadUrl, { method: "HEAD", cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (response.status === 403) setState("denied");
        else if (response.status === 404 || response.status === 410) setState("missing");
        else if (response.ok) setState("ready");
        else setState("offline");
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setState("offline");
      });
    return () => controller.abort();
  }, [downloadUrl]);

  if (state === "missing" || state === "denied") {
    return (
      <div className={styles.availabilityWarning} role="alert">
        <b>{state === "missing" ? "文件暂时不在资料架上" : "这份文件当前不可公开访问"}</b>
        <p>{state === "missing" ? "索引仍然保留，但文件可能正在整理或已经撤下。" : "资料可能需要额外授权，当前不会绕过访问限制。"}</p>
        <Link href="/materials">返回资料搜索</Link>
      </div>
    );
  }

  return (
    <div className={styles.detailActions}>
      <span aria-live="polite">
        {state === "checking" ? "正在确认文件…" : state === "offline" ? "无法确认文件状态，仍可尝试打开" : "文件可用"}
      </span>
      <div>
        {previewable && <a className={styles.primaryAction} href={previewUrl} target="_blank" rel="noreferrer">在线预览 ↗</a>}
        <a className={previewable ? styles.secondaryAction : styles.primaryAction} href={downloadUrl} download>下载原件</a>
      </div>
    </div>
  );
}
