import { Pool } from "pg";
import { migrate } from "../server/database.ts";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    await migrate(pool);
    console.log("Database migrations applied");
  } catch {
    console.error(
      "Database migration failed; no changes committed. Check database connectivity and migration checksums.",
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
