import { execFileSync } from "node:child_process";
import pg from "pg";
import {
  FileTarget,
  coordinatedBackup,
  retainBackups,
} from "./operations-backup.mjs";
import { coordinatedArchiveBackup } from "./operations-stream-coordinator.mjs";
import { kubectlDump } from "./operations-dump.mjs";
import { withBackupRetentionPolicy } from "./operations-retention-policy.mjs";
const [context, namespace, directory] = process.argv.slice(2);
if (
  !context ||
  !/^agent-knowledge-hub-(local|stg|prod)$/.test(namespace ?? "") ||
  !directory ||
  !process.env.DATABASE_URL ||
  !process.env.CONTENT_DIRECTORY
) {
  console.error(
    "Usage: DATABASE_URL=... CONTENT_DIRECTORY=... node scripts/k8s/backup.mjs CONTEXT NAMESPACE INDEPENDENT_BACKUP_MOUNT",
  );
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5000,
});
const base = [
  "--context",
  context,
  "-n",
  namespace,
  "exec",
  "knowledge-db-0",
  "--",
];
const run = (args) =>
  execFileSync("kubectl", [...base, ...args], { maxBuffer: 512 * 1024 * 1024 });
try {
  const database = (await pool.query("SELECT current_database() AS name"))
    .rows[0].name;
  // Never gate one DB while accidentally dumping another cluster through kubectl.
  const local = (
    await pool.query(
      "SELECT system_identifier::text AS id FROM pg_control_system()",
    )
  ).rows[0].id;
  const remote = run([
    "psql",
    "-U",
    "knowledge",
    "-d",
    database,
    "-At",
    "-c",
    "SELECT system_identifier::text FROM pg_control_system()",
  ])
    .toString()
    .trim();
  if (local !== remote) throw Error("DATABASE_TARGET_MISMATCH");
  const target = new FileTarget(directory, process.env.CONTENT_DIRECTORY);
  const streaming = process.env.BACKUP_FORMAT !== "2";
  const timeoutMs = Number(process.env.BACKUP_DUMP_TIMEOUT_MS ?? 300000);
  const result = await (
    streaming ? coordinatedArchiveBackup : coordinatedBackup
  )({
    pool,
    target,
    contentDirectory: process.env.CONTENT_DIRECTORY,
    key: process.env.AGENT_KNOWLEDGE_HUB_BACKUP_KEY,
    keyId: process.env.BACKUP_KEY_ID ?? "current",
    gateConfirmed: process.env.BACKUP_MUTATION_GATE_CONFIRMED === "true",
    timeoutMs,
    dumpTimeoutMs: timeoutMs,
    maxStagingBytes: Number(
      process.env.BACKUP_MAX_PLAINTEXT_BYTES ?? 16 * 1024 ** 3,
    ),
    dumpDatabase: async (signal) =>
      streaming
        ? kubectlDump(base, database, signal)
        : execFileSync(
            "kubectl",
            [...base, "pg_dump", "-U", "knowledge", "-d", database, "-Fc"],
            { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, stdio: "pipe" },
          ),
  });
  if (process.env.BACKUP_RETENTION_DAYS)
    await withBackupRetentionPolicy(
      pool,
      Number(process.env.BACKUP_RETENTION_DAYS),
      (days) => retainBackups(target, days),
    );
  console.log(
    `암호화 DB+파일 백업 검증 완료: ${result.name} (${result.blobCount} blobs). 보관 대상의 독립 장애 영역은 별도 확인해야 합니다.`,
  );
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message)
      ? error.message
      : "BACKUP_FAILED";
  console.error(
    `DB+파일 백업 실패 (${code}). 경로·mutation gate·키·DB 대상과 독립 보관 구성을 확인하세요.`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
