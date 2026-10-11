"use client";

import { useSyncExternalStore } from "react";
import { localHref, safeCourseReturn } from "./discovery-navigation";
import styles from "./public-masthead.module.css";

const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
};
const readSearch = () => window.location.search;
const serverSearch = () => "";

export function useCourseReturn() {
  const search = useSyncExternalStore(subscribe, readSearch, serverSearch);
  return safeCourseReturn(new URLSearchParams(search).get("returnTo"));
}

export function CourseReturnLink() {
  const target = useCourseReturn();
  if (!target) return null;
  return <a className={styles.courseBack} href={target} onClick={(event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const referrer = document.referrer ? new URL(document.referrer) : null;
    if (referrer?.origin === location.origin && localHref(referrer) === target) {
      event.preventDefault();
      history.back();
    }
  }}>← 返回刚才的教学班</a>;
}
