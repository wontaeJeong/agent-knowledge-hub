export type LibraryKind = "favorites" | "recent" | "subscriptions";
export interface LibraryItem {
  id: string;
  title: string;
  version: number;
  at: string | null;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}
export interface LibraryPage {
  items: LibraryItem[];
  nextCursor: string | null;
  revision: number;
}
