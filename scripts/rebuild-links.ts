/** Operator CLI: same trusted deployment origin as HTTP/MCP, never the request Host. */
import { Pool } from "pg";
import { rebuildPublishedLinks } from "../server/convenience/links";
import { assertSchemaCurrent } from "../server/database";
const [workspaceId, after] = process.argv.slice(2);
if (
  !workspaceId ||
  !/^[a-zA-Z0-9_-]{1,100}$/.test(workspaceId) ||
  process.argv.length > 4
)
  throw Error(
    "Usage: node --import tsx scripts/rebuild-links.ts WORKSPACE [AFTER]",
  );
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await assertSchemaCurrent(pool);
  console.log(
    JSON.stringify(
      await rebuildPublishedLinks(pool, workspaceId, {
        after,
        origin: process.env.APP_ORIGIN,
      }),
    ),
  );
} finally {
  await pool.end();
}
