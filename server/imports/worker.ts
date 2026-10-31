import { Pool } from "pg";
import { assertSchemaCurrent } from "../database";
import { OidcAuth } from "../runtime/auth";
import { RuntimeService } from "../runtime/knowledge";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 6,
  connectionTimeoutMillis: 5000,
});
await assertSchemaCurrent(pool);
const auth = await OidcAuth.create(pool),
  service = new RuntimeService(pool);
service.imports.authorizer = (row) =>
  auth.backgroundContext(row as Parameters<typeof auth.backgroundContext>[0]);
const stop = service.imports.startWorker();
const live = setInterval(() => {}, 60_000);
const shutdown = () => {
  stop();
  clearInterval(live);
  setTimeout(() => {
    void pool.end().then(() => process.exit(0));
  }, 250).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
