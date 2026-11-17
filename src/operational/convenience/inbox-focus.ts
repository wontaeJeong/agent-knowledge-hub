import { useCurrentListFocus } from "./list-focus";

/** Backward-compatible inbox selectors/message over the shared current-DOM helper. */
export function useInboxFocus<T extends HTMLElement>(enabled = true) {
  return useCurrentListFocus<T>({
    enabled,
    rowSelector: "[data-inbox-row]",
    fallbackSelector: "[data-inbox-focus-fallback]",
    message: "알림 목록이 변경되어 현재 표시된 항목으로 초점을 옮겼습니다.",
  });
}
