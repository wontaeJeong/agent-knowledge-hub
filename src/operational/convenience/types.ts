import type { ConsoleTab } from "../console";
export const convenienceSections = [
  "home",
  "favorites",
  "recent",
  "subscriptions",
  "search",
  "compose",
  "tasks",
  "saved-views",
] as const;
export type ConvenienceSection = (typeof convenienceSections)[number];
export type TaskTarget = {
  targetKind: "review" | "job" | "access-request";
  targetId: string;
};
export type ConvenienceLocation =
  | { kind: "invalid"; error: string }
  | { kind: "console"; spaceId?: string; tab: ConsoleTab }
  | { kind: "share"; spaceId: string; share: string }
  | {
      kind: "document";
      spaceId: string;
      document: string;
      comment?: string;
      share?: string;
      version?: number;
      anchor?: string;
      tab?: "workflows";
    }
  | ({ kind: "section"; spaceId: string } & (
      | {
          section: ConvenienceSection;
          draft?: never;
          view?: never;
          targetKind?: never;
          targetId?: never;
        }
      | { section: "compose"; draft?: string }
      | { section: "saved-views"; view?: string }
      | ({ section: "tasks" } & (
          TaskTarget | { targetKind?: never; targetId?: never }
        ))
    ));
export interface NavigationItem {
  id: ConsoleTab;
  label: string;
  group: "지식 공간" | "내 문서" | "지식 도구" | "내 도구" | "관리·운영";
}
