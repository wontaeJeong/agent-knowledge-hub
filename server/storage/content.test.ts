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

it("rejects APNG frames and malformed PNG chunk framing before decoding but accepts static raster formats", async () => {
  const { inspectAttachment } = await import("./content");
  const { readFile } = await import("node:fs/promises");
  const sharp = (await import("sharp")).default;
  const animated = await readFile(
    new URL("./fixtures/animated-two-frame.png", import.meta.url),
  );
  await expect(
    inspectAttachment(animated, "image/png", "animated.png"),
  ).rejects.toThrow("INVALID_IMAGE");
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  for (const bytes of [
    png.subarray(0, png.length - 1),
    Buffer.concat([png, Buffer.from("trailing")]),
    Buffer.concat([
      png.subarray(0, 33),
      Buffer.from([255, 255, 255, 255]),
      png.subarray(37),
    ]),
    animated.subarray(0, 50),
    Buffer.concat([animated.subarray(0, 33), animated.subarray(53)]),
  ])
    await expect(
      inspectAttachment(bytes, "image/png", "malformed.png"),
    ).rejects.toThrow("INVALID_IMAGE");
  for (const [format, mime, filename] of [
    ["png", "image/png", "static.png"],
    ["jpeg", "image/jpeg", "static.jpg"],
    ["webp", "image/webp", "static.webp"],
  ] as const) {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    expect(await inspectAttachment(bytes, mime, filename)).toMatchObject({
      scanState: "clean",
      extraction: "image",
      width: 2,
      height: 2,
    });
  }
});

it("checks PNG chunk types rather than rejecting animation names inside inert ancillary data", async () => {
  const { inspectAttachment } = await import("./content");
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const payload = Buffer.from("Comment\0acTL fcTL fdAT");
  const typed = Buffer.concat([Buffer.from("tEXt"), payload]);
  let crc = 0xffffffff;
  for (const byte of typed) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  typed.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  const staticWithComment = Buffer.concat([
    png.subarray(0, -12),
    chunk,
    png.subarray(-12),
  ]);
  expect(
    await inspectAttachment(staticWithComment, "image/png", "comment.png"),
  ).toMatchObject({ scanState: "clean", width: 2, height: 2 });
});
