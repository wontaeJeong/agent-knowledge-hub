import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { ProductRow } from "./erasure";
import type { Context } from "../service";
export const releasedImportTables = new Set([
  "imports",
  "import_files",
  "import_parts",
  "import_runs",
  "import_observations",
  "import_disclosures",
]);
/** Do not materialize native raw bytea or large parsed/result copies into the Node preview heap. */
export function releasedImportProjection(table: string): string | undefined {
  const hash = (expression: string) =>
    `encode(sha256(convert_to((${expression})::text,'UTF8')),'hex')`;
  if (table === "import_parts")
    return "jsonb_build_object('workspace_id',t.workspace_id,'import_id',t.import_id,'file_id',t.file_id,'part',t.part,'sha256',t.sha256,'raw_bytes',octet_length(t.data))";
  if (table === "imports")
    return `jsonb_build_object('workspace_id',t.workspace_id,'id',t.id,'principal_id',t.principal_id,'revision',t.revision,'status',t.status,'private_payload_sha256',${hash("jsonb_build_array(t.parsed,t.selection,t.title)")})`;
  if (table === "import_runs")
    return `jsonb_build_object('workspace_id',t.workspace_id,'id',t.id,'import_id',t.import_id,'principal_id',t.principal_id,'input_envelope',t.input_envelope,'private_payload_sha256',${hash("jsonb_build_array(t.result,t.changeset,t.execution_config,to_jsonb(t)->'payload')")})`;
  return undefined;
}
export function unmappedReleasedImports(
  rows: ProductRow[],
  selected: ProductRow[],
) {
  const runs = new Map(
    rows
      .filter((r) => r.table === "import_runs")
      .map((r) => [String(r.data.id), String(r.data.import_id)]),
  );
  const mapped = new Set<string>();
  for (const row of rows)
    if (row.table === "sources") {
      const d = row.data.data as Record<string, unknown> | undefined;
      if (typeof d?.importId === "string") mapped.add(d.importId);
      if (typeof d?.importRunId === "string" && runs.has(d.importRunId))
        mapped.add(runs.get(d.importRunId)!);
    }
  return rows.filter(
    (r) =>
      r.table === "imports" &&
      !selected.includes(r) &&
      !mapped.has(String(r.data.id)),
  ).length;
}
/** Fixed released006 table adapter. No arbitrary column/table/SQL values from a browser. */
export async function redactReleasedImportRow(db: PoolClient, row: ProductRow) {
  if (!releasedImportTables.has(row.table)) return false;
  const p = [row.locator];
  switch (row.table) {
    case "imports":
      await db.query(
        "UPDATE imports SET title='[법정 삭제]',selection='{}',parsed=NULL,revision=revision+1,status='erased',updated_at=now() WHERE ctid=$1::tid",
        p,
      );
      break;
    case "import_files":
      await db.query(
        "UPDATE import_files SET name='[법정 삭제]',received=0 WHERE ctid=$1::tid",
        p,
      );
      break;
    case "import_parts":
      await db.query(
        "UPDATE import_parts SET data=''::bytea WHERE ctid=$1::tid",
        p,
      );
      break;
    case "import_runs": {
      await db.query(
        "UPDATE import_runs SET status='cancelled',stage='cancelled',cancel_requested=true,lease_token=lease_token+1,lease_until=NULL,session_id=NULL,grant_role='reader',grant_expires_at=clock_timestamp(),result=NULL,input_envelope=NULL,changeset=NULL,execution_config='{}',error_code='LEGAL_ERASURE',updated_at=now() WHERE ctid=$1::tid",
        p,
      );
      // Some released revisions also carry an additional payload column. Clear it if present.
      const payload = (
        await db.query(
          "SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='import_runs' AND column_name='payload'",
        )
      ).rows[0];
      if (payload) {
        const id = row.data.id,
          workspace = row.data.workspace_id;
        if (payload.data_type === "jsonb" || payload.data_type === "json")
          await db.query(
            `UPDATE import_runs SET payload=${payload.is_nullable === "YES" ? "NULL" : "'{}'"} WHERE workspace_id=$1 AND id=$2`,
            [workspace, id],
          );
        else if (payload.data_type === "bytea")
          await db.query(
            "UPDATE import_runs SET payload=''::bytea WHERE workspace_id=$1 AND id=$2",
            [workspace, id],
          );
        else if (payload.data_type === "text")
          await db.query(
            "UPDATE import_runs SET payload='[법정 삭제]' WHERE workspace_id=$1 AND id=$2",
            [workspace, id],
          );
        else throw Error("IMPORT_PAYLOAD_ERASURE_UNSUPPORTED");
      }
      break;
    }
    case "import_observations":
      await db.query(
        "UPDATE import_observations SET source_key=$2,event='deleted' WHERE ctid=$1::tid",
        [row.locator, "erased-" + randomUUID()],
      );
      break;
    case "import_disclosures":
      await db.query(
        "UPDATE import_disclosures SET audience='[]',status='revoked',approved_at=NULL WHERE ctid=$1::tid",
        p,
      );
      break;
  }
  return true;
}
/** Invoke from preserved ImportService own/enqueue/resume/guard before granting or processing input. */
export async function assertReleasedImportUsable(
  db: Pick<PoolClient, "query">,
  workspaceId: string,
  importId: string,
) {
  const row = (
    await db.query(
      "SELECT status FROM imports WHERE workspace_id=$1 AND id=$2",
      [workspaceId, importId],
    )
  ).rows[0];
  if (!row) throw Error("NOT_FOUND");
  if (row.status === "erased") throw Error("LEGAL_ERASURE");
  const removed = await db.query(
    "SELECT 1 FROM sources s JOIN operations_tombstones t ON t.workspace_id=s.workspace_id AND t.resource_kind='source' AND t.resource_id=s.id AND t.delete_content WHERE s.workspace_id=$1 AND (s.data->>'importId'=$2 OR s.data->>'importRunId' IN(SELECT id FROM import_runs WHERE workspace_id=$1 AND import_id=$2)) LIMIT 1",
    [workspaceId, importId],
  );
  if (removed.rowCount) throw Error("LEGAL_ERASURE");
}
/** Preserved-main hook: call AFTER own/auth checks and before enqueue/resume/guard/view. */
export async function assertReleasedImportContext(
  db: PoolClient,
  ctx: Context,
  importId: string,
) {
  await assertReleasedImportUsable(db, ctx.workspaceId, importId);
  const restored = (
    await db.query(
      "SELECT 1 FROM imports i WHERE i.workspace_id=$1 AND i.id=$2 AND EXISTS(SELECT 1 FROM operations_recovery_releases r WHERE r.status='released' AND i.created_at<=r.released_at) LIMIT 1",
      [ctx.workspaceId, importId],
    )
  ).rowCount;
  if (restored) {
    const sid = ctx.authorization?.sessionId;
    if (!sid || ctx.credentialId || !ctx.authorization)
      throw Error("AUTHORIZATION_REQUIRED");
    await ctx.authorization.assertSession(db);
    if (
      !(
        await db.query(
          "SELECT 1 FROM runtime_sessions WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 AND expires_at>clock_timestamp()",
          [sid, ctx.workspaceId, ctx.principalId],
        )
      ).rowCount
    )
      throw Error("AUTHORIZATION_REQUIRED");
  }
}
/** Mirror a verified current ordinary import.remove intent: clear private input, not unrelated company wiki. */
export async function replayReleasedInputRemoval(
  db: PoolClient,
  intent: { workspace_id: string; import_id: string; principal_id: string },
) {
  if (!(await db.query("SELECT to_regclass('public.imports') AS t")).rows[0].t)
    return;
  const original = (
    await db.query(
      "SELECT principal_id FROM imports WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [intent.workspace_id, intent.import_id],
    )
  ).rows[0];
  if (!original) return;
  if (original.principal_id !== intent.principal_id)
    throw Error("IMPORT_DELETION_AUTHORITY_MISMATCH");
  for (const table of [
    "import_parts",
    "import_files",
    "import_observations",
    "import_disclosures",
    "import_runs",
    "imports",
  ]) {
    const predicate =
      table === "imports"
        ? "t.id=$2"
        : table === "import_disclosures"
          ? "t.run_id IN(SELECT id FROM import_runs WHERE workspace_id=$1 AND import_id=$2)"
          : "t.import_id=$2";
    const rows = (
      await db.query(
        `SELECT t.ctid::text AS locator,${releasedImportProjection(table) ?? "to_jsonb(t)"} AS data FROM "${table}" t WHERE t.workspace_id=$1 AND ${predicate} FOR UPDATE OF t`,
        [intent.workspace_id, intent.import_id],
      )
    ).rows;
    for (const row of rows)
      await redactReleasedImportRow(db, {
        table,
        locator: row.locator,
        data: row.data,
      });
  }
  const sources = (
    await db.query(
      "SELECT id FROM sources WHERE workspace_id=$1 AND data->>'importId'=$2 AND data->>'importOwnerId'=$3",
      [intent.workspace_id, intent.import_id, intent.principal_id],
    )
  ).rows.map((r) => r.id);
  if (sources.length) {
    await db.query(
      "UPDATE sources SET data=jsonb_set(jsonb_set(data,'{content}',to_jsonb('[원본 소유자가 철회한 자료]'::text)),'{importWithdrawn}','true') WHERE workspace_id=$1 AND id=ANY($2::text[])",
      [intent.workspace_id, sources],
    );
    await db.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=ANY($2::text[])",
      [intent.workspace_id, sources],
    );
    // Match live withdrawSources: redact ONLY snapshots of these owned withdrawn sources.
    // Source withdrawal is not authority to erase unrelated wiki pages or other inputs.
    const affected = await db.query(
      `UPDATE batches b SET data=jsonb_set(b.data,'{snapshots}',
      (SELECT jsonb_agg(CASE WHEN item->>'id'=ANY($2::text[]) THEN jsonb_set(item,'{content}',to_jsonb('[원본 소유자가 철회한 자료]'::text)) ELSE item END ORDER BY ordinal)
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.data->'snapshots')='array' THEN b.data->'snapshots' ELSE '[]'::jsonb END) WITH ORDINALITY AS original(item,ordinal)))
      WHERE b.workspace_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.data->'snapshots')='array' THEN b.data->'snapshots' ELSE '[]'::jsonb END) AS snapshot WHERE snapshot->>'id'=ANY($2::text[])) RETURNING b.id`,
      [intent.workspace_id, sources],
    );
    if (affected.rows.length)
      await db.query(
        "DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=ANY($2::text[])",
        [intent.workspace_id, affected.rows.map((r) => r.id)],
      );
  }
}
