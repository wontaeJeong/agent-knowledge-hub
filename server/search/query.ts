import type { PoolClient } from "pg";
/** Parameterized literal substring query. GIN proposes tuples; LIKE rechecks exact text. */
export const CONTENT_MATCH_SQL =
  "SELECT page_id,number FROM versions WHERE workspace_id=$1 AND lower(data->>'content') LIKE lower($2) ESCAPE '!'";
export const literalPattern = (query: string) =>
  "%" + query.replace(/[!%_]/g, "!$&") + "%";
export async function indexedContentMatches(
  db: PoolClient,
  workspaceId: string,
  query: string,
) {
  if (!query) return [];
  return (
    await db.query(CONTENT_MATCH_SQL, [workspaceId, literalPattern(query)])
  ).rows as { page_id: string; number: number }[];
}
