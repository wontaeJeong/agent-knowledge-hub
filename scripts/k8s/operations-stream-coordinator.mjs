import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import { MUTATION_GATE } from "./operations-backup.mjs";
import {
  createArchive,
  verifyArchive,
  discardVerifiedArchive,
} from "./operations-stream.mjs";
import { backupReferenceRows } from "./operations-storage-graph.mjs";
export async function coordinatedArchiveBackup({
  pool,
  target,
  contentDirectory,
  key,
  keyId,
  gateConfirmed = false,
  dumpDatabase,
  timeoutMs = 300000,
  maxStagingBytes = 16 * 1024 ** 3,
}) {
  if (!gateConfirmed) throw Error("MUTATION_GATE_NOT_CONFIRMED");
  await target.list();
  const id = randomUUID(),
    name = `knowledge-${id}.akh-backup`,
    partial = join(target.root, `.partial-${id}`),
    db = await pool.connect();
  let locked = false,
    verified;
  try {
    await db.query("SET lock_timeout='30s'");
    await db.query("SELECT pg_advisory_lock($1)", [MUTATION_GATE]);
    locked = true;
    await db.query(
      "INSERT INTO operations_backups(id,target,key_id,status) VALUES($1,$2,$3,'running')",
      [id, target.root, keyId],
    );
    const refs = await backupReferenceRows(db);
    if (refs.length > 100000) throw Error("MANIFEST_REFERENCE_BOUND");
    await createArchive({
      file: partial,
      key,
      keyId,
      contentDirectory,
      refs,
      dumpDatabase,
      timeoutMs,
      maxStagingBytes,
      metadata: {
        backupId: id,
        coordination: "global-advisory-gate",
        database: (await db.query("SELECT current_database() AS name")).rows[0]
          .name,
        systemIdentifier: (
          await db.query(
            "SELECT system_identifier::text AS id FROM pg_control_system()",
          )
        ).rows[0].id,
      },
    });
    verified = await verifyArchive({
      file: partial,
      keys: { [keyId]: key },
      stagingRoot: target.root,
      maxStagingBytes,
    });
    await discardVerifiedArchive(verified);
    verified = null;
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(partial)) hash.update(bytes);
    const checksum = hash.digest("hex");
    await link(partial, target.name(name));
    await unlink(partial);
    const dir = await open(target.root, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    await db.query(
      "UPDATE operations_backups SET status='complete',completed_at=now(),checksum=$2 WHERE id=$1",
      [id, checksum],
    );
    return { id, name, checksum, blobCount: refs.length, version: 3 };
  } catch (e) {
    await unlink(partial).catch(() => {});
    try {
      await db.query(
        "UPDATE operations_backups SET status='failed' WHERE id=$1",
        [id],
      );
    } catch {}
    throw e;
  } finally {
    if (verified) await discardVerifiedArchive(verified).catch(() => {});
    if (locked)
      await db.query("SELECT pg_advisory_unlock($1)", [MUTATION_GATE]);
    db.release();
  }
}
