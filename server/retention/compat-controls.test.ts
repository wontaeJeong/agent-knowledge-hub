import { expect, test } from "vitest";
import { fixture } from "../test-support";
import { inventory } from "./inventory";

test("known compatibility and collector controls remain metadata-only; added columns fail closed", async () => {
  const f = await fixture(), db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    // Isolated P9 lacks the P5/P7 migrations; on a combined branch the real
    // definitions already exist and are exercised instead of these fixtures.
    await db.query(`CREATE TABLE IF NOT EXISTS legacy_compat_memberships (workspace_id text NOT NULL, principal_id text NOT NULL, role text NOT NULL, subject text NOT NULL, revoked boolean NOT NULL, captured_at timestamptz NOT NULL)`);
    await db.query(`CREATE TABLE IF NOT EXISTS legacy_compat_installation (singleton boolean NOT NULL, installation_id uuid NOT NULL, import_key_fingerprint text)`);
    await db.query(`CREATE TABLE IF NOT EXISTS legacy_compat_manifest_imports (manifest_hash text NOT NULL, backup_hash text NOT NULL, key_fingerprint text NOT NULL, captured_at timestamptz NOT NULL, issued_at timestamptz NOT NULL, imported_at timestamptz NOT NULL)`);
    await db.query(`CREATE TABLE IF NOT EXISTS storage_collector_connections (workspace_id text NOT NULL, id text NOT NULL, principal_id text NOT NULL, configuration_hash text NOT NULL, active boolean NOT NULL, revision integer NOT NULL, created_at timestamptz NOT NULL)`);
    const rows = await inventory(db, f.workspaceId);
    expect(rows.some(r => r.table === "legacy_compat_memberships" || r.table === "storage_collector_connections")).toBe(false);
    for (const table of ["legacy_compat_memberships", "legacy_compat_installation", "legacy_compat_manifest_imports", "storage_collector_connections"]) {
      await db.query(`ALTER TABLE ${table} ADD COLUMN future_private_body text`);
      await expect(inventory(db, f.workspaceId)).rejects.toThrow("RETENTION_GRAPH_UNSUPPORTED");
      await db.query(`ALTER TABLE ${table} DROP COLUMN future_private_body`);
    }
    await db.query("ALTER TABLE storage_collector_connections ADD CONSTRAINT fixture_new_resource_fk FOREIGN KEY (workspace_id,id) REFERENCES sources(workspace_id,id)");
    await expect(inventory(db, f.workspaceId)).rejects.toThrow("RETENTION_GRAPH_UNSUPPORTED");
  } finally {
    await db.query("ROLLBACK"); db.release(); await f.pool.end();
  }
});

test('native index controls are metadata-only and never retention content roots',async()=>{
 const f=await fixture(),db=await f.pool.connect();
 try{
  const global=(await db.query('SELECT * FROM search_index_state ORDER BY id')).rows;
  const workspace=(await db.query('SELECT * FROM search_index_workspace_state WHERE workspace_id=$1',[f.workspaceId])).rows;
  expect(global).toHaveLength(1);expect(workspace).toHaveLength(1);
  const rows=await inventory(db,f.workspaceId);
  expect(rows.some(row=>['search_index_state','search_index_workspace_state'].includes(row.table))).toBe(false);
  expect((await db.query('SELECT * FROM search_index_state ORDER BY id')).rows).toEqual(global);
  expect((await db.query('SELECT * FROM search_index_workspace_state WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual(workspace);
 }finally{db.release();await f.pool.end()}
});
test.each(['search_index_state','search_index_workspace_state'])('native index control %s rejects future content columns',async table=>{
 const f=await fixture(),db=await f.pool.connect();
 try{await db.query('BEGIN');await expect(inventory(db,f.workspaceId)).resolves.toEqual(expect.any(Array));await db.query(`ALTER TABLE ${table} ADD COLUMN future_private_body text`);await expect(inventory(db,f.workspaceId)).rejects.toThrow('RETENTION_GRAPH_UNSUPPORTED')}finally{await db.query('ROLLBACK');db.release();await f.pool.end()}
});
test.each(['search_index_state','search_index_workspace_state'])('native index control %s rejects a new product foreign key even without column drift',async table=>{
 const f=await fixture(),db=await f.pool.connect();
 try{await db.query('BEGIN');await expect(inventory(db,f.workspaceId)).resolves.toEqual(expect.any(Array));const column=table==='search_index_state'?'last_success_job_id':'workspace_id';await db.query(`ALTER TABLE ${table} ADD CONSTRAINT future_product_fk FOREIGN KEY (${column}) REFERENCES durable_jobs(id) NOT VALID`);await expect(inventory(db,f.workspaceId)).rejects.toThrow('RETENTION_GRAPH_UNSUPPORTED')}finally{await db.query('ROLLBACK');db.release();await f.pool.end()}
});

test.each([
 ['search_index_state','ALTER COLUMN last_success_kind DROP NOT NULL'],
 ['search_index_workspace_state','ALTER COLUMN revision TYPE integer'],
])('native index control %s rejects type or nullability drift',async(table,change)=>{
 const f=await fixture(),db=await f.pool.connect();
 try{await db.query('BEGIN');await expect(inventory(db,f.workspaceId)).resolves.toEqual(expect.any(Array));await db.query(`ALTER TABLE ${table} ${change}`);await expect(inventory(db,f.workspaceId)).rejects.toThrow('RETENTION_GRAPH_UNSUPPORTED')}finally{await db.query('ROLLBACK');db.release();await f.pool.end()}
});
test('native index workspace control rejects changed allowed FK deletion semantics',async()=>{
 const f=await fixture(),db=await f.pool.connect();
 try{
  await db.query('BEGIN');await expect(inventory(db,f.workspaceId)).resolves.toEqual(expect.any(Array));
  await db.query('ALTER TABLE search_index_workspace_state DROP CONSTRAINT search_index_workspace_state_workspace_id_fkey');
  await db.query('ALTER TABLE search_index_workspace_state ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE');
  await expect(inventory(db,f.workspaceId)).rejects.toThrow('RETENTION_GRAPH_UNSUPPORTED');
 }finally{await db.query('ROLLBACK');db.release();await f.pool.end()}
});
