import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { sealBackup } from "./backup-format.mjs";

// Explicit context, namespace and output directory; never silently select PROD.
const [context, namespace, directory] = process.argv.slice(2);
if (
  !context ||
  !/^agent-knowledge-hub-(local|stg|prod)$/.test(namespace || "") ||
  !directory
) {
  console.error(
    "Usage: node scripts/k8s/backup.mjs CONTEXT NAMESPACE EXTERNAL_BACKUP_DIRECTORY",
  );
  process.exit(1);
}
try {
  const args = [
    "--context",
    context,
    "-n",
    namespace,
    "exec",
    "knowledge-db-0",
    "--",
    "pg_dump",
    "-U",
    "knowledge",
    "-d",
    "knowledge",
    "-Fc",
  ];
  const dump = execFileSync("kubectl", args, { maxBuffer: 512 * 1024 * 1024 });
  const encrypted = sealBackup(
    dump,
    process.env.AGENT_KNOWLEDGE_HUB_BACKUP_KEY,
  );
  const at = new Date().toISOString();
  const name = `knowledge-${at.replace(/[:.]/g, "-")}.akh-backup`;
  const target = resolve(directory);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(target, name), encrypted, { mode: 0o600, flag: "wx" });
  writeFileSync(
    resolve(target, `${name}.json`),
    JSON.stringify(
      {
        version: 1,
        at,
        context,
        namespace,
        file: name,
        sha256: createHash("sha256").update(encrypted).digest("hex"),
        bytes: dump.length,
        scope:
          "PostgreSQL only; external blobs require a coordinated manifest and backup",
        encrypted: true,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    `암호화 DB 백업 생성: ${name} (${dump.length} bytes). 독립 보관·복원 검증 전 운영 백업 완료가 아닙니다.`,
  );
} catch {
  console.error(
    "DB 백업 실패. 비밀이 포함되지 않은 클러스터 상태를 확인하세요.",
  );
  process.exitCode = 1;
}
