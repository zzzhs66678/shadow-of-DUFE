"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  courseWorkspaceHref, readCourseWorkspace,
  type CourseWorkspaceState, type CourseWorkspaceTab,
} from "./course-workspace";

export function useCourseWorkspace(fallback: CourseWorkspaceTab) {
  const [state, setState] = useState(() => readCourseWorkspace("", fallback));
  const current = useRef(state);
  const fallbackRef = useRef(fallback);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const restore = () => {
      const next = readCourseWorkspace(window.location.search, fallbackRef.current);
      current.current = next;
      setState(next);
      setRevision((value) => value + 1);
      setReady(true);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const update = useCallback((patch: Partial<CourseWorkspaceState>, push = false) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setState(next);
    const href = courseWorkspaceHref(window.location.href, next);
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (href !== currentHref) {
      window.history[push ? "pushState" : "replaceState"](window.history.state, "", href);
    }
  }, []);

  return { state, ready, revision, update };
}
