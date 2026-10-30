import {
  FileTarget,
  retainBackups,
  rotateBundle,
  openBundle,
} from "./operations-backup.mjs";
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
      openBundle(await target.get(row.name), keys);
    console.log(
      `보관 기한이 지난 백업 삭제: ${(await retainBackups(target, days)).length}`,
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
} catch {
  console.error(
    "백업 보관/키 교체 실패; 기존 사본을 자동 폐기하지 않았습니다.",
  );
  process.exitCode = 1;
}
