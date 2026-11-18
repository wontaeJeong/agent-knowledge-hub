import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  normalizeSearchFilters,
  searchFilters,
} from "../../src/domain/search-filters";
import { authorizeActionDb } from "../access";
import { assertProductWritesNotErased } from "../operations/product-erasure";
import { transaction } from "../database";
import { fingerprint } from "../provenance";
import type { Context } from "../service";

const revision = z.number().int().min(1);
const mutation = z
  .object({ expectedRevision: revision, mutationId: z.uuid() })
  .strict();
const definition = mutation.extend({
  name: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Array.from(value).length <= 100),
  filters: searchFilters.refine((f) => f.cursor === undefined),
  sort: z.enum(["recent", "title"]),
});
const create = definition.extend({ expectedRevision: z.literal(0) });
const move = mutation.extend({
  direction: z.enum(["up", "down"]),
  neighborId: z.uuid(),
  neighborRevision: revision,
});
const select = `SELECT id,workspace_id AS "workspaceId",owner_id AS "ownerId",name,filters,
  filters->>'sort' AS sort,position,revision FROM personal_saved_views WHERE workspace_id=$1 AND owner_id=$2`;
export class SavedViewService {
  constructor(private readonly pool: Pool) {}
  private async authorized<T>(
    ctx: Context,
    work: (db: PoolClient, scope: string[]) => Promise<T>,
  ) {
    if (ctx.credentialId || ctx.agent) throw Error("FORBIDDEN");
    await ctx.authorization?.revalidate();
    const value = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await authorizeActionDb(db, ctx, "knowledge.read");
      await assertProductWritesNotErased(db, ctx.workspaceId, "");
      return work(db, [ctx.workspaceId, ctx.principalId]);
    });
    await ctx.authorization?.revalidate();
    return value;
  }
  list(ctx: Context) {
    return this.authorized(ctx, async (db, scope) => ({
      items: (await db.query(select + " ORDER BY position,id", scope)).rows,
    }));
  }
  read(ctx: Context, id: string) {
    return this.authorized(ctx, async (db, scope) => {
      const view = (await db.query(select + " AND id=$3", [...scope, id]))
        .rows[0];
      if (!view) throw Error("NOT_FOUND");
      return view;
    });
  }
  save(ctx: Context, raw: unknown) {
    const { id, ...input } = z
      .object({ id: z.uuid().optional() })
      .loose()
      .parse(raw);
    return this.mutate(ctx, id ? "edit" : "create", id, input);
  }
  remove(ctx: Context, id: string, input: unknown) {
    return this.mutate(ctx, "delete", id, input);
  }
  private mutate(
    ctx: Context,
    operation: "create" | "edit" | "delete",
    id: string | undefined,
    input: unknown,
  ) {
    const command =
      operation === "create"
        ? { kind: "define" as const, data: create.parse(input) }
        : operation === "delete"
          ? { kind: "delete" as const, data: mutation.parse(input) }
          : z
              .union([
                definition.transform((data) => ({
                  kind: "define" as const,
                  data,
                })),
                move.transform((data) => ({ kind: "move" as const, data })),
              ])
              .parse(input);
    const { data } = command;
    return this.authorized(ctx, async (db, scope) => {
      const hash = fingerprint({ operation, id, data });
      const replay = (
        await db.query(
          "SELECT payload_hash,view_id AS id,revision FROM personal_saved_view_mutations WHERE workspace_id=$1 AND owner_id=$2 AND mutation_id=$3",
          [...scope, data.mutationId],
        )
      ).rows[0];
      if (replay) {
        if (replay.payload_hash !== hash) throw Error("STALE_VERSION");
        return { id: replay.id as string, revision: replay.revision as number };
      }
      const rows = (
        await db.query(
          "SELECT id,position,revision FROM personal_saved_views WHERE workspace_id=$1 AND owner_id=$2 ORDER BY position,id",
          scope,
        )
      ).rows;
      const index = rows.findIndex((view) => view.id === id);
      if (id && index < 0) throw Error("NOT_FOUND");
      const previous = rows[index];
      if (previous && previous.revision !== data.expectedRevision)
        throw Error("STALE_VERSION");
      // Free text has no provable resource lineage. Preserve existing definitions
      // while any material in this space is under legal hold.
      if (
        id &&
        command.kind !== "move" &&
        (
          await db.query(
            "SELECT 1 FROM operations_legal_holds WHERE workspace_id=$1 AND active LIMIT 1",
            [ctx.workspaceId],
          )
        ).rowCount
      )
        throw Error("LEGAL_HOLD");
      const viewId = id ?? randomUUID(),
        nextRevision = data.expectedRevision + 1;
      if (command.kind === "delete") {
        await db.query(
          "DELETE FROM personal_saved_views WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [...scope, viewId],
        );
        await db.query(
          "UPDATE personal_saved_views SET position=position-1 WHERE workspace_id=$1 AND owner_id=$2 AND position>$3",
          [...scope, previous.position],
        );
      } else if (command.kind === "move") {
        const data = command.data;
        const neighbor = rows[index + (data.direction === "up" ? -1 : 1)];
        if (
          !neighbor ||
          neighbor.id !== data.neighborId ||
          neighbor.revision !== data.neighborRevision
        )
          throw Error("STALE_VERSION");
        await db.query(
          "UPDATE personal_saved_views SET position=CASE WHEN id=$3 THEN $5::integer ELSE $6::integer END, revision=revision+1 WHERE workspace_id=$1 AND owner_id=$2 AND id IN ($3,$4)",
          [...scope, viewId, neighbor.id, neighbor.position, previous.position],
        );
      } else {
        const data = command.data;
        const filters = normalizeSearchFilters({
          ...data.filters,
          sort: data.sort,
        });
        if (!id) {
          if (rows.length >= 100) throw Error("SAVED_VIEW_CAPACITY");
          await db.query(
            "INSERT INTO personal_saved_views(workspace_id,owner_id,id,name,filters,position,revision) VALUES($1,$2,$3,$4,$5,$6,1)",
            [
              ...scope,
              viewId,
              data.name,
              filters,
              (rows.at(-1)?.position ?? -1) + 1,
            ],
          );
        } else {
          await db.query(
            "UPDATE personal_saved_views SET name=$4,filters=$5,revision=revision+1 WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
            [...scope, viewId, data.name, filters],
          );
        }
      }
      await db.query(
        `INSERT INTO personal_saved_view_mutations
          (workspace_id,owner_id,mutation_id,payload_hash,view_id,revision,operation,applied_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
        [
          ...scope,
          data.mutationId,
          hash,
          viewId,
          nextRevision,
          command.kind === "move" ? "move" : operation,
        ],
      );
      return { id: viewId, revision: nextRevision };
    });
  }
}
