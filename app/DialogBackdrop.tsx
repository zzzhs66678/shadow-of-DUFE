"use client";

import type { MouseEvent, ReactNode } from "react";
import styles from "./dialog-backdrop.module.css";

export function DialogBackdrop({
  children,
  onDismiss,
  dismissDisabled = false,
  priority = "default",
}: {
  children: ReactNode;
  onDismiss: () => void;
  dismissDisabled?: boolean;
  priority?: "default" | "critical";
}) {
  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !dismissDisabled) onDismiss();
  }

  return (
    <div
      className={`${styles.backdrop} ${priority === "critical" ? styles.critical : ""}`}
      onMouseDown={handleMouseDown}
    >
      {children}
    </div>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <footer className={styles.actions}>{children}</footer>;
}
