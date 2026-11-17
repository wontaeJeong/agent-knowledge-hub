import { afterAll, expect, test } from "vitest";
import { type Pool } from "pg";
import { fixture, adoptFixture, source, page } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { OperationsService } from "./service";
import { executeErasure, previewErasure, selectErasureRows, type ProductRow } from "./erasure";
import { inventory as retentionInventory } from "../retention/inventory";
const pools: Pool[] = [];
afterAll(async () => { await Promise.all(pools.map(pool => pool.end())); });
async function setup() {
  const f = await fixture(); pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query("INSERT INTO resources VALUES($1,'source','independent'),($1,'page','linked')", [f.workspaceId]);
  await f.pool.query("INSERT INTO sources(workspace_id,id,data) VALUES($1,'independent',$2)", [f.workspaceId, {...source, id:"independent", content:"independent private bytes", target_page_id:"topic", linkReferences:[{targetPageId:"topic",label:"arbitrary source metadata"}]}]);
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,'linked',$2)", [f.workspaceId, {...page, id:"linked", versions:undefined}]);
  await f.pool.query("INSERT INTO versions VALUES($1,'linked',1,$2),($1,'linked',2,$3)", [f.workspaceId,
    {...page.versions[0], sourceIds:[], content:"historic linked private body", linkReferences:[{targetPageId:"topic",label:"private link label",sourceBlockId:null}]},
    {...page.versions[0], number:2, sourceIds:[], content:"current body without link", linkReferences:[]}]);
  await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING", [f.workspaceId]);
  const ctx={workspaceId:f.workspaceId,principalId:"fixture-owner"};
  return {...f, ctx, ops:new OperationsService(f.pool,authorizeInTransaction)};
}
async function fullRows(f: Awaited<ReturnType<typeof setup>>) {
  const rows:ProductRow[]=[];
  for(const table of ["sources","pages","versions","published_page_links"])
    for(const {data} of (await f.pool.query(`SELECT to_jsonb(t) AS data FROM ${table} t WHERE workspace_id=$1`,[f.workspaceId])).rows)
      rows.push({table,locator:JSON.stringify(data),data});
  return rows;
}
test("routing hints and arbitrary link metadata confer no erasure authority; historical canonical references do",async()=>{
  const f=await setup();
  const selected=selectErasureRows(await fullRows(f),{kind:"source",id:"source-a"});
  expect(selected.filter(r=>r.table==="sources").map(r=>r.data.id)).toEqual(["source-a"]);
  expect(selected.filter(r=>r.table==="versions").map(r=>r.data.page_id)).toContain("linked");
  await f.pool.query("INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'independent-hold','source','independent','fixture-owner')",[f.workspaceId]);
  const request={scope:"resource",resource:{kind:"source",id:"source-a"}};
  const preview=await previewErasure(f.ops,f.ctx,request);
  const before=(await f.pool.query("SELECT data FROM sources WHERE workspace_id=$1 AND id='independent'",[f.workspaceId])).rows[0];
  expect((await executeErasure(f.ops,f.ctx,{...request,previewHash:preview.previewHash,confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"})).status).toBe("completed");
  expect((await f.pool.query("SELECT data FROM sources WHERE workspace_id=$1 AND id='independent'",[f.workspaceId])).rows[0]).toEqual(before);
  expect((await f.pool.query("SELECT 1 FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='independent'",[f.workspaceId])).rowCount).toBeGreaterThan(0);
  const historical=(await f.pool.query("SELECT data FROM versions WHERE workspace_id=$1 AND page_id='linked' AND number=1",[f.workspaceId])).rows[0].data;
  expect(historical.linkReferences).toEqual([{targetPageId:"topic",label:"[법정 삭제]",sourceBlockId:null}]);
  expect(historical.content).toBe("[법정 삭제]");
});
test("retention projection keeps historical canonical link IDs without labels and excludes source routing hints",async()=>{
  const f=await setup(), db=await f.pool.connect();
  try {
    const rows=await retentionInventory(db,f.workspaceId);
    const selected=selectErasureRows(rows,{kind:"page",id:"topic"});
    expect(selected.filter(r=>r.table==="sources")).toEqual([]);
    expect(selected.filter(r=>r.table==="versions").map(r=>r.data.page_id)).toContain("linked");
    expect(JSON.stringify(rows)).not.toContain("private link label");
    expect(JSON.stringify(rows)).not.toContain("historic linked private body");
  } finally {db.release();}
});
test("canonical version targets retain legal holds and index endpoints are selected in both directions",async()=>{
  const f=await setup();
  await f.pool.query("INSERT INTO published_page_links VALUES($1,'linked',2,'topic')",[f.workspaceId]);
  for(const id of ["topic","linked"])
    expect(selectErasureRows(await fullRows(f),{kind:"page",id}).filter(r=>r.table==="published_page_links")).toHaveLength(1);
  // Prove holds do not depend on a disposable index being present.
  await f.pool.query("DELETE FROM published_page_links WHERE workspace_id=$1",[f.workspaceId]);
  await f.pool.query("INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'target-hold','page','topic','fixture-owner')",[f.workspaceId]);
  const request={scope:"resource",resource:{kind:"page",id:"linked"}};
  const preview=await previewErasure(f.ops,f.ctx,request);
  await expect(executeErasure(f.ops,f.ctx,{...request,previewHash:preview.previewHash,confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("LEGAL_HOLD");
  expect((await f.pool.query("SELECT data->>'content' AS content FROM versions WHERE workspace_id=$1 AND page_id='linked' AND number=1",[f.workspaceId])).rows[0].content).toBe("historic linked private body");
});
