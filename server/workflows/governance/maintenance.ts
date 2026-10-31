import type { Pool, PoolClient } from "pg";
import { acquireSharedMutationGate } from "../../operations/gate";
import { appendOperationalAudit } from "../../operations/service";

const SYSTEM_ACTOR = "governance-maintenance";
const SCAN_OPERATION = "business-owner.maintenance.scan";
const SCANNER_LOCK = 7203102;
type Owner = {
  workspace_id: string;
  page_id: string;
  revision: number;
  owner_id: string;
  backup_id: string;
};
type Assessment = {
  ownerStatus: "eligible" | "unavailable" | "unknown";
  assessment: string;
};
export type HandoffScanResult = {
  scanned: number;
  queued: number;
  unknown: number;
  unavailable: number;
  valid: number;
  skipped: boolean;
};
export type HandoffScanOptions = {
  batchSize?: number;
  maxLineagePages?: number;
};

/** Metadata-only assessment of the SUBJECT of an assignment. It is NOT a request
 * Context, authorization grant, caller impersonation, or proof of external liveness. */
async function assessOwner(
  db: PoolClient,
  o: Owner,
  maxPages: number,
): Promise<Assessment> {
  const lost = (assessment: string): Assessment => ({
    ownerStatus: "unavailable",
    assessment,
  });
  const unknown = (assessment: string): Assessment => ({
    ownerStatus: "unknown",
    assessment,
  });
  const p = (
    await db.query(
      "SELECT active,kind,issuer FROM access_principals WHERE id=$1 FOR SHARE",
      [o.owner_id],
    )
  ).rows[0];
  if (!p || !p.active) return lost("PRINCIPAL_DISABLED");
  if (p.kind !== "human") return lost("HUMAN_OWNER_REQUIRED");
  const s = (
    await db.query(
      "SELECT s.active,s.visibility,s.namespace_id,n.kind,n.owner_id,m.active AS member_active,m.role AS member_role FROM access_spaces s JOIN access_namespaces n ON n.id=s.namespace_id LEFT JOIN access_team_members m ON m.team_id=s.namespace_id AND m.principal_id=$2 WHERE s.workspace_id=$1",
      [o.workspace_id, o.owner_id],
    )
  ).rows[0];
  if (!s?.active) return lost("SPACE_ACCESS_LOST");
  if (s.kind === "personal" ? s.owner_id !== o.owner_id : !s.member_active)
    return lost("MEMBERSHIP_LOST");
  // A current verified UserInfo projection is evidence; an old login or active=true is not.
  const proof = !!(
    await db.query(
      "SELECT 1 FROM identity_directory_proofs WHERE principal_id=$1 AND issuer=$2 AND verified_at<=clock_timestamp() AND verified_at>=clock_timestamp()-interval '5 minutes' AND valid_until>clock_timestamp() LIMIT 1",
      [o.owner_id, p.issuer],
    )
  ).rowCount;
  const grants = (
    await db.query(
      `SELECT
    EXISTS(SELECT 1 FROM access_grants g WHERE g.workspace_id=$1 AND NOT g.revoked AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND
      (g.principal_id=$2 OR (g.group_id IS NOT NULL AND EXISTS(SELECT 1 FROM access_group_members gm JOIN identity_manual_group_members mm ON mm.group_id=gm.group_id AND mm.principal_id=gm.principal_id WHERE gm.group_id=g.group_id AND gm.principal_id=$2 AND NOT EXISTS(SELECT 1 FROM identity_group_denies d WHERE d.group_id=g.group_id AND d.principal_id=$2))) OR
      ($3::boolean AND EXISTS(SELECT 1 FROM access_group_members gm JOIN identity_directory_edges e ON e.principal_id=gm.principal_id JOIN identity_directory_bindings b ON b.id=e.binding_id AND b.group_id=gm.group_id WHERE gm.group_id=g.group_id AND gm.principal_id=$2 AND b.active AND b.revision=e.binding_revision AND b.issuer=$4 AND e.valid_until>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM identity_group_denies d WHERE d.group_id=g.group_id AND d.principal_id=$2))))) AS current_role,
    EXISTS(SELECT 1 FROM access_grants g JOIN identity_directory_bindings b ON b.group_id=g.group_id AND b.active WHERE g.workspace_id=$1 AND NOT g.revoked AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())) AS directory_role_possible`,
      [o.workspace_id, o.owner_id, proof, p.issuer],
    )
  ).rows[0];
  const role =
    s.kind === "personal" ||
    s.member_role === "owner" ||
    s.visibility === "team" ||
    grants.current_role;

  // Only IDs, flags and provenance arrays are selected. Never select body/title/properties.
  const pending = [o.page_id],
    seen = new Set<string>();
  while (pending.length) {
    const pageId = pending.pop()!;
    if (seen.has(pageId)) continue;
    if (seen.size >= maxPages) return unknown("LINEAGE_LIMIT_NEEDS_CHECK");
    seen.add(pageId);
    const page = (
      await db.query(
        "SELECT p.id,w.parent_id,w.state,EXISTS(SELECT 1 FROM resource_readers r WHERE r.workspace_id=p.workspace_id AND r.kind='page' AND r.resource_id=p.id AND r.principal_id=$3) AS permitted FROM pages p LEFT JOIN workflow_document_state w ON w.workspace_id=p.workspace_id AND w.page_id=p.id WHERE p.workspace_id=$1 AND p.id=$2",
        [o.workspace_id, pageId, o.owner_id],
      )
    ).rows[0];
    if (!page || !page.permitted || page.state === "trash")
      return lost("PAGE_ACCESS_LOST");
    if (page.parent_id) {
      // A self/cyclic parent is a structural uncertainty, not evidence of a disabled user.
      const cycle = (
        await db.query(
          `WITH RECURSIVE c AS (
        SELECT page_id,parent_id,ARRAY[page_id] AS visited,false AS cycle FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2
        UNION ALL SELECT w.page_id,w.parent_id,c.visited||w.page_id,w.page_id=ANY(c.visited) FROM c JOIN workflow_document_state w ON w.workspace_id=$1 AND w.page_id=c.parent_id WHERE NOT c.cycle AND cardinality(c.visited)<$3
      ) SELECT coalesce(bool_or(cycle),false) AS cycle,coalesce(bool_or(cardinality(visited)>=$3 AND parent_id IS NOT NULL),false) AS bounded FROM c`,
          [o.workspace_id, pageId, maxPages],
        )
      ).rows[0];
      if (cycle.cycle || cycle.bounded)
        return unknown("LINEAGE_LIMIT_NEEDS_CHECK");
      pending.push(page.parent_id);
    }
    const sources = (
      await db.query(
        `SELECT DISTINCT source_id FROM (
      SELECT jsonb_array_elements_text(coalesce(data->'sourceIds','[]'::jsonb)) AS source_id FROM versions WHERE workspace_id=$1 AND page_id=$2
      UNION SELECT jsonb_array_elements_text(coalesce(data->'provenance'->'sourceIds','[]'::jsonb)) FROM versions WHERE workspace_id=$1 AND page_id=$2
    ) s ORDER BY source_id LIMIT 1001`,
        [o.workspace_id, pageId],
      )
    ).rows.map((r) => r.source_id as string);
    if (sources.length > 1000) return unknown("LINEAGE_LIMIT_NEEDS_CHECK");
    if (sources.length) {
      const missing = (
        await db.query(
          `SELECT 1 FROM unnest($3::text[]) sid LEFT JOIN sources s ON s.workspace_id=$1 AND s.id=sid LEFT JOIN workflow_source_state w ON w.workspace_id=$1 AND w.source_id=sid
        WHERE s.id IS NULL OR (w.state IS NOT NULL AND w.state<>'active') OR NOT EXISTS(SELECT 1 FROM resource_readers r WHERE r.workspace_id=$1 AND r.kind='source' AND r.resource_id=sid AND r.principal_id=$2) LIMIT 1`,
          [o.workspace_id, o.owner_id, sources],
        )
      ).rowCount;
      if (missing) return lost("SOURCE_ACCESS_LOST");
    }
    const dependencies = (
      await db.query(
        `SELECT DISTINCT page_id FROM (
      SELECT link AS page_id FROM pages p CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(p.data->'links','[]'::jsonb)) link JOIN pages target ON target.workspace_id=p.workspace_id AND target.id=link WHERE p.workspace_id=$1 AND p.id=$2
      UNION SELECT jsonb_array_elements_text(coalesce(data->'provenance'->'pageIds','[]'::jsonb)) FROM versions WHERE workspace_id=$1 AND page_id=$2
    ) d ORDER BY page_id LIMIT $3`,
        [o.workspace_id, pageId, maxPages + 1],
      )
    ).rows.map((r) => r.page_id as string);
    if (dependencies.length > maxPages)
      return unknown("LINEAGE_LIMIT_NEEDS_CHECK");
    for (const dep of dependencies) if (!seen.has(dep)) pending.push(dep);
  }
  if (!role)
    return !proof && grants.directory_role_possible
      ? unknown("CURRENT_IDENTITY_UNKNOWN")
      : lost("SPACE_ROLE_LOST");
  if (!proof) return unknown("CURRENT_IDENTITY_UNKNOWN");
  return { ownerStatus: "eligible", assessment: "CURRENT_IDENTITY_VERIFIED" };
}

async function outstandingWork(db: PoolClient, o: Owner) {
  const proposals = (
    await db.query(
      "SELECT b.id,count(*) OVER() AS total FROM batches b WHERE b.workspace_id=$1 AND b.data->>'status' IN ('pending','approved') AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.data->'updates') u WHERE u->>'id'=$2) ORDER BY b.id LIMIT 100",
      [o.workspace_id, o.page_id],
    )
  ).rows;
  const reviews = (
    await db.query(
      "SELECT a.batch_id,count(*) OVER() AS total FROM governance_review_assignments a JOIN batches b ON b.workspace_id=a.workspace_id AND b.id=a.batch_id WHERE a.workspace_id=$1 AND b.data->>'status' IN ('pending','approved') AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.data->'updates') u WHERE u->>'id'=$2) ORDER BY a.batch_id LIMIT 100",
      [o.workspace_id, o.page_id],
    )
  ).rows;
  const due = (
    await db.query(
      `SELECT w.data->>'reviewDue' AS explicit_due,coalesce(p.data->>'verifiedAt',v.at) AS reviewed_at,t.cadence_days
    FROM pages p LEFT JOIN workflow_document_state w ON w.workspace_id=p.workspace_id AND w.page_id=p.id
    LEFT JOIN LATERAL (SELECT data->>'at' AS at FROM versions WHERE workspace_id=p.workspace_id AND page_id=p.id ORDER BY number DESC LIMIT 1) v ON true
    LEFT JOIN LATERAL (SELECT cadence_days FROM governance_type_policies WHERE workspace_id=p.workspace_id AND document_type IN (coalesce(p.data->>'category','연결된 지식'),'*') ORDER BY (document_type='*') LIMIT 1) t ON true
    WHERE p.workspace_id=$1 AND p.id=$2`,
      [o.workspace_id, o.page_id],
    )
  ).rows[0];
  const cadenceDue = due?.cadence_days
    ? Date.parse(due.reviewed_at) + due.cadence_days * 86400000
    : NaN;
  return {
    proposalIds: proposals.map((r) => r.id),
    proposalCount: Number(proposals[0]?.total ?? 0),
    proposalsTruncated: Number(proposals[0]?.total ?? 0) > proposals.length,
    reviewBatchIds: reviews.map((r) => r.batch_id),
    reviewCount: Number(reviews[0]?.total ?? 0),
    reviewsTruncated: Number(reviews[0]?.total ?? 0) > reviews.length,
    reviewDue:
      due?.explicit_due ??
      (Number.isFinite(cadenceDue) ? new Date(cadenceDue).toISOString() : null),
  };
}

/** TRUSTED INTERNAL MAINTENANCE ENTRY POINT — never mount as HTTP/MCP.
 * No caller, session, directory authority or principal override is accepted.
 * Only metadata tasks/audits are written: no grants, publications, assignments,
 * directory projections or business-owner changes. Public inbox reads retain
 * their independent canonical authorizer and complete per-actor ACL filtering.
 *
 * The latest system scan event is a durable tuple cursor. A bounded seek/wrap
 * visits all workspaces across ticks/restarts, rather than rescanning the first N.
 */
export async function scanHandoffs(
  pool: Pool,
  options: HandoffScanOptions = {},
): Promise<HandoffScanResult> {
  const batchSize = options.batchSize ?? 25,
    maxPages = options.maxLineagePages ?? 100;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 200
  )
    throw Error("INVALID_MAINTENANCE_BOUND");
  const result: HandoffScanResult = {
    scanned: 0,
    queued: 0,
    unknown: 0,
    unavailable: 0,
    valid: 0,
    skipped: false,
  };
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='15s'");
    await acquireSharedMutationGate(db);
    if (
      !(
        await db.query("SELECT pg_try_advisory_xact_lock($1) AS locked", [
          SCANNER_LOCK,
        ])
      ).rows[0].locked
    ) {
      await db.query("ROLLBACK");
      return { ...result, skipped: true };
    }
    const cursor = (
      await db.query(
        "SELECT workspace_id,resource_id FROM governance_events WHERE kind=$1 AND actor_id=$2 ORDER BY id DESC LIMIT 1",
        [SCAN_OPERATION, SYSTEM_ACTOR],
      )
    ).rows[0];
    const select =
      "SELECT workspace_id,page_id,revision,owner_id,backup_id FROM governance_business_owners";
    let rows = (
      await db.query(
        `${select} WHERE (workspace_id,page_id)>($1,$2) ORDER BY workspace_id,page_id LIMIT $3`,
        [cursor?.workspace_id ?? "", cursor?.resource_id ?? "", batchSize],
      )
    ).rows as Owner[];
    if (!rows.length && cursor)
      rows = (
        await db.query(`${select} ORDER BY workspace_id,page_id LIMIT $1`, [
          batchSize,
        ])
      ).rows as Owner[];
    // Gate -> workspace rows in stable order -> assignment rows. Same order as application mutations.
    for (const workspaceId of [
      ...new Set(rows.map((r) => r.workspace_id)),
    ].sort())
      await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        workspaceId,
      ]);
    for (const selected of rows) {
      const o = (
        await db.query(
          "SELECT workspace_id,page_id,revision,owner_id,backup_id FROM governance_business_owners WHERE workspace_id=$1 AND page_id=$2 FOR UPDATE",
          [selected.workspace_id, selected.page_id],
        )
      ).rows[0] as Owner | undefined;
      if (!o) continue;
      const assessment = await assessOwner(db, o, maxPages);
      result.scanned++;
      if (assessment.ownerStatus === "eligible") result.valid++;
      else result[assessment.ownerStatus]++;
      let queued = false;
      if (assessment.ownerStatus !== "eligible") {
        const work = {
          ...(await outstandingWork(db, o)),
          ...assessment,
          workState:
            assessment.ownerStatus === "unknown"
              ? "needs-check"
              : "handoff-required",
          assessedAt: new Date().toISOString(),
        };
        const inserted = await db.query(
          "INSERT INTO governance_handoffs(workspace_id,page_id,owner_revision,owner_id,backup_id,work) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,page_id,owner_revision) DO UPDATE SET work=excluded.work RETURNING (xmax=0) AS inserted",
          [
            o.workspace_id,
            o.page_id,
            o.revision,
            o.owner_id,
            o.backup_id,
            work,
          ],
        );
        queued = inserted.rows[0].inserted;
        if (queued) result.queued++;
      }
      await db.query(
        "INSERT INTO governance_events(workspace_id,kind,resource_id,revision,actor_id,reason,data) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          o.workspace_id,
          SCAN_OPERATION,
          o.page_id,
          o.revision,
          SYSTEM_ACTOR,
          assessment.assessment,
          { systemActor: true, ...assessment, queued },
        ],
      );
      // Context-shaped audit descriptor ONLY: appendOperationalAudit records an actor hash;
      // it does not perform authorization or create a human/system principal.
      await appendOperationalAudit(
        db,
        { workspaceId: o.workspace_id, principalId: SYSTEM_ACTOR },
        {
          operation: SCAN_OPERATION,
          resource: { kind: "page", id: o.page_id },
        },
      );
    }
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
