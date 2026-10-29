import { mkdir, open, readFile, rename, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// One writer per directory. A killed host never makes an old snapshot authoritative.
export async function openStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid;
    try {
      pid = JSON.parse(await readFile(path.join(lock, "owner"), "utf8")).pid;
    } catch {
      throw Error("WORKSPACE_LOCKED");
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("WORKSPACE_LOCKED");
    try {
      process.kill(pid, 0);
      throw Error("WORKSPACE_LOCKED");
    } catch (e) {
      if (e.code !== "ESRCH") throw Error("WORKSPACE_LOCKED");
    }
    try {
      await unlink(path.join(lock, "owner"));
      await rmdir(lock);
      await mkdir(lock);
    } catch {
      throw Error("WORKSPACE_LOCKED");
    }
  }
  await (await open(path.join(lock, "owner"), "wx", 0o600)).close();
  const owner = await open(path.join(lock, "owner"), "w", 0o600);
  await owner.writeFile(JSON.stringify({ pid: process.pid }));
  await owner.close();
  const file = path.join(directory, "state.json");
  let closed = false;
  return {
    async read() {
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw Error("CORRUPT_STATE");
      }
    },
    async write(value) {
      if (closed) throw Error("STORE_CLOSED");
      const temp = path.join(directory, `.write-${randomUUID()}`);
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temp, file);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await unlink(path.join(lock, "owner"));
      await rmdir(lock);
    },
  };
}
