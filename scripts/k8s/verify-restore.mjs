import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { openBundle, restoreFiles } from "./operations-backup.mjs";
import { tsImport } from "tsx/esm/api";
const [file] = process.argv.slice(2);
const env = process.env;
if (
  !file ||
  !env.DATABASE_URL ||
  !env.RECOVERY_LEDGER_FILE ||
  !env.AUDIT_EXPORT_KEY ||
  !env.AUDIT_SIGNING_KEY
) {
  console.error(
    "Usage: DATABASE_URL=local-forward RECOVERY_LEDGER_FILE=... AUDIT_EXPORT_KEY=... AUDIT_SIGNING_KEY=... BACKUP_KEYS_JSON=... node scripts/k8s/verify-restore.mjs FILE",
  );
  process.exit(1);
}
// Verification is deliberately restricted to the disposable local kind database.
const url = new URL(env.DATABASE_URL);
if (url.hostname !== "127.0.0.1" || url.port !== "55459")
  throw Error("LOCAL_RESTORE_FORWARD_REQUIRED");
const base = [
  "--context",
  "kind-knowledge-hub-dev",
  "-n",
  "agent-knowledge-hub-local",
  "exec",
  "-i",
  "knowledge-db-0",
  "--",
];
const run = (args, input) =>
  execFileSync("kubectl", [...base, ...args], {
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
const database = "akh_ops_restore_" + randomUUID().replaceAll("-", "");
let created = false,
  pool;
try {
  const { readRecoveryLedger, secureRestoredDatabase } = await tsImport(
    "../../server/operations/recovery.ts",
    import.meta.url,
  );
  const ledger = readRecoveryLedger(
    await readFile(env.RECOVERY_LEDGER_FILE, "utf8"),
    env.AUDIT_EXPORT_KEY,
    env.AUDIT_SIGNING_KEY,
  );
  const keys = env.BACKUP_KEYS_JSON
    ? JSON.parse(env.BACKUP_KEYS_JSON)
    : { current: env.AGENT_KNOWLEDGE_HUB_BACKUP_KEY };
  const bundle = openBundle(await readFile(file, "utf8"), keys),
    started = Date.now();
  run(["createdb", "-U", "knowledge", database]);
  created = true;
  run(
    [
      "pg_restore",
      "-U",
      "knowledge",
      "--exit-on-error",
      "--no-owner",
      "-d",
      database,
    ],
    bundle.dump,
  );
  url.pathname = "/" + database;
  pool = new pg.Pool({
    connectionString: url.href,
    connectionTimeoutMillis: 5000,
  });
  const security = await secureRestoredDatabase(pool, ledger);
  const destination = await mkdtemp(
    join(await realpath(tmpdir()), "akh-verified-restore-"),
  );
  await restoreFiles(bundle, destination, security.deletedHashes);
  const refs = (
    await pool.query("SELECT DISTINCT sha256,size FROM storage_blobs")
  ).rows;
  const available = new Map(bundle.files.map((f) => [f.sha256, f.size]));
  for (const ref of refs)
    if (
      !security.deletedHashes.includes(ref.sha256) &&
      available.get(ref.sha256) !== ref.size
    )
      throw Error("RESTORED_BLOB_MISSING");
  console.log(
    `격리 DB+파일 복원 및 삭제/권한 제한 재적용 검증: ${Date.now() - started} ms, ${refs.length} blob 참조. 현재 소유권·세션·정책 재편입 전 서비스 재개 금지. 폐기용 파일: ${destination}`,
  );
} catch {
  console.error("복원 검증 실패. 기존 운영 DB는 수정하지 않았습니다.");
  process.exitCode = 1;
} finally {
  await pool?.end();
  if (created)
    try {
      run(["dropdb", "-U", "knowledge", database]);
    } catch {
      console.error(`직접 생성한 임시 DB 정리 실패: ${database}`);
      process.exitCode = 1;
    }
}
