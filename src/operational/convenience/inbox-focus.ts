import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from "react";

const controls = "a[href],button:not(:disabled),select:not(:disabled),[tabindex='0']";
const scrollPosition = (node: HTMLElement) => {
  const ancestors: { node: HTMLElement; top: number; left: number }[] = [];
  for (let parent = node.parentElement; parent; parent = parent.parentElement)
    ancestors.push({ node: parent, top: parent.scrollTop, left: parent.scrollLeft });
  return { ancestors, x: window.scrollX, y: window.scrollY };
};

/** Recover only a removed focused control, using the current authorized DOM.
 * No rows or protected text are cached to preserve keyboard position. */
export function useInboxFocus<T extends HTMLElement>(enabled = true) {
  const container = useRef<T>(null);
  const focused = useRef<{
    node: HTMLElement;
    rowIndex: number;
    controlIndex: number;
    scroll: ReturnType<typeof scrollPosition>;
  } | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!enabled) return;
    const leave = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) focused.current = null;
    };
    const scroll = () => {
      const current = focused.current;
      if (current?.node.isConnected && document.activeElement === current.node)
        current.scroll = scrollPosition(current.node);
    };
    document.addEventListener("focusin", leave);
    document.addEventListener("pointerdown", leave, true);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("focusin", leave);
      document.removeEventListener("pointerdown", leave, true);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [enabled]);
  useLayoutEffect(() => {
    if (!enabled) { focused.current = null; return; }
    const previous = focused.current;
    if (!previous || previous.node.isConnected || !container.current) return;
    // An intentional move to another control must never be overridden by refresh.
    if (document.activeElement && document.activeElement !== document.body) {
      focused.current = null;
      return;
    }
    const rows = [...container.current.querySelectorAll<HTMLElement>("[data-inbox-row]")];
    const row = rows[Math.min(previous.rowIndex, rows.length - 1)];
    const currentControls = row ? [...row.querySelectorAll<HTMLElement>(controls)] : [];
    const target = currentControls[Math.min(previous.controlIndex, currentControls.length - 1)]
      ?? container.current.querySelector<HTMLElement>("[data-inbox-focus-fallback]")
      ?? container.current.querySelector<HTMLElement>(controls);
    focused.current = null;
    if (!target) return;
    target.focus({ preventScroll: true });
    for (const { node, top, left } of previous.scroll.ancestors) {
      if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
    }
    if (window.scrollX !== previous.scroll.x || window.scrollY !== previous.scroll.y)
      window.scrollTo(previous.scroll.x, previous.scroll.y);
    setNotice("알림 목록이 변경되어 현재 표시된 항목으로 초점을 옮겼습니다.");
  });
  const onFocusCapture = (event: FocusEvent<T>) => {
    const node = event.target as HTMLElement;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-inbox-row]")];
    const row = node.closest<HTMLElement>("[data-inbox-row]");
    focused.current = {
      node,
      rowIndex: Math.max(0, row ? rows.indexOf(row) : 0),
      controlIndex: Math.max(0, row ? [...row.querySelectorAll<HTMLElement>(controls)].indexOf(node) : 0),
      scroll: scrollPosition(node),
    };
  };
  return { container, onFocusCapture, notice };
}
