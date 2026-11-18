import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const requiredSteps = [
  "environment",
  "model provider outage",
  "saved draft reopened",
  "unsent recovery",
  "disclosure approval and knowledge proposal",
  "published",
  "search and favorite revisit",
  "published backlink round-trip",
  "comment and recipient inbox",
  "home and my tasks resume",
  "source withdrawal",
  "expired session and withdrawn identity",
];
export const requiredCleanup = [
  "browser",
  "jobs",
  "app",
  "issuer",
  "model",
  "pool",
  "database",
  "admin",
];

export const images = [
  "390-recovery.png",
  "390-comment.png",
  "390-source-withdrawn.png",
];
export const jsonText = (value) => JSON.stringify(value, null, 2) + "\n";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function cleanResources(tasks) {
  const records = [];
  for (const [resource, close] of tasks) {
    if (!close) continue;
    try {
      await close();
      records.push({ resource, ok: true });
    } catch (error) {
      records.push({
        resource,
        ok: false,
        error: String(error?.message ?? error),
      });
    }
  }
  return records;
}

// Call only after this run successfully CREATEd this exact database. No FORCE.
export async function dropOwnedDatabase(admin, database) {
  assert.match(database, /^akh_c12_test_[a-f0-9]{32}$/);
  try {
    await admin.query('DROP DATABASE "' + database + '"');
    const remains = await admin.query(
      "SELECT datname FROM pg_database WHERE datname=$1",
      [database],
    );
    assert.equal(remains.rowCount, 0);
  } catch (error) {
    throw new Error(database + ": " + error.message, { cause: error });
  }
}

// One immutable directory per successful run. The latest.md rename is the
// only public selection change. Earlier published generations are never edited.
export async function publishRun(stage, root, runId, report) {
  assert.match(runId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(report.exitCode, 0);
  assert.equal(report.ownedDatabaseDropped, true);
  assert.deepEqual(
    report.results.map((entry) => entry.step),
    requiredSteps,
    "Incomplete journey",
  );
  assert.deepEqual(
    report.cleanup.map((entry) => [entry.resource, entry.ok]),
    requiredCleanup.map((resource) => [resource, true]),
    "Incomplete cleanup",
  );
  const hashes = {};
  for (const file of images) {
    const bytes = await readFile(join(stage, file));
    assert(
      bytes.length > 8 &&
        bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    );
    hashes[file] = sha(bytes);
  }
  const metadata = jsonText({ ...report, runId, artifacts: hashes });
  await writeFile(join(stage, "journey.json"), metadata, { flag: "wx" });
  const parent = join(root, "runs");
  await mkdir(parent, { recursive: true });
  const generation = join(parent, runId);
  await mkdir(generation); // Exclusive: a collision is somebody else's directory.
  const pointer = join(generation, "index.tmp");
  try {
    const all = { ...hashes, "journey.json": sha(metadata) };
    for (const [file, expected] of Object.entries(all)) {
      const destination = join(generation, file);
      await copyFile(join(stage, file), destination, constants.COPYFILE_EXCL);
      assert.equal(sha(await readFile(destination)), expected);
    }
    const labels = [
      "미전송 입력 복구",
      "수신자의 댓글 위치",
      "철회 후 접근 안내",
      "실행 결과",
    ];
    const rows = Object.entries(all).map(
      ([file, hash], i) =>
        "| [" +
        labels[i] +
        "](runs/" +
        runId +
        "/" +
        file +
        ") | `" +
        hash +
        "` |",
    );
    await writeFile(
      pointer,
      [
        "# C12 최근 성공 실행",
        "",
        "실행 ID `" + runId + "`",
        "",
        "| 근거 | SHA-256 |",
        "| --- | --- |",
        ...rows,
        "",
      ].join("\n"),
      { flag: "wx" },
    );
    await rm(stage, { recursive: true });
    await rename(pointer, join(root, "latest.md"));
  } catch (error) {
    await rm(generation, { recursive: true });
    throw error;
  }
}
