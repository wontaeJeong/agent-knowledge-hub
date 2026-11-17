import { expect,test } from "vitest";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {fixture} from "../test-support";
import {migrate,assertSchemaCurrent} from "../database";
import {inventory} from "../retention/inventory";
test("145 rollback/upgrade/restart preserves existing versions and classifies bulk retention data",async()=>{
 const f=await fixture();let restarted:Pool|undefined;
 try{
  await f.pool.query("DROP TABLE workflow_bulk_items,workflow_bulk_requests");
  await f.pool.query("DELETE FROM schema_migrations WHERE version=145");
  await f.pool.query("ALTER TABLE runtime_execution_grants DROP CONSTRAINT runtime_execution_grants_operation_check");
  await f.pool.query("ALTER TABLE runtime_execution_grants ADD CONSTRAINT runtime_execution_grants_operation_check CHECK(operation IN ('ingest','query','lint','index'))");
  const db=await f.pool.connect();try{await db.query("BEGIN");await db.query(await readFile(new URL('../migrations/145-bulk-document-actions.sql',import.meta.url),'utf8'));await db.query("ROLLBACK");expect((await db.query("SELECT to_regclass('workflow_bulk_items') AS t")).rows[0].t).toBeNull();}finally{db.release();}
  await migrate(f.pool);await assertSchemaCurrent(f.pool);restarted=new Pool({connectionString:process.env.TEST_DATABASE_URL});await migrate(restarted);await assertSchemaCurrent(restarted);
  expect((await restarted.query("SELECT number FROM versions WHERE workspace_id=$1",[f.workspaceId])).rows.map(r=>r.number)).toEqual([1]);
  const c=await restarted.connect();try{expect(await inventory(c,f.workspaceId)).toBeDefined();}finally{c.release();}
 }finally{await restarted?.end();await f.pool.end();}
});
