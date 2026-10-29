import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Context } from "./service";
import type { Batch, Draft } from "../src/domain/wiki";
import {
  createBatch,
  decideBatch,
  enqueueBatch,
  memory,
} from "../src/domain/wiki";
import { transaction } from "./database";
import {
  addResource,
  audit,
  loadState,
  membership,
  readers,
  requireRead,
} from "./repository";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const batchHash = ({
  status: _s,
  approvedFingerprint: _f,
  ...content
}: Batch) => digest(content);

async function permissions(
  db: PoolClient,
  ctx: Context,
  updates: Draft[],
  sourceIds: string[],
) {
  const allSources = [
    ...new Set([...sourceIds, ...updates.flatMap((d) => d.sourceIds)]),
  ];
  for (const id of allSources) await requireRead(db, ctx, "source", id);
  const audiences = new Map<string, string[]>();
  for (const d of updates) {
    const sourceAudiences = await Promise.all(
      d.sourceIds.map((id) => readers(db, ctx.workspaceId, "source", id)),
    );
    const intersection =
      sourceAudiences[0]?.filter((who) =>
        sourceAudiences.every((a) => a.includes(who)),
      ) ?? [];
    const exists = await db.query(
      "SELECT id FROM pages WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, d.id],
    );
    if (exists.rowCount) {
      await requireRead(db, ctx, "page", d.id);
      const audience = await readers(db, ctx.workspaceId, "page", d.id);
      if (audience.some((p) => !intersection.includes(p)))
        throw Error("SOURCE_SCOPE_CONFLICT");
      audiences.set(d.id, audience);
    } else audiences.set(d.id, intersection);
    if (!intersection.includes(ctx.principalId)) throw Error("NOT_FOUND");
  }
  for (const d of updates) {
    for (const link of d.links) {
      const audience =
        audiences.get(link) ??
        (await readers(db, ctx.workspaceId, "page", link));
      if (!audience.includes(ctx.principalId)) throw Error("NOT_FOUND");
      if (audiences.get(d.id)!.some((p) => !audience.includes(p)))
        throw Error("SOURCE_SCOPE_CONFLICT");
    }
  }
  return audiences;
}

export async function propose(
  pool: Pool,
  ctx: Context,
  updates: Draft[],
  sourceIds: string[],
) {
  return transaction(
    pool,
    ctx.workspaceId,
    async (db) => {
      if ((await membership(db, ctx)) === "reader") throw Error("FORBIDDEN");
      await permissions(db, ctx, updates, sourceIds);
      const state = await loadState(db, ctx.workspaceId);
      let batch: Batch;
      try {
        batch = createBatch(state, updates, sourceIds, "offline");
        enqueueBatch(state, batch);
      } catch {
        throw Error("VALIDATION_FAILED");
      }
      const hash = batchHash(batch);
      await db.query("INSERT INTO batches VALUES($1,$2,$3,$4)", [
        ctx.workspaceId,
        batch.id,
        batch,
        hash,
      ]);
      await audit(db, ctx, "batch.propose", batch.id);
      return { id: batch.id, hash };
    },
    { principalId: ctx.principalId, operation: "batch.propose" },
  );
}

async function checkedBatch(
  db: PoolClient,
  ctx: Context,
  id: string,
  hash: string,
) {
  if ((await membership(db, ctx)) !== "reviewer") throw Error("FORBIDDEN");
  const r = await db.query(
    "SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId, id],
  );
  if (!r.rowCount) throw Error("NOT_FOUND");
  const batch = r.rows[0].data as Batch;
  await permissions(
    db,
    ctx,
    batch.updates,
    batch.snapshots.map((s) => s.id),
  );
  if (hash !== r.rows[0].hash || hash !== batchHash(batch))
    throw Error("APPROVAL_STALE");
  return batch;
}

export async function approve(
  pool: Pool,
  ctx: Context,
  id: string,
  hash: string,
) {
  return transaction(
    pool,
    ctx.workspaceId,
    async (db) => {
      await checkedBatch(db, ctx, id, hash);
      const state = await loadState(db, ctx.workspaceId);
      let batch: Batch;
      try {
        batch = memory(decideBatch(state, id, "approve")).batches.find(
          (b) => b.id === id,
        )!;
      } catch {
        throw Error("APPROVAL_STALE");
      }
      if (batch.status !== "approved") throw Error("STALE_VERSION");
      await db.query(
        "UPDATE batches SET data=$3 WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id, batch],
      );
      await db.query(
        "INSERT INTO approvals(workspace_id,batch_id,principal_id,hash) VALUES($1,$2,$3,$4)",
        [ctx.workspaceId, id, ctx.principalId, hash],
      );
      await audit(db, ctx, "batch.approve", id);
    },
    { principalId: ctx.principalId, operation: "batch.approve" },
  );
}

export async function publish(
  pool: Pool,
  ctx: Context,
  id: string,
  hash: string,
  key: string,
): Promise<{ batchId: string; versions: Record<string, number> }> {
  return transaction(
    pool,
    ctx.workspaceId,
    async (db) => {
      if (!key.trim() || key.length > 200) throw Error("VALIDATION_FAILED");
      const batch = await checkedBatch(db, ctx, id, hash);
      const requestHash = digest([id, hash]);
      const replay = await db.query(
        "SELECT hash,result FROM requests WHERE workspace_id=$1 AND principal_id=$2 AND key=$3",
        [ctx.workspaceId, ctx.principalId, key],
      );
      if (replay.rowCount) {
        if (replay.rows[0].hash !== requestHash)
          throw Error("IDEMPOTENCY_CONFLICT");
        return replay.rows[0].result;
      }
      const receipt = await db.query(
        "SELECT result FROM publications WHERE workspace_id=$1 AND batch_id=$2",
        [ctx.workspaceId, id],
      );
      let result: { batchId: string; versions: Record<string, number> };
      if (receipt.rowCount) result = receipt.rows[0].result;
      else {
        const approval = await db.query(
          "SELECT hash FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
          [ctx.workspaceId, id],
        );
        if (!approval.rowCount || approval.rows[0].hash !== hash)
          throw Error("APPROVAL_STALE");
        const audiences = await permissions(
          db,
          ctx,
          batch.updates,
          batch.snapshots.map((s) => s.id),
        );
        const state = await loadState(db, ctx.workspaceId);
        let next;
        try {
          next = decideBatch(state, id, "publish");
        } catch {
          throw Error("APPROVAL_STALE");
        }
        const published = memory(next).batches.find((b) => b.id === id)!;
        if (published.status !== "published") throw Error("STALE_VERSION");
        const versions: Record<string, number> = {};
        for (const d of batch.updates) {
          const p = next.pages.find((p) => p.id === d.id)!;
          const { versions: history, ...metadata } = p;
          const v = { ...history.at(-1)!, author: ctx.principalId };
          if (d.baseVersion === 0)
            await addResource(
              db,
              ctx.workspaceId,
              "page",
              d.id,
              audiences.get(d.id)!,
            );
          await db.query(
            "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3) ON CONFLICT(workspace_id,id) DO UPDATE SET data=excluded.data",
            [ctx.workspaceId, d.id, metadata],
          );
          await db.query("INSERT INTO versions VALUES($1,$2,$3,$4)", [
            ctx.workspaceId,
            d.id,
            v.number,
            v,
          ]);
          versions[d.id] = v.number;
        }
        // Source bodies remain unchanged; processing state is separate from the immutable input.
        await db.query(
          "UPDATE batches SET data=$3 WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, id, published],
        );
        result = { batchId: id, versions };
        await db.query("INSERT INTO publications VALUES($1,$2,$3)", [
          ctx.workspaceId,
          id,
          result,
        ]);
        await audit(db, ctx, "batch.publish", id);
      }
      await db.query("INSERT INTO requests VALUES($1,$2,$3,$4,$5)", [
        ctx.workspaceId,
        ctx.principalId,
        key,
        requestHash,
        result,
      ]);
      return result;
    },
    { principalId: ctx.principalId, operation: "batch.publish" },
  );
}
