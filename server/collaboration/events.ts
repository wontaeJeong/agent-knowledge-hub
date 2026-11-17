import type { PoolClient } from "pg";
import type { Context } from "../service";
import { loadState } from "../repository";
import { captureEnvelope, visiblePageIds, fingerprint } from "../provenance";
import { reviewNotificationDb } from "../publication";
import type { CollaborationHooks } from "./types";
type Row = Record<string, any>;
export const eventDenied = (e: unknown) =>
  e instanceof Error &&
  [
    "NOT_FOUND",
    "FORBIDDEN",
    "STALE_VERSION",
    "DOCUMENT_PROTECTED",
    "UNAUTHENTICATED",
    "RECIPIENT_DISABLED",
    "APPROVAL_STALE",
    "SOURCE_SCOPE_CONFLICT",
    "EVIDENCE_MISSING",
    "PROPERTY_REQUIRED",
    "OFFICIAL_REVIEW_REQUIRED",
  ].includes(e.message);
export async function subscriptionMatches(
  db: PoolClient,
  ctx: Context,
  pageIds: string[],
  createdAt?: Date | string,
) {
  const r = await db.query(
    `SELECT 1 FROM collaboration_subscriptions s WHERE s.workspace_id=$1 AND s.principal_id=$2 AND ($4::timestamptz IS NULL OR s.created_at<=$4) AND (s.scope='space' OR s.target IN (SELECT data->>'category' FROM pages WHERE workspace_id=$1 AND id=ANY($3::text[])))
 UNION ALL SELECT 1 FROM workflow_subscriptions WHERE workspace_id=$1 AND principal_id=$2 AND page_id=ANY($3::text[]) AND ($4::timestamptz IS NULL OR created_at<=$4) LIMIT 1`,
    [ctx.workspaceId, ctx.principalId, pageIds, createdAt ?? null],
  );
  return !!r.rowCount;
}
async function authorizedEnvelope(
  db: PoolClient,
  ctx: Context,
  state: Awaited<ReturnType<typeof loadState>>,
  pageIds: string[],
  sourceIds: string[],
  authorize: CollaborationHooks["authorize"],
) {
  const envelope = await captureEnvelope(db, ctx, state, pageIds, sourceIds);
  for (const id of envelope.pageIds)
    await authorize(db, ctx, "knowledge.read", { kind: "page", id });
  for (const id of envelope.sourceIds)
    await authorize(db, ctx, "knowledge.read", { kind: "source", id });
  return envelope;
}
export async function subscriptionsDb(
  db: PoolClient,
  ctx: Context,
  authorize: CollaborationHooks["authorize"],
) {
  const state = await loadState(db, ctx.workspaceId),
    visible = await visiblePageIds(db, ctx, state);
  const allowedTopics = new Set<string>();
  for (const page of state.pages) {
    if (!visible.has(page.id)) continue;
    try {
      await authorizedEnvelope(db, ctx, state, [page.id], [], authorize);
      allowedTopics.add(page.category);
    } catch (e) {
      if (!eventDenied(e)) throw e;
    }
  }
  const topics = [...allowedTopics].sort();
  const rows = (
    await db.query(
      "SELECT scope,target FROM collaboration_subscriptions WHERE workspace_id=$1 AND principal_id=$2 ORDER BY scope,target",
      [ctx.workspaceId, ctx.principalId],
    )
  ).rows;
  return {
    items: rows.filter((r) => r.scope === "space" || topics.includes(r.target)),
    topics,
  };
}
export interface EventContent {
  pageId: string;
  title: string;
  url: string;
  envelope: unknown;
}
/** Every fanout, in-app read, acknowledgement and final digest uses this gate.
 * Outbox rows contain only IDs; job inputs and review titles are not disclosed
 * until the recipient can read the entire originating context. */
export async function eventContentDb(
  db: PoolClient,
  ctx: Context,
  event: Row,
  hooks: CollaborationHooks,
  origin: string,
  now: Date,
): Promise<EventContent | null> {
  if (
    !(
      await db.query(
        "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
        [ctx.principalId],
      )
    ).rowCount
  )
    throw Error("RECIPIENT_DISABLED");
  await hooks.authorize(db, ctx, "knowledge.read");
  const state = await loadState(db, ctx.workspaceId),
    base = `${origin}/?app=1&space=${encodeURIComponent(ctx.workspaceId)}`;
  if (event.kind === "job-failure") {
    const job = (
      await db.query(
        "SELECT j.*,s.sponsor_id FROM durable_jobs j LEFT JOIN access_service_accounts s ON s.principal_id=j.principal_id WHERE j.workspace_id=$1 AND j.id=$2 AND j.status='dead' AND j.attempts::text=$3",
        [ctx.workspaceId, event.resource_id, event.revision],
      )
    ).rows[0];
    if (!job || ![job.principal_id, job.sponsor_id].includes(ctx.principalId))
      return null;
    const pageIds = [
        ...new Set<string>([
          ...(job.input.pageIds ?? []),
          ...(job.envelope.pageIds ?? []),
        ]),
      ],
      sourceIds = [
        ...new Set<string>([
          ...(job.input.sourceIds ?? []),
          ...(job.envelope.sourceIds ?? []),
        ]),
      ];
    for (const id of pageIds)
      await hooks.authorize(db, ctx, "knowledge.read", { kind: "page", id });
    for (const id of sourceIds)
      await hooks.authorize(db, ctx, "knowledge.read", { kind: "source", id });
    const envelope = await authorizedEnvelope(
      db,
      ctx,
      state,
      pageIds,
      sourceIds,
      hooks.authorize,
    );
    // Failure text is provider-controlled; publish only a fixed label and local link.
    return {
      pageId: `job:${job.id}`,
      title: "작업 실패",
      url: `${base}#jobs`,
      envelope: { envelope, jobId: job.id, attempts: job.attempts },
    };
  }
  if (event.kind === "change-review-request") {
    const batch = await reviewNotificationDb(
      db,
      ctx,
      event.resource_id,
      event.revision,
    );
    const ids = batch.updates.map((u) => u.id);
    if (!(await subscriptionMatches(db, ctx, ids))) return null;
    return {
      pageId: `batch:${batch.id}`,
      title: "변경 검토 요청",
      url: `${base}#review`,
      envelope: { hash: event.revision, batchId: batch.id },
    };
  }
  if (!(await subscriptionMatches(db, ctx, [event.page_id]))) return null;
  const page = state.pages.find((p) => p.id === event.page_id);
  if (!page) return null;
  const version = page.versions.find((v) => v.number === event.version);
  if (!version) return null;
  await hooks.authorize(db, ctx, "knowledge.read", {
    kind: "page",
    id: page.id,
    version: event.version,
  });
  for (const id of version.sourceIds)
    await hooks.authorize(db, ctx, "knowledge.read", { kind: "source", id });
  const envelope = await authorizedEnvelope(
    db,
    ctx,
    state,
    [page.id],
    version.sourceIds,
    hooks.authorize,
  );
  if (event.kind === "expiry") {
    const workflow = (
      await db.query(
        "SELECT state,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
        [ctx.workspaceId, page.id],
      )
    ).rows[0];
    if (
      !workflow ||
      workflow.state !== "active" ||
      workflow.data.effectiveUntil !== event.revision ||
      !Number.isFinite(Date.parse(event.revision)) ||
      Date.parse(event.revision) > +now
    )
      return null;
  }
  return {
    pageId: page.id,
    title: page.title.replace(/[\u0000-\u001f]/g, " ").slice(0, 300),
    url: `${base}&document=${encodeURIComponent(page.id)}`,
    envelope,
  };
}
export async function scanEventsDb(
  db: PoolClient,
  hooks: CollaborationHooks,
  origin: string,
  now: Date,
) {
  await hooks.assertDispatcher(db);
  // Invalid historical properties stay ineligible rather than crashing the worker.
  await db.query(
    `INSERT INTO collaboration_events(workspace_id,id,kind,page_id,version,resource_id,revision)
 SELECT w.workspace_id,'expiry:'||w.page_id||':'||md5(w.data->>'effectiveUntil'),'expiry',w.page_id,(SELECT max(number) FROM versions v WHERE v.workspace_id=w.workspace_id AND v.page_id=w.page_id),w.page_id,w.data->>'effectiveUntil'
 FROM workflow_document_state w WHERE w.state='active' AND CASE WHEN pg_input_is_valid(w.data->>'effectiveUntil','timestamptz') THEN (w.data->>'effectiveUntil')::timestamptz<=$1 ELSE false END ON CONFLICT DO NOTHING`,
    [now],
  );
  const events = (
    await db.query(
      // Old releases may have enqueued a private staged review. Defer it before
      // recipient checks so NOT_FOUND cannot permanently consume that event.
      `SELECT e.*,e.created_at::text AS subscription_cutoff FROM collaboration_events e
       WHERE e.projected_at IS NULL AND NOT EXISTS (
         SELECT 1 FROM batches b WHERE e.kind='change-review-request'
          AND b.workspace_id=e.workspace_id AND b.id=e.resource_id
          AND b.data->>'requestAuthorizationPending'='true'
       ) ORDER BY e.created_at,e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED`,
    )
  ).rows;
  let count = 0;
  for (const event of events) {
    // Current DB identity and canonical authorizer determine local recipients;
    // external directory/email proof is performed separately at digest dispatch.
    const recipients = (
      await db.query(
        `SELECT p.id FROM access_principals p WHERE p.active AND p.kind='human' AND p.id IN (
          SELECT principal_id FROM collaboration_subscriptions WHERE workspace_id=$1
          UNION SELECT principal_id FROM workflow_subscriptions WHERE workspace_id=$1
          UNION SELECT principal_id FROM durable_jobs WHERE workspace_id=$1 AND id=$2 AND $3='job-failure'
          UNION SELECT s.sponsor_id FROM durable_jobs j JOIN access_service_accounts s ON s.principal_id=j.principal_id WHERE j.workspace_id=$1 AND j.id=$2 AND $3='job-failure'
        )`,
        [event.workspace_id, event.resource_id, event.kind],
      )
    ).rows;
    for (const r of recipients) {
      const ctx = { workspaceId: event.workspace_id, principalId: r.id };
      const preferences =
        (
          await db.query(
            "SELECT data FROM workflow_preferences WHERE workspace_id=$1 AND principal_id=$2",
            [ctx.workspaceId, ctx.principalId],
          )
        ).rows[0]?.data ?? {};
      if (preferences.subscriptions === false && event.kind !== "job-failure")
        continue;
      try {
        if (event.kind !== "job-failure") {
          let ids = event.page_id ? [event.page_id] : [];
          if (event.kind === "change-review-request")
            ids = (
              (
                await db.query(
                  "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
                  [ctx.workspaceId, event.resource_id],
                )
              ).rows[0]?.data.updates ?? []
            ).map((u: Row) => u.id);
          if (
            !(await subscriptionMatches(
              db,
              ctx,
              ids,
              event.subscription_cutoff,
            ))
          )
            continue;
        }
        const content = await eventContentDb(
          db,
          ctx,
          event,
          hooks,
          origin,
          now,
        );
        if (!content) continue;
        const inserted = await db.query(
          "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
          [
            ctx.workspaceId,
            "event_" + fingerprint([event.id, ctx.principalId]),
            ctx.principalId,
            event.page_id,
            event.version,
            event.kind,
            { eventId: event.id },
            now,
          ],
        );
        count += inserted.rowCount ?? 0;
      } catch (e) {
        if (!eventDenied(e)) throw e;
      }
    }
    await db.query(
      "UPDATE collaboration_events SET projected_at=$3 WHERE workspace_id=$1 AND id=$2",
      [event.workspace_id, event.id, now],
    );
  }
  return count;
}
