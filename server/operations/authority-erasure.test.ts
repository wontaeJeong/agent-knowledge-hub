import { test, expect } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { OperationsService } from "./service";
import { previewErasure, executeErasure, replayProductErasure } from "./erasure";

test("workspace erasure and signed replay retire restored legacy and collector authority without affecting other spaces", async () => {
 const f=await fixture(), other=await fixture();
 try {
  await adoptFixture(f.pool,f.workspaceId);
  await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",[f.workspaceId]);
  await f.pool.query(`CREATE TABLE IF NOT EXISTS legacy_compat_memberships (workspace_id text NOT NULL,principal_id text NOT NULL,role text NOT NULL,subject text NOT NULL,revoked boolean NOT NULL DEFAULT false,captured_at timestamptz NOT NULL DEFAULT now())`);
  await f.pool.query(`CREATE TABLE IF NOT EXISTS storage_collector_connections (workspace_id text NOT NULL,id text NOT NULL,principal_id text NOT NULL,configuration_hash text NOT NULL,active boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now())`);
  for(const workspace of [f.workspaceId,other.workspaceId]) {
   await f.pool.query("INSERT INTO legacy_compat_memberships(workspace_id,principal_id,role,subject) VALUES($1,'editor','editor','synthetic')",[workspace]);
   await f.pool.query("INSERT INTO storage_collector_connections(workspace_id,id,principal_id,configuration_hash) VALUES($1,'host','editor',$2)",[workspace,'a'.repeat(64)]);
  }
  const ctx={workspaceId:f.workspaceId,principalId:'fixture-owner'}, service=new OperationsService(f.pool,authorizeInTransaction), input={scope:'workspace' as const};
  const preview=await previewErasure(service,ctx,input);
  expect((await executeErasure(service,ctx,{...input,previewHash:preview.previewHash,confirm:'ERASE_ENTIRE_WORKSPACE'})).status).toBe('completed');
  expect((await f.pool.query('SELECT revoked FROM legacy_compat_memberships WHERE workspace_id=$1',[f.workspaceId])).rows[0].revoked).toBe(true);
  expect((await f.pool.query('SELECT active FROM storage_collector_connections WHERE workspace_id=$1',[f.workspaceId])).rows[0].active).toBe(false);
  expect((await f.pool.query('SELECT revoked FROM legacy_compat_memberships WHERE workspace_id=$1',[other.workspaceId])).rows[0].revoked).toBe(false);
  expect((await f.pool.query('SELECT active FROM storage_collector_connections WHERE workspace_id=$1',[other.workspaceId])).rows[0].active).toBe(true);
  const db=await f.pool.connect();try {
   await db.query('BEGIN');
   await db.query('UPDATE legacy_compat_memberships SET revoked=false WHERE workspace_id=$1',[f.workspaceId]);
   await db.query('UPDATE storage_collector_connections SET active=true WHERE workspace_id=$1',[f.workspaceId]);
   await replayProductErasure(db,f.workspaceId,[],true);
   expect((await db.query('SELECT revoked FROM legacy_compat_memberships WHERE workspace_id=$1',[f.workspaceId])).rows[0].revoked).toBe(true);
   expect((await db.query('SELECT active FROM storage_collector_connections WHERE workspace_id=$1',[f.workspaceId])).rows[0].active).toBe(false);
  } finally {await db.query('ROLLBACK');db.release();}
 } finally {await f.pool.end();await other.pool.end();}
});

test('legal hold and unknown authority schemas leave all authority and content intact', async () => {
 const f=await fixture();
 try {
  await adoptFixture(f.pool,f.workspaceId);
  await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",[f.workspaceId]);
  await f.pool.query("INSERT INTO legacy_compat_memberships(workspace_id,principal_id,role,subject) VALUES($1,'editor','editor','synthetic')",[f.workspaceId]);
  await f.pool.query("INSERT INTO storage_collector_connections(workspace_id,id,principal_id,configuration_hash) VALUES($1,'host','editor',$2)",[f.workspaceId,'a'.repeat(64)]);
  await f.pool.query("INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'hold','workspace',$1,'fixture-owner')",[f.workspaceId]);
  const ctx={workspaceId:f.workspaceId,principalId:'fixture-owner'},service=new OperationsService(f.pool,authorizeInTransaction),input={scope:'workspace' as const};
  let preview=await previewErasure(service,ctx,input);
  await expect(executeErasure(service,ctx,{...input,previewHash:preview.previewHash,confirm:'ERASE_ENTIRE_WORKSPACE'})).rejects.toThrow('LEGAL_HOLD');
  expect((await f.pool.query('SELECT revoked FROM legacy_compat_memberships WHERE workspace_id=$1',[f.workspaceId])).rows[0].revoked).toBe(false);
  expect((await f.pool.query('SELECT active FROM storage_collector_connections WHERE workspace_id=$1',[f.workspaceId])).rows[0].active).toBe(true);
  await f.pool.query("DELETE FROM operations_legal_holds WHERE workspace_id=$1 AND id='hold'",[f.workspaceId]);
  await f.pool.query('ALTER TABLE storage_collector_connections ADD COLUMN future_authority text');
  try {
   preview=await previewErasure(service,ctx,input);
   await expect(executeErasure(service,ctx,{...input,previewHash:preview.previewHash,confirm:'ERASE_ENTIRE_WORKSPACE'})).rejects.toThrow('ERASURE_AUTHORITY_SCHEMA_UNSUPPORTED');
   expect((await f.pool.query('SELECT revoked FROM legacy_compat_memberships WHERE workspace_id=$1',[f.workspaceId])).rows[0].revoked).toBe(false);
   expect((await f.pool.query('SELECT active FROM storage_collector_connections WHERE workspace_id=$1',[f.workspaceId])).rows[0].active).toBe(true);
   expect((await f.pool.query("SELECT data->>'content' AS content FROM sources WHERE workspace_id=$1 AND id='source-a'",[f.workspaceId])).rows[0].content).toContain('지식');
  } finally {await f.pool.query('ALTER TABLE storage_collector_connections DROP COLUMN future_authority');}
 } finally {await f.pool.end();}
});
