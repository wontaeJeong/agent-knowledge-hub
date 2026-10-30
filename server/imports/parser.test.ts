import { expect, test } from "vitest";
import { parseImport, zipEntries, hash, type ParserFile } from "./parser";
import { defaultSelection } from "../../src/domain/imports";

const file = (text: string, name = "input.txt"): ParserFile => {
  const bytes = Buffer.from(text);
  return { id: "f", name, bytes, sha256: hash(bytes) };
};
const zip =
  "UEsDBBQAAAAIAJ1eXl0oTAqHPQAAAEUAAAAUAAAAY2hhdC8yMDI2LTEwLTIwLmpzb26LrlYqKVayUlAyNLc0MjG1MDAw0DMAAUMlHQWl0uLUIpBkKJhXklpRAuKFhPgomBm82dKh8GH+jAal2lgAUEsBAhQDFAAAAAgAnV5eXShMCoc9AAAARQAAABQAAAAAAAAAAAAAAIABAAAAAGNoYXQvMjAyNi0xMC0yMC5qc29uUEsFBgAAAAABAAEAQgAAAG8AAAAAAA==";
test("Korean chat preserves multiline/emoji and distinguishes unknown timezone from explicit Seoul", async () => {
  const source = file(
    "--------------- 2026년 10월 19일 월요일 ---------------\n[민수] [오전 9:00] TTL은 60초 😀\n운영 환경만 해당\n[지영] [오후 1:02] 300초는 제안입니다",
  );
  const result = await parseImport([source], defaultSelection);
  expect(result.records).toHaveLength(2);
  expect(result.records[0].text).toContain("😀\n운영");
  expect(result.records[0].occurredAt).toBeNull();
  expect(result.records[0].identityVerified).toBe(false);
  expect(result.records[0].anchor.location).toBe("line:2");
  const seoul = await parseImport([source], {
    ...defaultSelection,
    timezone: "Asia/Seoul",
  });
  expect(seoul.records[0].occurredAt).toBe("2026-10-19T00:00:00.000Z");
  expect(seoul.records[1].occurredAt).toBe("2026-10-19T04:02:00.000Z");
});
test("normalized JSON preserves message IDs, thread gaps, edits and explicit tombstones", async () => {
  const source = file(
    JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          id: "m2",
          conversationId: "c",
          author: "동명이인",
          text: "제안",
          timestamp: "2026-10-20T10:00:00+09:00",
          threadId: "m1",
        },
        { id: "m3", conversationId: "c", text: "정정", event: "edited" },
        { id: "m4", conversationId: "c", event: "deleted" },
      ],
    }),
    "chat.json",
  );
  const result = await parseImport([source], defaultSelection);
  expect(result.records.map((r) => r.event)).toEqual([
    "message",
    "edited",
    "deleted",
  ]);
  expect(result.warnings.some((w) => w.code === "MISSING_PARENT")).toBe(true);
  expect(result.counts.deleted).toBe(1);
});
test("Slack exports retain microsecond IDs without numeric rounding and never fetch attachment links", async () => {
  const source = file(
    JSON.stringify([
      {
        ts: "1792458000.000001",
        user: "U1",
        text: "원본",
        files: [{ url_private: "http://127.0.0.1/secret" }],
      },
      {
        subtype: "message_changed",
        message: { ts: "1792458000.000001", user: "U1", text: "수정" },
      },
      {
        subtype: "message_deleted",
        deleted_ts: "1792458000.000002",
        ts: "1792458001.000001",
      },
    ]),
    "channel/day.json",
  );
  const result = await parseImport([source], {
    ...defaultSelection,
    namespace: "verified-export",
  });
  expect(result.records[0].externalId).toBe("1792458000.000001");
  expect(result.records[0].sourceKey).toBe(result.records[1].sourceKey);
  expect(result.records[0].id).not.toBe(result.records[1].id);
  expect(
    result.warnings.some((w) => w.code === "ATTACHMENT_NOT_IMPORTED"),
  ).toBe(true);
});
test("CSV mapping supports quoted multiline data without coercing identity strings", async () => {
  const result = await parseImport(
    [
      file(
        'msg,who,when,key,room\n"hello\nworld",Alice,2026-10-20T10:00:00Z,00001,c1\n',
        "data.csv",
      ),
    ],
    {
      ...defaultSelection,
      csv: {
        text: "msg",
        author: "who",
        time: "when",
        id: "key",
        conversation: "room",
      },
    },
  );
  expect(result.records[0].text).toBe("hello\nworld");
  expect(result.records[0].externalId).toBe("00001");
  await expect(
    parseImport([file("a,b\nx,y", "data.csv")], defaultSelection),
  ).rejects.toThrow("CSV_MAPPING_REQUIRED");
});
test("ZIP validation reads bounded text entries and rejects CRC corruption and traversal before parsing", async () => {
  const bytes = Buffer.from(zip, "base64"),
    entries = await zipEntries(bytes);
  expect(entries).toHaveLength(1);
  const result = await parseImport(
    [{ id: "zip", name: "export.zip", bytes, sha256: hash(bytes) }],
    defaultSelection,
  );
  expect(result.records[0].text).toContain("TTL 60초 😀");
  const corrupt = Buffer.from(bytes);
  corrupt[14] ^= 1;
  // Central CRC is the authority used by the ZIP library.
  const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  corrupt[central + 16] ^= 1;
  await expect(zipEntries(corrupt)).rejects.toThrow("INVALID_ARCHIVE");
  const bad = Buffer.from(
    bytes
      .toString("latin1")
      .replaceAll("chat/2026-10-20.json", "../x/2026-10-20.json"),
    "latin1",
  );
  await expect(zipEntries(bad)).rejects.toThrow();
});
test("dedup uses stable identity and revision, retaining distinct repeated utterances", async () => {
  const source = file(
    JSON.stringify({
      schemaVersion: 1,
      records: [
        { id: "a", text: "same", conversationId: "c" },
        { id: "a", text: "same", conversationId: "c" },
        { id: "b", text: "same", conversationId: "c" },
      ],
    }),
    "chat.json",
  );
  const result = await parseImport([source], defaultSelection);
  expect(result.records).toHaveLength(2);
  expect(result.counts.duplicates).toBe(1);
  const txt = await parseImport(
    [file("[2026-10-19 10:00] A: same\n[2026-10-19 10:01] A: same")],
    defaultSelection,
  );
  expect(txt.records).toHaveLength(2);
});
test("selection filters known dates and explicit records, never inventing dates for unknown material", async () => {
  const source = file("[2026-10-19 10:00] A: one\n[2026-10-20 10:00] A: two");
  const result = await parseImport([source], {
    ...defaultSelection,
    from: "2026-10-20",
  });
  expect(result.records).toHaveLength(1);
  expect(result.counts.excluded).toBe(1);
  const unknown = await parseImport([file("meeting notes")], {
    ...defaultSelection,
    from: "2026-10-20",
  });
  expect(unknown.warnings.some((w) => w.code === "UNKNOWN_DATE")).toBe(true);
});
test("checksums, undecodable bytes and unsupported arbitrary JSON fail explicitly", async () => {
  await expect(
    parseImport(
      [{ ...file("secret"), sha256: "0".repeat(64) }],
      defaultSelection,
    ),
  ).rejects.toThrow("INPUT_CHANGED");
  const bytes = Buffer.from([0xff, 0xff]);
  await expect(
    parseImport(
      [{ id: "f", name: "x.txt", bytes, sha256: hash(bytes) }],
      defaultSelection,
    ),
  ).rejects.toThrow("ENCODING_REQUIRED");
  await expect(
    parseImport([file('{"unknown":"data"}', "x.json")], defaultSelection),
  ).rejects.toThrow("UNSUPPORTED_FORMAT");
});
