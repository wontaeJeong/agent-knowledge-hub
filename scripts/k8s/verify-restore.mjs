import { execFileSync, spawn } from "node:child_process";
import {
  readFile,
  mkdtemp,
  realpath,
  open,
  rm,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { openBundle, restoreFiles } from "./operations-backup.mjs";
import { tsImport } from "tsx/esm/api";
import {
  verifyArchive,
  promoteVerifiedArchive,
  discardVerifiedArchive,
} from "./operations-stream.mjs";
import { backupReferenceRows } from "./operations-storage-graph.mjs";
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
  pool,
  verified,
  recoveryRoot,
  successful = false;
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
  const first = await open(file, "r"),
    magic = Buffer.alloc(6);
  try {
    await first.read(magic, 0, 6, 0);
  } finally {
    await first.close();
  }
  const streaming = magic.toString() === "AKH3\r\n";
  let bundle;
  const started = Date.now();
  if (streaming)
    verified = await verifyArchive({
      file,
      keys,
      stagingRoot: env.RESTORE_STAGING_DIRECTORY ?? (await realpath(tmpdir())),
      maxStagingBytes: Number(env.BACKUP_MAX_PLAINTEXT_BYTES ?? 16 * 1024 ** 3),
    });
  else bundle = openBundle(await readFile(file, "utf8"), keys);
  run(["createdb", "-U", "knowledge", database]);
  created = true;
  const restoreArgs = [
    "pg_restore",
    "-U",
    "knowledge",
    "--exit-on-error",
    "--no-owner",
    "-d",
    database,
  ];
  if (streaming) {
    const child = spawn("kubectl", [...base, ...restoreArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(Number(env.RESTORE_TIMEOUT_MS ?? 1800000)),
    });
    child.stdout.resume();
    child.stderr.resume();
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(Error("RESTORE_FAILED")),
      );
    });
    await Promise.all([
      pipeline(createReadStream(verified.databaseFile), child.stdin),
      done,
    ]);
  } else run(restoreArgs, bundle.dump);
  url.pathname = "/" + database;
  pool = new pg.Pool({
    connectionString: url.href,
    connectionTimeoutMillis: 5000,
  });
  const manifest = streaming ? verified.manifest : bundle.manifest;
  const identity = manifest.metadata?.systemIdentifier
    ? {
        backupId: manifest.metadata.backupId,
        database: manifest.metadata.database,
        systemIdentifier: manifest.metadata.systemIdentifier,
        databaseSha256: streaming
          ? manifest.entries[0].sha256
          : manifest.database.sha256,
      }
    : undefined;
  const security = await secureRestoredDatabase(pool, ledger, identity);
  recoveryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "akh-verified-restore-"),
  );
  const destination = join(recoveryRoot, "content");
  const referenceClient = await pool.connect();
  let refs;
  try {
    refs = await backupReferenceRows(referenceClient);
  } finally {
    referenceClient.release();
  }
  const available = new Map(
    streaming
      ? verified.manifest.entries
          .filter((e) => e.kind === "blob")
          .map((e) => [e.name, e.size])
      : bundle.files.map((f) => [f.sha256, f.size]),
  );
  for (const ref of refs)
    if (
      !security.deletedHashes.includes(ref.sha256) &&
      available.get(ref.sha256) !== ref.size
    )
      throw Error("RESTORED_BLOB_MISSING");
  if (streaming) {
    await promoteVerifiedArchive(verified, destination, security.deletedHashes);
    verified = null;
    // The dump is a temporary restore input, NOT content. Never retain pre-erasure plaintext DB copies.
    await unlink(join(destination, "database.dump"));
    const dir = await open(destination, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } else await restoreFiles(bundle, destination, security.deletedHashes);
  successful = true;
  console.log(
    `격리 DB+파일 복원 및 삭제/권한 제한 재적용 검증: ${Date.now() - started} ms, ${refs.length} blob 참조. 현재 소유권·세션·정책 재편입 전 서비스 재개 금지. 격리 DB: ${database}. 폐기용 파일: ${destination}`,
  );
} catch {
  console.error("복원 검증 실패. 기존 운영 DB는 수정하지 않았습니다.");
  process.exitCode = 1;
} finally {
  if (verified) await discardVerifiedArchive(verified).catch(() => {});
  if (recoveryRoot && !successful)
    await rm(recoveryRoot, { recursive: true, force: true });
  await pool?.end();
  const retain =
    process.argv.includes("--retain-quarantined") &&
    env.CONFIRM_RETAIN_ISOLATED_RESTORE ===
      "KEEP_QUARANTINED_FOR_CURRENT_POLICY" &&
    successful;
  if (created && !retain)
    try {
      run(["dropdb", "-U", "knowledge", database]);
    } catch {
      console.error(`직접 생성한 임시 DB 정리 실패: ${database}`);
      process.exitCode = 1;
    }
}
