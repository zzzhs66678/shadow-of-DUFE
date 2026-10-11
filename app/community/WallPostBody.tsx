"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { hasDistinctTitle } from "./WallPrimitives";
import styles from "./WallPostBody.module.css";

export type WallPostBodyProps = {
  topic: { id: string; title: string; body: string };
  href: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
};

/** Expansion belongs to the feed so it can survive navigation and remounts. */
export function WallPostBody({ topic, href, expanded, onExpandedChange }: WallPostBodyProps) {
  const bodyId = `wall-post-body-${useId()}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const collapseRequest = useRef<{ topicId: string; returnToPost: boolean; focus: boolean } | null>(null);
  const [overflow, setOverflow] = useState<{ body: string; topicId: string; value: boolean } | null>(null);
  const isLong = overflow?.topicId === topic.id && overflow.body === topic.body && overflow.value;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let frame = 0;
    let disposed = false;
    const measure = () => {
      frame = 0;
      // The inner paragraph is never clamped: measure its real wrapped height,
      // even while expanded, rather than guessing from characters or newlines.
      const lineHeight = Number.parseFloat(getComputedStyle(body).lineHeight);
      if (!Number.isFinite(lineHeight) || body.getBoundingClientRect().width === 0) return;
      const value = body.scrollHeight > lineHeight * 6 + 1;
      setOverflow((previous) => previous?.topicId === topic.id && previous.body === topic.body && previous.value === value
        ? previous : { topicId: topic.id, body: topic.body, value });
    };
    const scheduleMeasure = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(body);
    window.addEventListener("resize", scheduleMeasure);
    document.fonts?.addEventListener("loadingdone", scheduleMeasure);
    void document.fonts?.ready.then(scheduleMeasure);
    scheduleMeasure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      document.fonts?.removeEventListener("loadingdone", scheduleMeasure);
    };
  }, [topic.id, topic.body]);

  useLayoutEffect(() => {
    const request = collapseRequest.current;
    if (expanded || !request) return;
    collapseRequest.current = null;
    if (request.topicId !== topic.id) return;
    // Keep the same keyboard target; focusing it must not trigger a second jump.
    if (request.focus) toggleRef.current?.focus({ preventScroll: true });
    if (request.returnToPost) {
      rootRef.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    }
  }, [expanded, topic.id]);

  function toggle() {
    if (expanded) {
      const root = rootRef.current;
      const button = toggleRef.current;
      // Only return when the beginning has left the reading viewport. A short
      // expansion visible on screen should not move the reader's scroll position.
      const scrollMargin = root ? Number.parseFloat(getComputedStyle(root).scrollMarginBlockStart) || 0 : 0;
      collapseRequest.current = {
        topicId: topic.id,
        returnToPost: Boolean(root && root.getBoundingClientRect().top < scrollMargin),
        focus: document.activeElement === button,
      };
    } else {
      collapseRequest.current = null;
    }
    onExpandedChange(!expanded);
  }

  return <div ref={rootRef} className={styles.postBody}>
    {hasDistinctTitle(topic) && <h2 className={styles.title}><Link href={href}>{topic.title}</Link></h2>}
    <div id={bodyId} className={styles.bodyViewport} data-expanded={expanded}>
      <p ref={bodyRef} className={styles.body}>{topic.body}</p>
    </div>
    <div className={styles.readingActions}>
      {isLong && <button ref={toggleRef} type="button" className={styles.toggle}
        aria-expanded={expanded} aria-controls={bodyId} onClick={toggle}>
        {expanded ? "收起全文" : "展开全文"}<span className={styles.chevron} aria-hidden="true">⌄</span>
      </button>}
      <Link className={styles.discussionLink} href={href}>查看讨论</Link>
    </div>
  </div>;
}
