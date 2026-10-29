import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Context } from "./service";
import type { Batch, Draft } from "../src/domain/wiki";
import {
  createBatch,
  decideBatch,
  enqueueBatch,
  memory,
  current,
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
type RuntimeBatch = Batch & { contextDependencyIds?: string[] };

async function permissions(
  db: PoolClient,
  ctx: Context,
  updates: Draft[],
  sourceIds: string[],
  dependencyIds: string[] = [],
) {
  const acl: Record<string, unknown> = {};
  const audienceOf = async (kind: string, id: string) => {
    const list = (await readers(db, ctx.workspaceId, kind, id)).sort();
    acl[`${kind}:${id}`] = list;
    return list;
  };
  const allSources = [
    ...new Set([...sourceIds, ...updates.flatMap((d) => d.sourceIds)]),
  ];
  for (const id of allSources) {
    if (!(await audienceOf("source", id)).includes(ctx.principalId))
      throw Error("NOT_FOUND");
  }
  const audiences = new Map<string, string[]>();
  for (const d of updates) {
    const sourceAudiences = await Promise.all(
      d.sourceIds.map((id) => audienceOf("source", id)),
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
      const audience = await audienceOf("page", d.id);
      if (audience.some((p) => !intersection.includes(p)))
        throw Error("SOURCE_SCOPE_CONFLICT");
      audiences.set(d.id, audience);
    } else audiences.set(d.id, intersection);
    if (!intersection.includes(ctx.principalId)) throw Error("NOT_FOUND");
  }
  for (const d of updates) {
    for (const link of d.links) {
      let audience = audiences.get(link);
      if (!audience) {
        audience = await audienceOf("page", link);
        const target = await db.query(
          "SELECT data,number FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number DESC LIMIT 1",
          [ctx.workspaceId, link],
        );
        if (!target.rowCount) throw Error("NOT_FOUND");
        acl[`dependency:${link}`] = target.rows[0].number;
        for (const sourceId of target.rows[0].data.sourceIds) {
          const sourceAudience = await audienceOf("source", sourceId);
          audience = audience.filter((p) => sourceAudience.includes(p));
        }
      }
      if (!audience.includes(ctx.principalId)) throw Error("NOT_FOUND");
      if (audiences.get(d.id)!.some((p) => !audience.includes(p)))
        throw Error("SOURCE_SCOPE_CONFLICT");
    }
  }
  for (const id of dependencyIds) {
    const dependencyAudience = await audienceOf("page", id);
    if (!dependencyAudience.includes(ctx.principalId)) throw Error("NOT_FOUND");
    const r = await db.query(
      "SELECT data,number FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number DESC LIMIT 1",
      [ctx.workspaceId, id],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    acl[`dependency:${id}`] = r.rows[0].number;
    let effective = dependencyAudience;
    for (const sourceId of r.rows[0].data.sourceIds) {
      const a = await audienceOf("source", sourceId);
      effective = effective.filter((p) => a.includes(p));
    }
    if (!effective.includes(ctx.principalId)) throw Error("NOT_FOUND");
    for (const audience of audiences.values())
      if (audience.some((p) => !effective.includes(p)))
        throw Error("SOURCE_SCOPE_CONFLICT");
  }
  return { audiences, hash: digest(acl) };
}

export async function propose(
  pool: Pool,
  ctx: Context,
  updates: Draft[],
  sourceIds: string[],
  options?: {
    expectedStateHash?: string;
    mode?: "offline" | "model";
    dependencyIds?: string[];
    answerId?: string;
  },
) {
  return transaction(
    pool,
    ctx.workspaceId,
    async (db) => {
      if ((await membership(db, ctx)) === "reader") throw Error("FORBIDDEN");
      await permissions(db, ctx, updates, sourceIds, options?.dependencyIds);
      const state = await loadState(db, ctx.workspaceId);
      if (
        options?.expectedStateHash &&
        digest(state) !== options.expectedStateHash
      )
        throw Error("STALE_VERSION");
      let batch: Batch;
      try {
        batch = createBatch(
          state,
          updates,
          sourceIds,
          options?.mode ?? "offline",
        );
        for (const id of options?.dependencyIds ?? []) {
          const p = state.pages.find((p) => p.id === id);
          if (!p) throw Error("NOT_FOUND");
          batch.baseSnapshots[id] = JSON.stringify([
            p.title,
            p.summary,
            p.scope,
            p.links,
            p.facts,
            current(p),
          ]);
        }
        if (options?.answerId) batch.answerId = options.answerId;
        if (options?.dependencyIds)
          (batch as RuntimeBatch).contextDependencyIds = options.dependencyIds;
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
    (batch as RuntimeBatch).contextDependencyIds,
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
      const permissionSnapshot = await permissions(
        db,
        ctx,
        batch.updates,
        batch.snapshots.map((s) => s.id),
        (batch as RuntimeBatch).contextDependencyIds,
      );
      await db.query(
        "UPDATE batches SET data=$3 WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id, batch],
      );
      await db.query(
        "INSERT INTO approvals(workspace_id,batch_id,principal_id,hash,acl_hash) VALUES($1,$2,$3,$4,$5)",
        [ctx.workspaceId, id, ctx.principalId, hash, permissionSnapshot.hash],
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
          "SELECT hash,acl_hash FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
          [ctx.workspaceId, id],
        );
        if (!approval.rowCount || approval.rows[0].hash !== hash)
          throw Error("APPROVAL_STALE");
        const permissionSnapshot = await permissions(
          db,
          ctx,
          batch.updates,
          batch.snapshots.map((s) => s.id),
          (batch as RuntimeBatch).contextDependencyIds,
        );
        if (permissionSnapshot.hash !== approval.rows[0].acl_hash)
          throw Error("APPROVAL_STALE");
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
              permissionSnapshot.audiences.get(d.id)!,
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
