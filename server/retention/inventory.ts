import type { PoolClient } from "pg";
import type { ProductRow } from "../operations/erasure";
import { releasedImportTables, releasedImportProjection } from "../operations/released-imports";
// The same storage/product graph classes as operations erasure, including immutable
// histories and released private imports. Unknown/new classes are never deleted.
const productTables = new Set([
  "sources","pages","versions","batches","requests","publications","approvals",
  "workflow_access_requests","workflow_activity","workflow_comments","workflow_document_state","workflow_draft_recovery_grants","workflow_draft_revision_history","workflow_draft_save_mutations","workflow_drafts","workflow_events","workflow_notifications","workflow_preferences","workflow_source_state","workflow_subscriptions","workflow_templates",
  "runtime_answers","runtime_execution_grants","runtime_jobs","runtime_lints","runtime_request_traces",
  "agent_api_keys","agent_device_clients","agent_device_grants","agent_key_audit","agent_key_requests","agent_outcomes","agent_personal_pages","agent_personal_revisions","agent_requests","agent_review_signals",
  "refinement_claims","refinement_evidence","refinement_outcomes","refinement_requests","refinement_reviews",
  "durable_jobs","durable_job_outbox","durable_model_calls","durable_schedules","durable_schedule_versions","durable_schedule_runs",
  "storage_imports","storage_import_sources","storage_import_effects","storage_snapshots","storage_attachment_links","storage_attachment_slots","storage_attachment_versions","storage_blobs",
  "board_posts","board_comments","board_reads","identity_emergencies","import_model_calls","model_usage_events","model_source_policies","policy_events","policy_private_import_sources",
  "question_feedback","question_feedback_work","question_threads","question_turns",
  "version_metadata","version_metadata_events","version_restore_applications","version_restore_plans","version_restore_previews","versions_decisions",
  "collaboration_delivery_events","collaboration_delivery_receipts","collaboration_digest_outbox","collaboration_digest_plans","collaboration_review_cadence","collaboration_review_due_work",
  "governance_business_owners","governance_events","governance_handoffs","governance_review_assignments","governance_type_policies",
]);
export function contains(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((v) => contains(v, target));
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(([k, v]) => k === target || contains(v, target))
  );
}
/** Keep private bodies/titles inside PostgreSQL. Hash changes into the preview
 * without materializing them in the service or exposing them in a receipt. */
function privateProjection(table:string):string | undefined {
  if (table === "versions") return `(to_jsonb(t)-'data') || jsonb_build_object('data',jsonb_build_object('at',t.data->'at','sourceIds',t.data->'sourceIds','pageIds',t.data->'pageIds','provenance',jsonb_build_object('pageIds',t.data->'provenance'->'pageIds','sourceIds',t.data->'provenance'->'sourceIds'),'dependencyVersions',t.data->'dependencyVersions'),'private_payload_sha256',encode(sha256(convert_to(t.data::text,'UTF8')),'hex'))`;
  if (table === "sources") return `(to_jsonb(t)-'data') || jsonb_build_object('data',jsonb_build_object('id',t.data->'id','createdAt',t.data->'createdAt','targetPageId',t.data->'targetPageId','importId',t.data->'importId','importRunId',t.data->'importRunId'),'private_payload_sha256',encode(sha256(convert_to(t.data::text,'UTF8')),'hex'))`;
  if (table === "pages") return `(to_jsonb(t)-'data') || jsonb_build_object('data',jsonb_build_object('id',t.data->'id','links',t.data->'links'),'private_payload_sha256',encode(sha256(convert_to(t.data::text,'UTF8')),'hex'))`;
  if (table === "runtime_execution_grants") return `(to_jsonb(t)-'credential_id'-'parent_credential_id'-'parent_session_id'-'parent_session_snapshot'-'request_key') || jsonb_build_object('private_payload_sha256',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'))`;
  if (table === "durable_jobs") return `(to_jsonb(t)-'input'-'checkpoint'-'result'-'idempotency_key'-'credential_id') || jsonb_build_object('input',jsonb_build_object('pageIds',t.input->'pageIds','sourceIds',t.input->'sourceIds'),'private_payload_sha256',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'))`;
  if (table === "durable_job_outbox") return `(to_jsonb(t)-'payload') || jsonb_build_object('job_kind',(SELECT j.kind FROM durable_jobs j WHERE j.id=t.job_id),'private_payload_sha256',encode(sha256(convert_to(t.payload::text,'UTF8')),'hex'))`;
  if (table === "workflow_events") return `(to_jsonb(t)-'data') || jsonb_build_object('data',jsonb_build_object('pageId',t.data->'pageId','sourceId',t.data->'sourceId','draftId',t.data->'draftId','version',t.data->'version'),'private_payload_sha256',encode(sha256(convert_to(t.data::text,'UTF8')),'hex'))`;
  if (["runtime_answers","runtime_lints","batches","requests","publications","storage_imports","storage_import_effects","workflow_comments","workflow_notifications","workflow_preferences","workflow_templates","workflow_document_state","workflow_source_state","refinement_evidence","refinement_claims","refinement_outcomes","refinement_requests","refinement_reviews","version_metadata","version_metadata_events","version_restore_previews","version_restore_plans","versions_decisions","governance_events","governance_handoffs","collaboration_digest_plans","policy_events","policy_private_import_sources","model_source_policies"].includes(table))
    return `(to_jsonb(t)-'data'-'result'-'manifest'-'payload'-'snapshot'-'before_snapshot'-'after_snapshot'-'anchors'-'preferences'-'reasons'-'attribution'-'work') || jsonb_build_object('private_payload_sha256',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'))`;
  if (["agent_api_keys","agent_device_clients","agent_device_grants","agent_key_audit","agent_key_requests","model_usage_events","storage_blobs","workflow_access_requests","identity_emergencies"].includes(table))
    return `(to_jsonb(t)-'name'-'reason'-'route'-'token_hash'-'device_hash'-'user_code'-'suffix'-'model'-'deployment_id'-'filename') || jsonb_build_object('private_payload_sha256',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'))`;
  if (table === "workflow_drafts") return `jsonb_build_object('workspace_id',t.workspace_id,'owner_id',t.owner_id,'id',t.id,'revision',t.revision,'updated_at',t.updated_at,'data',jsonb_build_object('pageId',t.data->'pageId','sourceIds',t.data->'sourceIds','dependencyVersions',t.data->'dependencyVersions'),'private_payload_sha256',encode(sha256(convert_to(t.data::text,'UTF8')),'hex'))`;
  if (table === "workflow_draft_revision_history") return `(to_jsonb(t)-'data') || jsonb_build_object('data',jsonb_build_object('pageId',t.data->'pageId','sourceIds',t.data->'sourceIds','dependencyVersions',t.data->'dependencyVersions'),'private_payload_sha256',encode(sha256(convert_to(t.data::text,'UTF8')),'hex'))`;
  if (table === "workflow_draft_save_mutations") return `(to_jsonb(t)-'result') || jsonb_build_object('result',jsonb_build_object('pageId',t.result->'pageId','sourceIds',t.result->'sourceIds','dependencyVersions',t.result->'dependencyVersions'),'private_payload_sha256',encode(sha256(convert_to(t.result::text,'UTF8')),'hex'))`;
  if (table === "workflow_draft_recovery_grants") return `(to_jsonb(t)-'binding') || jsonb_build_object('binding',jsonb_build_object('id',t.binding->'id','pageId',t.binding->'pageId','sourceIds',t.binding->'sourceIds','dependencyVersions',t.binding->'dependencyVersions'),'private_payload_sha256',encode(sha256(convert_to(t.binding::text,'UTF8')),'hex'))`;
  if (["board_posts","board_comments","question_turns","question_feedback","question_feedback_work","agent_personal_pages","agent_personal_revisions","agent_outcomes","agent_requests"].includes(table))
    return `(to_jsonb(t)-'key'-'question'-'sealed'-'reason'-'evidence'-'input_envelope'-'evidence_keys'-'data'-'result'-'title'-'body'-'content') || jsonb_build_object('private_payload_sha256',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'))`;
  return undefined;
}
export function unknownPrivateReference(row: {table:string;data:Record<string,unknown>}) {
  if (row.table === "durable_jobs") return row.data.kind !== "retention";
  if (row.table === "durable_job_outbox") return row.data.job_kind !== "retention";
  return ["runtime_answers","runtime_lints","batches","requests","publications","storage_imports","storage_import_effects","workflow_comments","workflow_notifications","workflow_preferences","workflow_templates","workflow_events","workflow_document_state","workflow_source_state","refinement_evidence","refinement_claims","refinement_outcomes","refinement_requests","refinement_reviews","version_metadata","version_metadata_events","version_restore_previews","version_restore_plans","versions_decisions","governance_events","governance_handoffs","collaboration_digest_plans","policy_events","policy_private_import_sources","model_source_policies","agent_api_keys","agent_device_clients","agent_device_grants","agent_key_audit","agent_key_requests","model_usage_events","workflow_access_requests","identity_emergencies"].includes(row.table);
}
export async function inventory(
  db: PoolClient,
  workspaceId: string,
): Promise<ProductRow[]> {
  const columns = (
    await db.query(
      "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name",
    )
  ).rows;
  const tables = [...new Set<string>(columns.map((c) => c.table_name))].filter(
    (t) => productTables.has(t) || releasedImportTables.has(t),
  );
  // Every workspace table must be explicitly classified, including plain
  // text tables: unknown schemas may contain untracked references.
  const controls = new Set(["access_audit","access_batch_authors","access_credentials","access_grants","access_review_rules","access_reviewers","access_shares","access_source_policy","access_spaces","access_triage","audit","content_retention_holds","content_retention_policies","content_retention_receipts","durable_budget_days","durable_budget_limits","feature_policies","legacy_v1_access_grants","legacy_v1_access_invitations","legacy_v1_access_reviewers","legacy_v1_access_spaces","legacy_v1_access_triage","memberships","operations_audit_archives","operations_audit_chain","operations_erased_artifacts","operations_erasure_receipts","operations_legal_holds","operations_policy","operations_recovery_acl","operations_tombstones","resource_readers","resources","runtime_sessions","storage_tickets","usage_events"]);
  const unknown = [...new Set<string>(columns.filter(c => c.column_name === "workspace_id").map(c => c.table_name))].filter(t => !tables.includes(t) && !controls.has(t));
  const globalControls = new Set(["access_group_members","access_groups","access_invitations","access_namespaces","access_principals","access_service_accounts","access_team_members","durable_job_fairness","durable_job_stops","identity_directory_bindings","identity_directory_edges","identity_directory_proofs","identity_events","identity_group_denies","identity_manual_group_members","identity_session_activity","legacy_v1_access_audit","legacy_v1_access_function_definitions","legacy_v1_access_org_members","legacy_v1_access_orgs","legacy_v1_access_principals","legacy_v1_access_team_members","legacy_v1_access_teams","legacy_v1_identity_subjects","model_destinations","oidc_logins","operations_alert_outbox","operations_backups","operations_recovery_releases","runtime_directory_status","schema_migrations","workspaces"]);
  const baseTables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows;
  if (baseTables.some(r=>!tables.includes(r.table_name) && !controls.has(r.table_name) && !globalControls.has(r.table_name))) throw Error("RETENTION_GRAPH_UNSUPPORTED");
  const foreignRefs=(await db.query(`SELECT DISTINCT src.relname AS name FROM pg_constraint c JOIN pg_class src ON src.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=src.relnamespace JOIN pg_class target ON target.oid=c.confrelid WHERE c.contype='f' AND ns.nspname='public' AND target.relname=ANY($1::text[])`,[["versions","sources","pages","storage_snapshots","storage_blobs","workflow_drafts"]])).rows;
  if (unknown.length || foreignRefs.some(r=>!tables.includes(r.name) && !controls.has(r.name))) throw Error("RETENTION_GRAPH_UNSUPPORTED");
  const rows: ProductRow[] = [];
  for (const table of tables) {
    const scoped = columns.some(
      (c) => c.table_name === table && c.column_name === "workspace_id",
    );
    const jobScoped = columns.some(
      (c) => c.table_name === table && c.column_name === "job_id",
    );
    const deliveryScoped =
      table.startsWith("collaboration_") &&
      columns.some(
        (c) => c.table_name === table && c.column_name === "delivery_id",
      );
    const scheduleScoped = table === "durable_schedule_versions" || table === "durable_schedule_runs";
    const keyScoped = table === "agent_key_requests" && columns.some(
      (c) => c.table_name === table && c.column_name === "key_id",
    );
    if (!scoped && !jobScoped && !deliveryScoped && !keyScoped && !scheduleScoped)
      throw Error("RETENTION_GRAPH_UNSUPPORTED");
    const scope = scoped
      ? "workspace_id=$1"
      : jobScoped
        ? "job_id IN(SELECT id FROM durable_jobs WHERE workspace_id=$1)"
        : scheduleScoped
          ? "schedule_id IN(SELECT id FROM durable_schedules WHERE workspace_id=$1)"
        : deliveryScoped
          ? "delivery_id IN(SELECT id FROM collaboration_digest_outbox WHERE workspace_id=$1)"
          : "key_id IN(SELECT id FROM agent_api_keys WHERE workspace_id=$1)";
    const r = await db.query(
      `SELECT t.ctid::text AS locator,${privateProjection(table) ?? releasedImportProjection(table) ?? "to_jsonb(t)"} AS data FROM "${table}" t WHERE ${scope} ORDER BY t.ctid LIMIT 10001`,
      [workspaceId],
    );
    rows.push(...r.rows.map((row) => ({ table, ...row })));
    if (rows.length > 10000) throw Error("RETENTION_GRAPH_BOUND");
  }
  return rows;
}
