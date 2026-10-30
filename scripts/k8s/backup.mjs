import { execFileSync } from "node:child_process";
import pg from "pg";
import {
  FileTarget,
  coordinatedBackup,
  retainBackups,
} from "./operations-backup.mjs";
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
  const result = await coordinatedBackup({
    pool,
    target,
    contentDirectory: process.env.CONTENT_DIRECTORY,
    key: process.env.AGENT_KNOWLEDGE_HUB_BACKUP_KEY,
    keyId: process.env.BACKUP_KEY_ID ?? "current",
    gateConfirmed: process.env.BACKUP_MUTATION_GATE_CONFIRMED === "true",
    dumpDatabase: async () =>
      run(["pg_dump", "-U", "knowledge", "-d", database, "-Fc"]),
  });
  if (process.env.BACKUP_RETENTION_DAYS)
    await retainBackups(target, Number(process.env.BACKUP_RETENTION_DAYS));
  console.log(
    `암호화 DB+파일 백업 검증 완료: ${result.name} (${result.blobCount} blobs). 보관 대상의 독립 장애 영역은 별도 확인해야 합니다.`,
  );
} catch {
  console.error(
    "DB+파일 백업 실패. 경로·mutation gate·키·DB 대상과 독립 보관 구성을 확인하세요.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
