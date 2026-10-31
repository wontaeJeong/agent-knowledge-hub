import { Pool } from "pg";
import { writeFile } from "node:fs/promises";
import { captureRecoveryLedger } from "../../server/operations/recovery";
// Infrastructure credential, never exposed through browser or supplied in request body.
const [file] = process.argv.slice(2);
if (
  !file ||
  !process.env.DATABASE_URL ||
  !process.env.AUDIT_EXPORT_KEY ||
  !process.env.AUDIT_SIGNING_KEY
)
  throw Error("RECOVERY_LEDGER_CONFIG_REQUIRED");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
try {
  const encrypted = await captureRecoveryLedger(
    pool,
    process.env.AUDIT_EXPORT_KEY,
    process.env.AUDIT_SIGNING_KEY,
  );
  await writeFile(file, encrypted, { mode: 0o600, flag: "wx" });
  console.log(
    "서명·암호화된 현재 복구 제한 기록 생성. 독립 보관 경로로 전송하고 복원 직전 갱신하세요.",
  );
} catch {
  console.error("복구 제한 기록 생성 실패");
  process.exitCode = 1;
} finally {
  await pool.end();
}
