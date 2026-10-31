import { describe, it, expect } from "vitest";
import { mkdtemp, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlobStore, inspectContent, MAX_BYTES, bounded } from "./content";
describe("persistent bounded content store", () => {
  it("persists SHA256 content across adapter restart", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "akh-storage-")));
    try {
      const saved = await new FileBlobStore(root).put(
        (async function* () {
          yield Buffer.from("한글 원본");
        })(),
      );
      expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await new FileBlobStore(root).get(saved.sha256)).toString()).toBe(
        "한글 원본",
      );
      await expect(new FileBlobStore(root).get("../outside")).rejects.toThrow(
        "INVALID_HASH",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects overflow, HTML, binary camouflage and PDF signature mismatch", async () => {
    expect(() =>
      inspectContent(
        Buffer.from("<script>alert(1)</script>"),
        "text/markdown",
        "a.md",
      ),
    ).toThrow();
    expect(() =>
      inspectContent(Buffer.from([0, 1, 2]), "text/plain", "a.txt"),
    ).toThrow();
    expect(() =>
      inspectContent(
        Buffer.from("%PDF-1.7\n%%EOF"),
        "application/pdf",
        "a.pdf",
      ),
    ).not.toThrow();
    expect(() =>
      inspectContent(Buffer.from("abc"), "application/pdf", "a.pdf"),
    ).toThrow();
    expect(() =>
      inspectContent(Buffer.from("abc"), "text/plain", "../a.txt"),
    ).toThrow();
    const root = await mkdtemp(join(tmpdir(), "akh-storage-"));
    try {
      await expect(
        new FileBlobStore(root).put(
          (async function* () {
            yield Buffer.alloc(MAX_BYTES + 1);
          })(),
        ),
      ).rejects.toThrow("PAYLOAD_TOO_LARGE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses symlink roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "akh-storage-"));
    try {
      await symlink(root, join(root, "link"));
      await expect(
        new FileBlobStore(join(root, "link")).put(
          (async function* () {
            yield Buffer.from("a");
          })(),
        ),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("bounds stalled streams by elapsed time", async () => {
    await expect(
      bounded(
        {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        },
        100,
        10,
      ),
    ).rejects.toThrow("STORAGE_TIMEOUT");
  });
});
