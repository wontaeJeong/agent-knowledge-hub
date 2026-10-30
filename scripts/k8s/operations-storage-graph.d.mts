import type { PoolClient } from "pg";
export interface ContentReference {
  workspace_id: string;
  owner_kind: "resource" | "import";
  parent_kind: string;
  owner_id: string;
  sha256: string;
  size: number;
}
export function allContentReferences(
  db: PoolClient,
): Promise<ContentReference[]>;
export function backupReferenceRows(
  db: PoolClient,
): Promise<{ sha256: string; size: number }[]>;
export function hashHasLiveReference(
  db: PoolClient,
  sha256: string,
): Promise<boolean>;
