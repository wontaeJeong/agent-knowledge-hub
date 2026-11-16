import type { PoolClient } from "pg";
/** Parameterized physical GIN candidate query; PostgreSQL folding is not the final JS matcher. */
export const CONTENT_MATCH_SQL =
  "SELECT page_id,number FROM versions WHERE workspace_id=$1 AND lower(data->>'content') LIKE lower($2) ESCAPE '!'";
export const literalPattern = (query: string) =>
  "%" + query.replace(/[!%_]/g, "!$&") + "%";
export async function indexedContentMatches(
  db: PoolClient,
  workspaceId: string,
  query: string,
  authorizedPages: readonly {
    id: string;
    versions: readonly { number: number; content: string }[];
  }[],
) {
  if (!query) return [];
  const indexed = (
    await db.query(CONTENT_MATCH_SQL, [workspaceId, literalPattern(query)])
  ).rows as { page_id: string; number: number }[];
  // SQL lower() and JS toLocaleLowerCase() need not agree (e.g. final sigma,
  // dotted I, or different process/database locales). Never discard a JS hit.
  // The fallback visits only the already-loaded authorized snapshot, adds no
  // content query, and never truncates or relaxes the caller's final ACL gates.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const databaseFold = (
    await db.query("SELECT lower($1::text) AS folded", [alphabet])
  ).rows[0].folded;
  const fallbackAll =
    /[^\x00-\x7f]/.test(query) || databaseFold !== alphabet.toLocaleLowerCase();
  const candidates = new Map(
    indexed.map((row) => [`${row.page_id}:${row.number}`, row]),
  );
  for (const page of authorizedPages)
    for (const version of page.versions)
      if (fallbackAll || /[^\x00-\x7f]/.test(version.content))
        candidates.set(`${page.id}:${version.number}`, {
          page_id: page.id,
          number: version.number,
        });
  // Conservative superset only: every caller must verify the JS substring.
  return [...candidates.values()];
}
