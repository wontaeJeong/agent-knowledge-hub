import { expect, test, vi } from "vitest";
import { organizeRecords } from "./organizer";
import { parseImport, hash } from "./parser";
import { defaultSelection } from "../../src/domain/imports";

async function records() {
  const bytes = Buffer.from(
    "[2026-10-19 09:00] A: TTL 300초로 하자는 제안입니다\n[2026-10-20 10:00] B: 아직 운영은 60초입니다",
  );
  return (
    await parseImport(
      [{ id: "f", name: "chat.txt", bytes, sha256: hash(bytes) }],
      defaultSelection,
    )
  ).records;
}
const candidate = (rs: Awaited<ReturnType<typeof records>>) => ({
  topics: [
    {
      key: "redis",
      title: "TTL",
      summary: "환경별 검토",
      content: "# TTL\n아직 운영은 60초입니다. 300초는 제안입니다.",
      targetPageId: null,
      relatedPageIds: [],
      statements: rs.map((r) => ({
        kind: "statement",
        text: r.text,
        context: "작성자 진술 · 실행 검증 아님",
        recordId: r.id,
        quote: r.text,
      })),
    },
  ],
  excluded: [],
});
test("semantic organization preserves evidence/coverage and leaves publication to a separate service", async () => {
  const rs = await records(),
    check = vi.fn(async () => {}),
    checkpoint = vi.fn(async () => {});
  const result = await organizeRecords(
    rs,
    [],
    async (op) => {
      expect(op).toBe("organize");
      return candidate(rs);
    },
    "model",
    check,
    checkpoint,
  );
  expect(result.coverage).toEqual({ selected: 2, processed: 2 });
  expect(result.topics).toHaveLength(1);
  expect(result.calls).toBe(1);
  expect(check).toHaveBeenCalledTimes(2);
});
test("missing coverage, invented source/quote/page and duplicate target pages are rejected", async () => {
  const rs = await records();
  for (const mutate of [
    (v: any) => v.topics[0].statements.pop(),
    (v: any) => (v.topics[0].statements[0].quote = "not in source"),
    (v: any) => (v.topics[0].targetPageId = "hidden"),
    (v: any) => v.excluded.push({ recordId: "invented", reason: "noise" }),
  ]) {
    const output = candidate(rs);
    mutate(output);
    await expect(
      organizeRecords(
        rs,
        [],
        async () => output,
        "model",
        async () => {},
        async () => {},
      ),
    ).rejects.toThrow();
  }
});
test("provider errors never masquerade as offline success and final authorization runs after model", async () => {
  const rs = await records();
  await expect(
    organizeRecords(
      rs,
      [],
      async () => {
        throw Error("MODEL_FAILED");
      },
      "model",
      async () => {},
      async () => {},
    ),
  ).rejects.toThrow("MODEL_FAILED");
  let n = 0;
  await expect(
    organizeRecords(
      rs,
      [],
      async () => candidate(rs),
      "model",
      async () => {
        if (++n === 2) throw Error("AUTHORIZATION_REQUIRED");
      },
      async () => {},
    ),
  ).rejects.toThrow("AUTHORIZATION_REQUIRED");
});
test("offline mode is explicitly structural and makes no model calls", async () => {
  const model = vi.fn();
  const rs = await records(),
    result = await organizeRecords(
      rs,
      [],
      model,
      "offline",
      async () => {},
      async () => {},
    );
  expect(model).not.toHaveBeenCalled();
  expect(result.topics).toEqual([]);
  expect(result.excluded).toHaveLength(2);
  expect(result.mode).toBe("offline");
});
test("budget exhaustion happens before spending on incomplete input", async () => {
  const model = vi.fn();
  await expect(
    organizeRecords(
      await records(),
      [],
      model,
      "model",
      async () => {},
      async () => {},
      0,
    ),
  ).rejects.toThrow("BUDGET_EXCEEDED");
  expect(model).not.toHaveBeenCalled();
});
