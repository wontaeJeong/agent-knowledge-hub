import { lstat, realpath, unlink, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
/** Only pass to purgeApprovedBlobs. Never expose this adapter directly as a request handler. */
export class PhysicalDeletionStore {
  readonly root: string;
  constructor(directory: string) {
    if (!directory) throw Error("CONTENT_DIRECTORY_REQUIRED");
    this.root = resolve(directory);
  }
  async remove(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("INVALID_HASH");
    if (
      (await lstat(this.root)).isSymbolicLink() ||
      (await realpath(this.root)) !== this.root
    )
      throw Error("UNSAFE_STORAGE_ROOT");
    const path = join(this.root, hash);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error("UNSAFE_BLOB");
      await unlink(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const dir = await open(
      this.root,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
