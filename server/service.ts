import type { Pool } from "pg";
import type { Source } from "../src/domain/types";
import type { Draft } from "../src/domain/wiki";
import { transaction } from "./database";
import { addResource, audit, membership, requireRead } from "./repository";
import * as publication from "./publication";

export interface Context {
  workspaceId: string;
  principalId: string;
}
export class KnowledgeService {
  constructor(readonly pool: Pool) {}
  propose(ctx: Context, updates: Draft[], sourceIds: string[]) {
    return publication.propose(this.pool, ctx, updates, sourceIds);
  }
  approve(ctx: Context, id: string, hash: string) {
    return publication.approve(this.pool, ctx, id, hash);
  }
  publish(ctx: Context, id: string, hash: string, key: string) {
    return publication.publish(this.pool, ctx, id, hash, key);
  }
  async registerSource(
    ctx: Context,
    source: Source,
    readers: string[],
  ): Promise<void> {
    return transaction(
      this.pool,
      ctx.workspaceId,
      async (db) => {
        if ((await membership(db, ctx)) === "reader") throw Error("FORBIDDEN");
        const members = await db.query(
          "SELECT principal_id FROM memberships WHERE workspace_id=$1 FOR SHARE",
          [ctx.workspaceId],
        );
        const allowed = new Set(members.rows.map((m) => m.principal_id));
        if (
          !readers.length ||
          !readers.includes(ctx.principalId) ||
          readers.some((p) => !allowed.has(p)) ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(source.id) ||
          !source.title?.trim() ||
          !source.content?.trim() ||
          source.content.length > 100_000 ||
          !["team", "company", "private"].includes(source.scope) ||
          source.processed !== false
        )
          throw Error("VALIDATION_FAILED");
        const exists = await db.query(
          "SELECT id FROM sources WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, source.id],
        );
        if (exists.rowCount) throw Error("ALREADY_EXISTS");
        await addResource(db, ctx.workspaceId, "source", source.id, [
          ...new Set(readers),
        ]);
        await db.query(
          "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
          [ctx.workspaceId, source.id, source],
        );
        await audit(db, ctx, "source.register", source.id);
      },
      { principalId: ctx.principalId, operation: "source.register" },
    );
  }
  async readPage(ctx: Context, id: string, version?: number) {
    return transaction(
      this.pool,
      ctx.workspaceId,
      async (db) => {
        await membership(db, ctx);
        await requireRead(db, ctx, "page", id);
        const p = await db.query(
          "SELECT data FROM pages WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, id],
        );
        const v = await db.query(
          "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 AND ($3::integer IS NULL OR number=$3) ORDER BY number DESC LIMIT 1",
          [ctx.workspaceId, id, version ?? null],
        );
        if (!p.rowCount || !v.rowCount) throw Error("NOT_FOUND");
        // Current titles must not leak through an older, otherwise readable version.
        const latest = await db.query(
          "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number DESC LIMIT 1",
          [ctx.workspaceId, id],
        );
        for (const sourceId of latest.rows[0].data.sourceIds)
          await requireRead(db, ctx, "source", sourceId);
        for (const sourceId of v.rows[0].data.sourceIds)
          await requireRead(db, ctx, "source", sourceId);
        const visited = new Set<string>([id]);
        const pending: string[] = [...(p.rows[0].data.links ?? [])];
        while (pending.length) {
          const link = pending.pop()!;
          if (visited.has(link)) continue;
          visited.add(link);
          const target = await db.query(
            "SELECT data FROM pages WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, link],
          );
          if (!target.rowCount) continue;
          await requireRead(db, ctx, "page", link);
          const latestTarget = await db.query(
            "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number DESC LIMIT 1",
            [ctx.workspaceId, link],
          );
          if (!latestTarget.rowCount) throw Error("NOT_FOUND");
          for (const sourceId of latestTarget.rows[0].data.sourceIds)
            await requireRead(db, ctx, "source", sourceId);
          pending.push(...(target.rows[0].data.links ?? []));
        }
        return {
          id,
          title: p.rows[0].data.title as string,
          version: v.rows[0].data,
        };
      },
      { principalId: ctx.principalId, operation: "page.read" },
    );
  }
}
