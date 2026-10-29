import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { openBackup } from "./backup-format.mjs";

const [file] = process.argv.slice(2);
if (!file) {
  console.error(
    "Usage: AGENT_KNOWLEDGE_HUB_BACKUP_KEY=... node scripts/k8s/verify-restore.mjs FILE.akh-backup",
  );
  process.exit(1);
}
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
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
const database = `restore_verify_${randomBytes(8).toString("hex")}`;
let created = false;
try {
  const envelope = readFileSync(file, "utf8"),
    manifest = JSON.parse(readFileSync(`${file}.json`, "utf8"));
  if (createHash("sha256").update(envelope).digest("hex") !== manifest.sha256)
    throw Error("BACKUP_CHECKSUM_MISMATCH");
  const dump = openBackup(envelope, process.env.AGENT_KNOWLEDGE_HUB_BACKUP_KEY);
  const started = Date.now();
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
    dump,
  );
  const counts = run([
    "psql",
    "-U",
    "knowledge",
    "-d",
    database,
    "-At",
    "-c",
    "SELECT 'pages='||count(*) FROM pages UNION ALL SELECT 'versions='||count(*) FROM versions UNION ALL SELECT 'sources='||count(*) FROM sources",
  ]);
  console.log(
    `폐기용 로컬 DB 복원 성공 (${Date.now() - started} ms)\n${counts.trim()}`,
  );
  console.log(
    "사내 PVC/외부 blob/삭제 tombstone 재적용·운영 RTO 검증은 별도입니다.",
  );
} catch {
  console.error("복원 검증 실패. 기존 운영 DB는 수정하지 않았습니다.");
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      run(["dropdb", "-U", "knowledge", database]);
    } catch {
      console.error(`직접 생성한 임시 DB 정리 실패: ${database}`);
      process.exitCode = 1;
    }
  }
}
