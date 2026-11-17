import type { PoolClient } from "pg";
import { segmentAnchors, type Anchor } from "../workflows/versions/diff";
export type BlockReference = Anchor;
/** Workspace is explicit: a pooled SQL client is never an authorization scope.
 * Only the trusted publication metadata hook persists these references. */
export async function captureBlockReferences(
  db: { client: PoolClient; workspaceId: string },
  pageId: string,
  version: number,
  content: string,
): Promise<BlockReference[]> {
  const prior =
    (
      await db.client.query(
        "SELECT anchors FROM version_metadata WHERE workspace_id=$1 AND page_id=$2 AND number<$3 ORDER BY number DESC LIMIT 1",
        [db.workspaceId, pageId, version],
      )
    ).rows[0]?.anchors?.anchors ?? [];
  return segmentAnchors(pageId, version, content, prior, true).anchors;
}
