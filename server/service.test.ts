import { afterEach, beforeEach, expect, test } from "vitest";
import { KnowledgeService } from "./service";
import { fixture, source } from "./test-support";

let f: Awaited<ReturnType<typeof fixture>>;
let service: KnowledgeService;
beforeEach(async () => { f = await fixture(); service = new KnowledgeService(f.pool); });
afterEach(async () => { await f?.pool.end(); });

test("source registration preserves originals and refuses duplicate identity", async () => {
  const next = { ...source, id: "next" };
  await service.registerSource(f.editor, next, ["editor", "reviewer"]);
  await expect(service.registerSource(f.editor, { ...next, content: "overwrite" }, ["editor"])).rejects.toThrow("ALREADY_EXISTS");
  expect((await f.pool.query("SELECT data FROM sources WHERE workspace_id=$1 AND id='next'", [f.workspaceId])).rows[0].data.content).toBe(source.content);
});

test("readers cannot register sources and unknown identities cannot read", async () => {
  await expect(service.registerSource(f.reader, source, ["reader"])).rejects.toThrow("FORBIDDEN");
  await expect(service.readPage({ ...f.ctx, principalId: "unknown" }, "topic")).rejects.toThrow("NOT_FOUND");
  await expect(service.readPage({ ...f.ctx, workspaceId: "other" }, "topic")).rejects.toThrow("NOT_FOUND");
});

test("historical reads check current page and underlying source permission", async () => {
  expect(await service.readPage(f.reader, "topic", 1)).toMatchObject({ id: "topic", version: { number: 1, content: "기존 내용" } });
  await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'", [f.workspaceId]);
  await expect(service.readPage(f.reader, "topic", 1)).rejects.toThrow("NOT_FOUND");
  await expect(service.readPage(f.reader, "missing")).rejects.toThrow("NOT_FOUND");
});

test("source readers must be nonempty known workspace members including the caller", async () => {
  for (const readers of [[], ["unknown"], ["reader"]]) {
    await expect(service.registerSource(f.editor, { ...source, id: "new" }, readers)).rejects.toThrow("VALIDATION_FAILED");
  }
});
