import { afterEach, beforeEach, expect, test } from "vitest";
import { fixture } from "./test-support";
import { KnowledgeService } from "./service";
import { exportUsageCsv } from "./usage";
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{f=await fixture();});
afterEach(async()=>{await f.pool.end();});
test("CSV export requires membership and respects personal vs manager activity",async()=>{
 const service=new KnowledgeService(f.pool);
 await service.readPage(f.reader,"topic");
 await service.readPage(f.editor,"topic");
 const personal=await exportUsageCsv(f.pool,f.reader,14);
 expect(personal).toContain("at_utc,operation,succeeded");
 expect(personal).toContain('"reader"');
 expect(personal).not.toContain('"editor"');
 const manager=await exportUsageCsv(f.pool,f.ctx,14);
 expect(manager).toContain('"reader"');
 expect(manager).toContain('"editor"');
 await expect(exportUsageCsv(f.pool,{...f.ctx,principalId:"outsider"},14)).rejects.toThrow("NOT_FOUND");
});
test("CSV export is window-bounded and empty reports have headers without fabricated events",async()=>{
 expect((await exportUsageCsv(f.pool,f.ctx,90)).trim()).toBe("at_utc,operation,succeeded,duration_ms,principal_id");
 await expect(exportUsageCsv(f.pool,f.ctx,365)).rejects.toThrow("VALIDATION_FAILED");
});
