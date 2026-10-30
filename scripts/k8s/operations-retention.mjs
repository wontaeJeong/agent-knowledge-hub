import {
  FileTarget,
  retainBackups,
  rotateBundle,
  openBundle,
} from "./operations-backup.mjs";
import {
  isStreamingArchive,
  verifyTargetArchive,
  rotateTargetArchive,
} from "./operations-stream-retention.mjs";
import pg from "pg";
import { withBackupRetentionPolicy } from "./operations-retention-policy.mjs";
const [command, directory, contentDirectory, name] = process.argv.slice(2);
if (!["retain", "rotate"].includes(command) || !directory || !contentDirectory)
  throw Error(
    "Usage: operations-retention.mjs retain|rotate BACKUP_MOUNT CONTENT_DIRECTORY [BACKUP_NAME]",
  );
const target = new FileTarget(directory, contentDirectory);
try {
  if (command === "retain") {
    if (process.env.CONFIRM_BACKUP_RETENTION !== "DELETE_EXPIRED_KEEP_NEWEST")
      throw Error("CONFIRMATION_REQUIRED");
    const days = Number(process.env.BACKUP_RETENTION_DAYS);
    if (!Number.isInteger(days) || days < 1) throw Error("RETENTION_REQUIRED");
    // Check every candidate is decryptable before discarding old recoverable copies.
    const keys = JSON.parse(process.env.BACKUP_KEYS_JSON ?? "{}");
    for (const row of await target.list())
      if (await isStreamingArchive(target.name(row.name)))
        await verifyTargetArchive(
          target,
          row.name,
          keys,
          Number(process.env.BACKUP_MAX_PLAINTEXT_BYTES ?? 16 * 1024 ** 3),
        );
      else openBundle(await target.get(row.name), keys);
    if (!process.env.DATABASE_URL)
      throw Error("CURRENT_RETENTION_DATABASE_REQUIRED");
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    try {
      const removed = await withBackupRetentionPolicy(pool, days, (d) =>
        retainBackups(target, d),
      );
      console.log(
        `현재 보관 정책·법적 보존 검사 후 만료 백업 삭제: ${removed.length}`,
      );
    } finally {
      await pool.end();
    }
  } else {
    await target.list();
    if (await isStreamingArchive(target.name(name))) {
      const newName = await rotateTargetArchive(
        target,
        name,
        JSON.parse(process.env.BACKUP_KEYS_JSON ?? "{}"),
        process.env.AGENT_KNOWLEDGE_HUB_BACKUP_KEY,
        process.env.BACKUP_NEW_KEY_ID,
        Number(process.env.BACKUP_MAX_PLAINTEXT_BYTES ?? 16 * 1024 ** 3),
      );
      console.log(
        `스트리밍 새 키 재암호화 검증 완료: ${newName}. 기존 키와 사본은 승인 후 별도 폐기하세요.`,
      );
    } else {
      const body = await target.get(name),
        newId = process.env.BACKUP_NEW_KEY_ID;
      const rotated = rotateBundle(
        body,
        JSON.parse(process.env.BACKUP_KEYS_JSON ?? "{}"),
        process.env.AGENT_KNOWLEDGE_HUB_BACKUP_KEY,
        newId,
      );
      const newName = name.replace(".akh-backup", `-key-${newId}.akh-backup`);
      await target.put(newName, rotated);
      openBundle(await target.get(newName), {
        [newId]: process.env.AGENT_KNOWLEDGE_HUB_BACKUP_KEY,
      });
      console.log(
        `새 키 재암호화 검증 완료: ${newName}. 기존 키/사본은 정책 승인 후 별도 폐기하세요.`,
      );
    }
  }
} catch {
  console.error(
    "백업 보관/키 교체 실패; 기존 사본을 자동 폐기하지 않았습니다.",
  );
  process.exitCode = 1;
}
