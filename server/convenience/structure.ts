import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { OidcAuth } from "../runtime/auth";
import type { InteractiveSessionSnapshot } from "../jobs/identity";
import { fingerprint } from "../provenance";
import { recordAccessAudit } from "../access/index";
import { z } from "zod";
import type { Context } from "../service";
import type { WorkflowService } from "../workflows/service";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const structureQuery = z
  .object({
    parentId: id.nullable().default(null),
    cursor: z.string().max(4096).nullable().optional(),
    limit: z.number().int().min(1).max(25).default(25),
  })
  .strict();
export const structureMoveSchema = z
  .object({
    pageId: id,
    parentId: id.nullable(),
    beforeId: id.nullable().default(null),
    expectedRevision: z.number().int().min(0),
    expectedStructureRevision: z.string().max(4096).optional(),
    mutationId: z.string().uuid(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const duplicateSchema = z
  .object({
    pageId: id,
    version: z.number().int().positive(),
    parentId: id.nullable(),
    mutationId: z.string().uuid(),
  })
  .strict();
export interface StructureNode {
  id: string;
  title: string;
  version: number;
  revision: number;
  hasChildren: boolean;
}
/** Transport narrowing only; this never grants a capability or returns an elevated context. */
export async function structureCredentialOperation(db: Pick<PoolClient,"query">,ctx: Context): Promise<"move"|"duplicate"|null> {
  if(!ctx.credentialId)return null;
  const row=(await db.query("SELECT actions FROM access_credentials WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 AND NOT revoked AND expires_at>clock_timestamp()",[ctx.credentialId,ctx.principalId,ctx.workspaceId])).rows[0];
  if(!row)throw Error("UNAUTHENTICATED");
  if(row.actions[0]!=="c7.operation.v1")return null;
  if(row.actions.length!==5 || !["move","duplicate"].includes(row.actions[1]))throw Error("FORBIDDEN");
  return row.actions[1];
}
/** All reads/writes share the canonical workflow authorization, gate and transaction. */
export class DocumentStructureService {
  constructor(
    readonly workflows: WorkflowService,
    private readonly identity?: Pick<
      OidcAuth,
      "revalidateInteractiveGrant" | "assertInteractiveGrant"
    >,
  ) {}
  async issueCredential(ctx: Context, input: unknown) {
    if (
      ctx.credentialId ||
      ctx.agent ||
      !ctx.authorization?.sessionId ||
      !this.identity
    )
      throw Error("FORBIDDEN");
    const b = z
      .discriminatedUnion("operation", [
        z
          .object({
            operation: z.literal("move"),
            input: structureMoveSchema,
            expiresAt: z.iso.datetime(),
          })
          .strict(),
        z
          .object({
            operation: z.literal("duplicate"),
            input: duplicateSchema,
            expiresAt: z.iso.datetime(),
          })
          .strict(),
      ])
      .parse(input);
    if (
      Date.parse(b.expiresAt) <= Date.now() ||
      Date.parse(b.expiresAt) > Date.now() + 900000
    )
      throw Error("VALIDATION_FAILED");
    const sessionId = ctx.authorization.sessionId;
    const snapshot = await this.identity.revalidateInteractiveGrant({
      sessionId,
      workspaceId: ctx.workspaceId,
      principalId: ctx.principalId,
    });
    return this.workflows.authorizeStructureGrant(
      ctx,
      b.operation,
      b.input,
      async (db) => {
        await this.identity!.assertInteractiveGrant(db, {
          sessionId,
          workspaceId: ctx.workspaceId,
          principalId: ctx.principalId,
          snapshot,
        });
        const id = randomUUID(),
          secret = `akh_${randomBytes(32).toString("base64url")}`;
        const actions = [
          "c7.operation.v1",
          b.operation,
          fingerprint(b.input),
          sessionId,
          JSON.stringify(snapshot),
        ];
        await db.query(
          "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            createHash("sha256").update(secret).digest("hex"),
            ctx.principalId,
            ctx.workspaceId,
            actions,
            b.expiresAt,
          ],
        );
        await recordAccessAudit(db, ctx, "credential.c7.issue", id, {
          operation: b.operation,
          pageId: b.input.pageId,
          parentId: b.input.parentId,
          expiresAt: b.expiresAt,
        });
        return {
          id,
          secret,
          spaceId: ctx.workspaceId,
          operation: b.operation,
          expiresAt: b.expiresAt,
        };
      },
    );
  }
  /** The elevated interactive context is confined to this exact C7 dispatch. */
  private async dispatch(
    ctx: Context,
    operation: "move" | "duplicate",
    input: unknown,
  ) {
    const d =
      operation === "move"
        ? structureMoveSchema.parse(input)
        : duplicateSchema.parse(input);
    const invoke = (current: Context) =>
      operation === "move"
        ? this.workflows.moveDocument(current, d)
        : this.workflows.duplicateDocument(current, d);
    if (!ctx.credentialId) return invoke(ctx);
    if (ctx.agent || !this.identity) throw Error("FORBIDDEN");
    const read = async (db: Pick<PoolClient, "query">, lock = false) => {
      const row = (
        await db.query(
          `SELECT actions FROM access_credentials WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 AND NOT revoked AND expires_at>clock_timestamp()${lock ? " FOR SHARE" : ""}`,
          [ctx.credentialId, ctx.principalId, ctx.workspaceId],
        )
      ).rows[0];
      if (
        !row ||
        row.actions.length !== 5 ||
        row.actions[0] !== "c7.operation.v1" ||
        row.actions[1] !== operation ||
        row.actions[2] !== fingerprint(d)
      )
        throw Error("FORBIDDEN");
      return row.actions as string[];
    };
    const original = await read(this.workflows.pool);
    const snapshot = JSON.parse(original[4]) as InteractiveSessionSnapshot;
    const binding = {
      sessionId: original[3],
      workspaceId: ctx.workspaceId,
      principalId: ctx.principalId,
      snapshot,
    };
    const current: Context = {
      workspaceId: ctx.workspaceId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      authorization: {
        sessionId: binding.sessionId,
        revalidate: async () => {
          if (
            JSON.stringify(await read(this.workflows.pool)) !==
            JSON.stringify(original)
          )
            throw Error("FORBIDDEN");
          await this.identity!.revalidateInteractiveGrant(binding);
        },
        assertSession: async (db) => {
          if (JSON.stringify(await read(db, true)) !== JSON.stringify(original))
            throw Error("FORBIDDEN");
          await this.identity!.assertInteractiveGrant(db, binding);
        },
      },
    };
    return invoke(current);
  }
  children(
    ctx: Context,
    input: { parentId?: string | null; cursor?: string | null; limit?: number },
  ) {
    return this.workflows.structureChildren(ctx, input);
  }
  path(ctx: Context, pageId: string) {
    return this.workflows.structurePath(ctx, pageId);
  }
  move(ctx: Context, input: unknown) {
    return this.dispatch(ctx, "move", input);
  }
  duplicateToDraft(ctx: Context, input: unknown) {
    return this.dispatch(ctx, "duplicate", input);
  }
}
