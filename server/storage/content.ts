import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, unlink, link, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
export const MAX_BYTES = 5 * 1024 * 1024;
export const sha256 = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
export async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("STORAGE_TIMEOUT")), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function bounded(
  input: AsyncIterable<Uint8Array>,
  max = MAX_BYTES,
  timeoutMs = 30000,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  const iterator = input[Symbol.asyncIterator](),
    until = Date.now() + timeoutMs;
  let complete = false;
  try {
    for (;;) {
      const remaining = until - Date.now();
      if (remaining <= 0) throw Error("STORAGE_TIMEOUT");
      const result = await deadline(iterator.next(), remaining);
      if (result.done) {
        complete = true;
        break;
      }
      const part = result.value;
      size += part.byteLength;
      if (size > max) throw Error("PAYLOAD_TOO_LARGE");
      parts.push(Buffer.from(part));
    }
    if (!size) throw Error("EMPTY_CONTENT");
    return Buffer.concat(parts, size);
  } catch (error) {
    if (error instanceof Error && error.message === "STORAGE_TIMEOUT") {
      const stream = input as AsyncIterable<Uint8Array> & {
        destroy?: () => void;
      };
      stream.destroy?.();
    }
    throw error;
  } finally {
    if (!complete) void iterator.return?.().catch(() => {});
  }
}
export function inspectContent(bytes: Buffer, mime: string, filename: string) {
  if (
    !filename ||
    filename.length > 200 ||
    /[\\/\x00-\x1f\x7f]/.test(filename) ||
    filename === "." ||
    filename === ".."
  )
    throw Error("INVALID_FILENAME");
  if (!bytes.length || bytes.length > MAX_BYTES)
    throw Error("PAYLOAD_TOO_LARGE");
  if (mime === "application/pdf") {
    if (
      !filename.toLowerCase().endsWith(".pdf") ||
      !bytes
        .subarray(0, 8)
        .toString()
        .match(/^%PDF-1\.[0-7]|^%PDF-2\.0/) ||
      !bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
    )
      throw Error("MIME_MISMATCH");
    return {
      scanState: "pending" as const,
      extraction: "unsupported" as const,
    };
  }
  if (!["text/plain", "text/markdown", "application/json"].includes(mime))
    throw Error("UNSUPPORTED_MEDIA_TYPE");
  if (
    !{
      "text/plain": /\.txt$/i,
      "text/markdown": /\.md$/i,
      "application/json": /\.json$/i,
    }[mime]!.test(filename)
  )
    throw Error("MIME_MISMATCH");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Error("INVALID_UTF8");
  }
  if (
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ||
    /<\/?[a-z!][^>]*>/i.test(text) ||
    text.startsWith("%PDF-") ||
    text.startsWith("PK\x03\x04")
  )
    throw Error("UNSAFE_CONTENT");
  if (mime === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      throw Error("INVALID_JSON");
    }
  }
  return { scanState: "clean" as const, extraction: "text" as const, text };
}
/** Root must be an application-owned PVC mount. No caller-supplied paths are accepted. */
export class FileBlobStore {
  readonly root: string;
  constructor(root: string) {
    if (!root) throw Error("STORAGE_NOT_CONFIGURED");
    this.root = resolve(root);
  }
  async prepareRoot() {
    await this.ready();
  }
  private async ready() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (
      (await lstat(this.root)).isSymbolicLink() ||
      (await realpath(this.root)) !== this.root
    )
      throw Error("UNSAFE_STORAGE_ROOT");
  }
  async put(input: AsyncIterable<Uint8Array>) {
    // Buffering is deliberately bounded to 5MiB. No unbounded body parser or temp file.
    const bytes = await bounded(input);
    const hash = sha256(bytes);
    await this.ready();
    const temp = join(this.root, `.${randomUUID()}`);
    const handle = await open(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temp, join(this.root, hash));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const directory = await open(
        this.root,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temp);
    }
    // Existing deduplicated content must also pass integrity verification.
    await this.get(hash);
    return { sha256: hash, size: bytes.length };
  }
  async get(hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("INVALID_HASH");
    await this.ready();
    const handle = await open(
      join(this.root, hash),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES)
        throw Error("BLOB_CORRUPT");
      const bytes = await bounded(
        handle.createReadStream({ autoClose: false }),
      );
      if (sha256(bytes) !== hash) throw Error("BLOB_CORRUPT");
      return bytes;
    } finally {
      await handle.close();
    }
  }
}
