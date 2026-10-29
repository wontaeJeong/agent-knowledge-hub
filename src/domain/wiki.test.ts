import { describe, it, expect } from "vitest";
import { seed } from "./seed";
import { reduce } from "./engine";
import {
  compileOffline,
  createBatch,
  enqueueBatch,
  decideBatch,
  memory,
  current,
  answerOffline,
  saveAnswer,
  fileAnswer,
  lintWiki,
} from "./wiki";
const fresh = () => structuredClone(seed);
function prepare() {
  const s = fresh();
  s.sources.find((x) => x.id === "src-python")!.content =
    "## 지식: Requests 환경\nREQUESTS_CA_BUNDLE 경로를 지정합니다.\n- 사실: ca-bundle | Debian12 | 필요\n\n## 지식: TLS 검증\nTLS 검증을 유지합니다.";
  return s;
}
function proposed() {
  const s = prepare();
  return enqueueBatch(
    s,
    createBatch(
      s,
      compileOffline(s, ["src-python"]),
      ["src-python"],
      "offline",
    ),
  );
}
function publish() {
  let s = proposed();
  const id = memory(s).batches[0].id;
  s = decideBatch(s, id, "approve");
  return decideBatch(s, id, "publish");
}
describe("persistent wiki compile/query/lint", () => {
  it("rechecks cited pages when publishing a filed answer", () => {
    let s = publish();
    const a = answerOffline(s, "REQUESTS_CA_BUNDLE");
    s = fileAnswer(saveAnswer(s, a), a.id);
    const b = memory(s).batches[0];
    s = decideBatch(s, b.id, "approve");
    const p = s.pages.find(p => p.id === a.citations[0].pageId)!;
    s = reduce(s, {type:"SAVE_PAGE",id:p.id,baseVersion:current(p).number,content:"changed citation"});
    const result = decideBatch(s, b.id, "publish");
    expect(memory(result).batches[0].status).toBe("conflict");
    expect(result.pages.some(p => p.id.startsWith("answer-"))).toBe(false);
  });
  it("binds approval to the exact draft contents", () => {
    let s = proposed();
    const id = memory(s).batches[0].id;
    s = decideBatch(s, id, "approve");
    memory(s).batches[0].updates[0].content += " unapproved edit";
    const result = decideBatch(s, id, "publish");
    expect(memory(result).batches[0].status).toBe("conflict");
    expect(result.pages).toHaveLength(5);
  });
  it("creates topic and two linked concept drafts without mutating raw or published pages", () => {
    const s = prepare(),
      raw = JSON.stringify(s.sources),
      d = compileOffline(s, ["src-python"]);
    expect(d).toHaveLength(3);
    expect(d.find((x) => x.id === "container-ca")?.links).toHaveLength(2);
    expect(JSON.stringify(s.sources)).toBe(raw);
    expect(current(s.pages[0]).number).toBe(1);
  });
  it("requires approval and publishes all dependent pages once", () => {
    let s = proposed();
    const id = memory(s).batches[0].id;
    expect(() => decideBatch(s, id, "publish")).toThrow(/승인/);
    s = decideBatch(s, id, "approve");
    expect(s.pages).toHaveLength(5);
    s = decideBatch(s, id, "publish");
    expect(s.pages).toHaveLength(7);
    expect(current(s.pages.find((x) => x.id === "container-ca")!).number).toBe(
      2,
    );
    expect(decideBatch(s, id, "publish")).toEqual(s);
  });
  it("blocks the entire batch if one base page changes", () => {
    let s = proposed();
    const id = memory(s).batches[0].id;
    s = decideBatch(s, id, "approve");
    s = reduce(s, {
      type: "SAVE_PAGE",
      id: "container-ca",
      baseVersion: 1,
      content: "manual",
    });
    const result = decideBatch(s, id, "publish");
    expect(result.pages).toHaveLength(5);
    expect(memory(result).batches[0].status).toBe("conflict");
  });
  it("detects changed source snapshots before publication", () => {
    let s = proposed();
    const id = memory(s).batches[0].id;
    s = decideBatch(s, id, "approve");
    s.sources.find((x) => x.id === "src-python")!.content += " changed";
    expect(memory(decideBatch(s, id, "publish")).batches[0].status).toBe(
      "conflict",
    );
  });
  it("rejects scope promotion and forged source quotes", () => {
    const s = prepare();
    s.sources.find((x) => x.id === "src-python")!.scope = "team";
    expect(() => compileOffline(s, ["src-python"])).toThrow(/범위/);
    const t = prepare(),
      d = compileOffline(t, ["src-python"]);
    d[0].facts[0].quote = "fabricated";
    expect(() => createBatch(t, d, ["src-python"], "offline")).toThrow(/인용/);
  });
  it("rejects invalid link targets and duplicate active batches", () => {
    const s = prepare(),
      d = compileOffline(s, ["src-python"]);
    d[0].links.push("absent");
    expect(() => createBatch(s, d, ["src-python"], "offline")).toThrow(/연결/);
    const t = proposed();
    expect(() => enqueueBatch(t, memory(t).batches[0])).toThrow(/대기/);
  });
  it("supports raw-preserving re-ingest without duplicating source sections", () => {
    const s = publish(),
      d = compileOffline(s, ["src-python"]);
    const concept = d.find((x) => x.title === "Requests 환경")!;
    expect(concept.content.split("<!-- source:src-python -->")).toHaveLength(2);
    expect(concept.baseVersion).toBe(1);
  });
  it("answers from exact published citations and files back through review", () => {
    let s = publish();
    const a = answerOffline(s, "REQUESTS_CA_BUNDLE");
    expect(a.citations.length).toBeGreaterThan(0);
    s = saveAnswer(s, a);
    s = fileAnswer(s, a.id);
    const b = memory(s).batches[0];
    expect(b.answerId).toBe(a.id);
    expect(s.pages.some((p) => p.id.startsWith("answer-"))).toBe(false);
    s = decideBatch(s, b.id, "approve");
    s = decideBatch(s, b.id, "publish");
    expect(s.pages.some((p) => p.id.startsWith("answer-"))).toBe(true);
    expect(() => fileAnswer(s, a.id)).toThrow(/이미/);
  });
  it("reports insufficient evidence and refuses to file it", () => {
    let s = publish();
    const a = answerOffline(s, "양자컴퓨터 냉각 비용");
    expect(a.insufficient).toBe(true);
    s = saveAnswer(s, a);
    expect(() => fileAnswer(s, a.id)).toThrow(/근거/);
  });
  it("does not accept hallucinated answer citations", () => {
    const s = publish(),
      a = answerOffline(s, "REQUESTS_CA_BUNDLE");
    a.citations[0].quote = "fake assertion";
    expect(() => saveAnswer(s, a)).toThrow(/인용/);
  });
  it("requires fresh cited versions when filing an answer", () => {
    let s = publish();
    const a = answerOffline(s, "REQUESTS_CA_BUNDLE");
    s = saveAnswer(s, a);
    const p = s.pages.find((p) => p.id === a.citations[0].pageId)!;
    s = reduce(s, {
      type: "SAVE_PAGE",
      id: p.id,
      baseVersion: current(p).number,
      content: "new",
    });
    expect(() => fileAnswer(s, a.id)).toThrow(/변경/);
  });
  it("keeps private and team pages outside reader retrieval", () => {
    const s = publish();
    s.role = "reader";
    expect(
      answerOffline(s, "장기 실행 작업자").citations.every(
        (c) => s.pages.find((p) => p.id === c.pageId)!.scope === "company",
      ),
    ).toBe(true);
    expect(() => compileOffline(s, ["src-python"])).toThrow(/독자/);
  });
  it("finds real broken links and missing validation dates", () => {
    const s = publish();
    s.pages[0].links = ["absent"];
    const issues = lintWiki(s);
    expect(issues.some((i) => i.kind === "broken-link")).toBe(true);
    expect(issues.some((i) => i.kind === "stale")).toBe(true);
    expect(issues.some((i) => i.kind === "missing-evidence")).toBe(true);
  });
  it("flags structured contradictions only for matching conditions", () => {
    const s = publish(),
      p = s.pages.find((p) => p.facts?.length)!;
    p.facts!.push({ ...p.facts![0], value: "불필요" });
    expect(lintWiki(s).some((i) => i.kind === "contradiction")).toBe(true);
    p.facts![1].context = "Alpine";
    expect(lintWiki(s).some((i) => i.kind === "contradiction")).toBe(false);
  });
});
