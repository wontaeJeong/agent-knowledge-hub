import { createHash } from "node:crypto";
import { extname } from "node:path";
import { parse as csvParse } from "csv-parse/sync";
import * as yauzl from "yauzl";
import type {
  ImportRecord,
  ImportSelection,
  ParsedImport,
  ImportWarning,
} from "../../src/domain/imports";

export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const MAX_FILE = 25 * 1024 * 1024;
export const MAX_RECORDS = 20_000;
export interface ParserFile {
  id: string;
  name: string;
  bytes: Buffer;
  sha256: string;
}
type Entry = { name: string; bytes: Buffer };
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc = (bytes: Buffer) => {
  let n = 0xffffffff;
  for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
};
export async function zipEntries(bytes: Buffer): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(Error("INVALID_ARCHIVE"));
        const result: Entry[] = [];
        let count = 0,
          total = 0,
          ended = false;
        const fail = (code: string) => {
          if (!ended) {
            ended = true;
            zip.close();
            reject(Error(code));
          }
        };
        zip.on("error", () => fail("INVALID_ARCHIVE"));
        zip.on("end", () => {
          if (!ended) {
            ended = true;
            resolve(result);
          }
        });
        zip.on("entry", (entry: yauzl.Entry) => {
          const symlink =
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;
          if (
            ++count > 2000 ||
            entry.uncompressedSize > MAX_FILE ||
            total + entry.uncompressedSize > 200 * 1024 * 1024
          )
            return fail("ARCHIVE_LIMIT");
          if (
            symlink ||
            entry.generalPurposeBitFlag & 1 ||
            /(^|\/)\.\.(\/|$)|\\|^\/|^[a-z]:/i.test(entry.fileName)
          )
            return fail("UNSAFE_ARCHIVE");
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (
            /\.(zip|gz|tar|7z|rar|exe|dll|sh|bat|ps1|html?|svg)$/i.test(
              entry.fileName,
            )
          )
            return fail("UNSAFE_ARCHIVE");
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) return fail("INVALID_ARCHIVE");
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              total += chunk.length;
              if (size > MAX_FILE || total > 200 * 1024 * 1024) {
                stream.destroy();
                fail("ARCHIVE_LIMIT");
              } else chunks.push(chunk);
            });
            stream.on("error", () => fail("INVALID_ARCHIVE"));
            stream.on("end", () => {
              if (ended) return;
              const data = Buffer.concat(chunks);
              if (
                data.length !== entry.uncompressedSize ||
                crc(data) !== entry.crc32
              )
                return fail("INVALID_ARCHIVE");
              result.push({ name: entry.fileName, bytes: data });
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
function decode(bytes: Buffer, encoding: ImportSelection["encoding"]): string {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw Error();
    return text;
  } catch {
    throw Error("ENCODING_REQUIRED");
  }
}
function timestamp(
  raw: string,
  zone: ImportSelection["timezone"],
): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (/^\d{10}\.\d+$/.test(value)) {
    const [seconds, fraction] = value.split(".");
    return new Date(
      Number(seconds) * 1000 + Number((fraction + "000").slice(0, 3)),
    ).toISOString();
  }
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(value)) {
    if (zone === "unknown") return null;
    value = value.replace(" ", "T") + (zone === "Asia/Seoul" ? "+09:00" : "Z");
  }
  const n = Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export async function parseImport(
  files: ParserFile[],
  selection: ImportSelection,
): Promise<ParsedImport> {
  const all: ImportRecord[] = [],
    warnings: ImportWarning[] = [],
    formats = new Set<string>();
  const add = (
    file: ParserFile,
    entry: string,
    location: string,
    value: {
      id?: string;
      conversation?: string;
      author?: string;
      text: string;
      time?: string;
      thread?: string;
      event?: ImportRecord["event"];
    },
  ) => {
    if (all.length >= MAX_RECORDS || value.text.length > 65_536)
      throw Error("RECORD_LIMIT");
    if (
      (value.id?.length || 0) > 1000 ||
      (value.conversation?.length || 0) > 1000 ||
      (value.author?.length || 0) > 1000 ||
      (value.time?.length || 0) > 100
    )
      throw Error("RECORD_LIMIT");
    if (!value.text.trim() && value.event !== "deleted") return;
    const conversationId = value.conversation || entry || file.name;
    const externalId = value.id || `${file.sha256}:${entry}:${location}`;
    const sourceKey = hash(
      JSON.stringify([
        selection.namespace || file.sha256,
        conversationId,
        externalId,
      ]),
    );
    const contentHash = hash(
      JSON.stringify([value.text, value.event || "message", value.time || ""]),
    );
    all.push({
      id: "r-" + hash(sourceKey + contentHash).slice(0, 48),
      externalId,
      conversationId,
      author: value.author || "알 수 없음",
      text: value.text,
      occurredAt: timestamp(value.time || "", selection.timezone),
      occurredRaw: value.time || "",
      threadId: value.thread || null,
      event: value.event || "message",
      identityVerified: false,
      sourceKey,
      contentHash,
      anchor: {
        fileId: file.id,
        fileName: file.name,
        entry,
        location,
        sha256: file.sha256,
      },
    });
  };
  for (const file of files) {
    if (file.bytes.length > MAX_FILE || hash(file.bytes) !== file.sha256)
      throw Error("INPUT_CHANGED");
    const entries =
      extname(file.name).toLowerCase() === ".zip"
        ? await zipEntries(file.bytes)
        : [{ name: file.name, bytes: file.bytes }];
    for (const entry of entries) {
      const ext = extname(entry.name).toLowerCase();
      if (/\/(?:__MACOSX)\/|^__MACOSX\/|(?:^|\/)\.DS_Store$/.test(entry.name))
        continue;
      if (
        /(?:^|\/)(users|org_users|channels|groups|dms|mpims|integration_logs)\.json$/.test(
          entry.name,
        )
      ) {
        warnings.push({
          code: "METADATA_NOT_IDENTITY",
          detail: `${entry.name}: 내보내기 메타데이터는 인증 신원이나 ACL이 아닙니다.`,
        });
        continue;
      }
      if (
        ![".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ""].includes(
          ext,
        )
      ) {
        warnings.push({
          code: "ATTACHMENT_NOT_IMPORTED",
          detail: `${entry.name}: 지원하지 않는 첨부 본문은 포함하지 않았습니다.`,
        });
        continue;
      }
      const text = decode(entry.bytes, selection.encoding);
      const format =
        selection.format === "auto"
          ? [".json", ".jsonl"].includes(ext)
            ? "json"
            : ext === ".csv"
              ? "csv"
              : "text"
          : selection.format;
      formats.add(format);
      if (format === "json") {
        let data: unknown;
        try {
          data =
            ext === ".jsonl"
              ? text
                  .split(/\r?\n/)
                  .filter((x) => x.trim())
                  .map((x) => JSON.parse(x))
              : JSON.parse(text);
        } catch {
          throw Error("INVALID_JSON");
        }
        const normalized =
          data &&
          !Array.isArray(data) &&
          typeof data === "object" &&
          (data as { schemaVersion?: unknown }).schemaVersion === 1;
        const rows = normalized
          ? (data as { records?: unknown }).records
          : data;
        if (!Array.isArray(rows)) throw Error("UNSUPPORTED_FORMAT");
        for (const [i, row] of rows.entries()) {
          if (!row || typeof row !== "object")
            throw Error("UNSUPPORTED_FORMAT");
          const r = row as Record<string, unknown>;
          const edited =
            r.subtype === "message_changed" &&
            r.message &&
            typeof r.message === "object"
              ? (r.message as Record<string, unknown>)
              : r;
          if (
            !normalized &&
            typeof edited.ts !== "string" &&
            r.subtype !== "message_deleted"
          )
            throw Error("UNSUPPORTED_FORMAT");
          const body = normalized ? r.text : edited.text;
          const deleted =
            r.subtype === "message_deleted" || r.event === "deleted";
          if (typeof body !== "string" && !deleted) {
            warnings.push({
              code: "NON_TEXT_EVENT",
              detail: `${entry.name} #${i}: 본문 없는 이벤트`,
            });
            continue;
          }
          const string = (v: unknown) =>
            typeof v === "string" ? v : undefined;
          add(file, entry.name, normalized ? `/records/${i}` : `/${i}`, {
            id: string(normalized ? r.id : deleted ? r.deleted_ts : edited.ts),
            conversation:
              string(r.conversationId) ||
              entry.name.replace(/\/[^/]+\.json$/, ""),
            author:
              string(normalized ? r.author : edited.user) ||
              string(edited.bot_id),
            text: deleted ? "" : (body as string),
            time: string(normalized ? r.timestamp : edited.ts),
            thread: string(normalized ? r.threadId : edited.thread_ts),
            event: deleted
              ? "deleted"
              : r.subtype === "message_changed" || r.event === "edited"
                ? "edited"
                : "message",
          });
          if (Array.isArray(edited.files) && edited.files.length)
            warnings.push({
              code: "ATTACHMENT_NOT_IMPORTED",
              detail: `${entry.name} #${i}: 첨부 링크는 본문 증거가 아닙니다.`,
            });
          if (typeof edited.reply_count === "number" && edited.reply_count > 0)
            warnings.push({
              code: "THREAD_COMPLETENESS_UNKNOWN",
              detail: `${entry.name} #${i}: 답글 전체가 포함됐는지 확인하세요.`,
            });
        }
      } else if (format === "csv") {
        let rows: { record: Record<string, string>; info: { lines: number } }[];
        try {
          rows = csvParse(text, {
            columns: (names: string[]) => {
              if (
                new Set(names).size !== names.length ||
                names.some((n) => !n.trim())
              )
                throw Error("INVALID_CSV");
              return names;
            },
            bom: true,
            skip_empty_lines: true,
            info: true,
            max_record_size: 65_536,
          });
        } catch {
          throw Error("INVALID_CSV");
        }
        if (rows.length && !(selection.csv.text in rows[0].record))
          throw Error("CSV_MAPPING_REQUIRED");
        for (const { record: r, info } of rows)
          add(file, entry.name, `line:${info.lines}`, {
            id: r[selection.csv.id],
            text: r[selection.csv.text] || "",
            author: r[selection.csv.author],
            time: r[selection.csv.time],
            conversation: r[selection.csv.conversation],
          });
      } else {
        const lines = text.split(/\r?\n/);
        let day = "",
          pending: {
            line: number;
            id?: string;
            author: string;
            text: string;
            time: string;
          } | null = null;
        const flush = () => {
          if (pending) add(file, entry.name, `line:${pending.line}`, pending);
          pending = null;
        };
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const date = line.match(
            /^-+\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/,
          );
          if (date) {
            flush();
            day = `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`;
            continue;
          }
          const kakao = line.match(
            /^\[([^\]]+)\] \[(오전|오후) (\d{1,2}):(\d{2})\] (.*)$/,
          );
          const mobile = line.match(
            /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s*(.+?)\s*:\s*(.*)$/,
          );
          const iso = line.match(
            /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+([^:]+):\s*(.*)$/,
          );
          if (kakao || mobile || iso) {
            flush();
            formats.add("conversation-text");
            if (iso)
              pending = {
                line: i + 1,
                author: iso[2],
                time: iso[1],
                text: iso[3],
              };
            else {
              const m = mobile;
              if (m)
                day = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
              const period = m ? m[4] : kakao![2],
                hour =
                  (Number(m ? m[5] : kakao![3]) % 12) +
                  (period === "오후" ? 12 : 0);
              const minute = m ? m[6] : kakao![4];
              pending = {
                line: i + 1,
                author: m ? m[7] : kakao![1],
                time: day
                  ? `${day}T${String(hour).padStart(2, "0")}:${minute}:00`
                  : "",
                text: m ? m[8] : kakao![5],
              };
            }
          } else if (pending && pending.text.length + line.length < 60_000)
            pending.text += "\n" + line;
          else {
            flush();
            if (line.trim())
              pending = {
                line: i + 1,
                author: "알 수 없음",
                time: "",
                text: line,
              };
          }
        }
        flush();
      }
    }
  }
  const unique = new Map<string, ImportRecord>();
  let duplicates = 0,
    excluded = 0;
  const excludedIds = new Set(selection.excludedIds);
  for (const record of all) {
    const date =
      record.occurredRaw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ||
      (record.occurredAt && selection.timezone !== "unknown"
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: selection.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(record.occurredAt))
        : undefined);
    if (
      excludedIds.has(record.id) ||
      (selection.from && date && date < selection.from) ||
      (selection.to && date && date > selection.to)
    ) {
      excluded++;
      continue;
    }
    if ((selection.from || selection.to) && !date)
      warnings.push({
        code: "UNKNOWN_DATE",
        detail: "날짜를 확인할 수 없어 기간 밖인지 판정하지 못한 레코드입니다.",
        recordId: record.id,
      });
    if (unique.has(record.id)) duplicates++;
    else unique.set(record.id, record);
  }
  const records = [...unique.values()];
  const externalIds = new Set(
    records.map((r) => `${r.conversationId}\0${r.externalId}`),
  );
  for (const r of records)
    if (
      r.threadId &&
      r.threadId !== r.externalId &&
      !externalIds.has(`${r.conversationId}\0${r.threadId}`)
    )
      warnings.push({
        code: "MISSING_PARENT",
        detail: "스레드 부모 발언이 입력 범위에 없습니다.",
        recordId: r.id,
      });
  if (records.some((r) => r.occurredRaw && !r.occurredAt))
    warnings.push({
      code: "TIMEZONE_UNKNOWN",
      detail:
        "원본 타임존/시간을 확인하기 전 절대 시각과 상대 날짜를 확정하지 않습니다.",
    });
  if (!selection.namespace)
    warnings.push({
      code: "SOURCE_NAMESPACE_UNVERIFIED",
      detail:
        "원본 ID가 없어 파일 간 중복/삭제/현재 ACL을 자동 확정하지 않습니다.",
    });
  if (!records.length) throw Error("NO_RECORDS");
  return {
    records,
    warnings: warnings.slice(0, 500),
    formats: [...formats],
    counts: {
      total: all.length,
      selected: records.length,
      excluded,
      duplicates,
      deleted: records.filter((r) => r.event === "deleted").length,
    },
  };
}
