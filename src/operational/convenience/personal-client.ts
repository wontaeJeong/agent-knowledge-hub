import { useRef } from "react";
import { ApiError, type OperationalApi } from "../api";
export type LibraryKind = "favorites" | "recent" | "subscriptions";
export interface LibraryPage {
  items: {
    id: string;
    title: string;
    version: number;
    at: string | null;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
  }[];
  nextCursor: string | null;
  revision: number;
}
export const libraryLabels: Record<LibraryKind, string> = {
  favorites: "즐겨찾기",
  recent: "최근 문서",
  subscriptions: "구독 문서",
};
export function usePersonalKey(api: OperationalApi, scope: string) {
  const value = useRef({ api, scope, generation: 0 });
  if (value.current.api !== api || value.current.scope !== scope)
    value.current = { api, scope, generation: value.current.generation + 1 };
  return value.current.generation;
}
export const personalFailure = (e: unknown) =>
  e instanceof ApiError &&
  ["STALE_CURSOR", "STALE_VERSION", "MUTATION_CONFLICT"].includes(e.code)
    ? "목록이 변경되었습니다. 처음부터 다시 불러오세요."
    : e instanceof Error
      ? e.message
      : "개인 문서를 불러오지 못했습니다.";
export function personalChanged() {
  window.dispatchEvent(new Event("akh:personal-changed"));
}
