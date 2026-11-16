import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Context } from "../service";
import type { WorkflowService } from "./service";
import { transaction } from "../database";
import { membership } from "../repository";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const operation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tags"),
      tags: z.array(z.string().trim().min(1).max(100)).max(30),
    })
    .strict(),
  z.object({ kind: z.literal("move"), parentId: id.nullable() }).strict(),
  z.object({ kind: z.literal("archive") }).strict(),
]);
const input = z
  .object({
    pageIds: z
      .array(id)
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length),
    operation,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
const change = z.record(z.string(), z.unknown());
const item = z
  .object({
    id,
    status: z.enum(["ready", "unavailable"]),
    expectedRevision: z.number().int().nonnegative().optional(),
    patch: change.optional(),
  })
  .strict();
const sealed = z
  .object({
    workspaceId: id,
    principalId: z.string(),
    credentialId: z.string().nullable(),
    expires: z.number(),
    reason: z.string(),
    items: z.array(item).max(50),
  })
  .strict();
const secret = randomBytes(32);
const sign = (body: string) =>
  createHmac("sha256", secret).update(body).digest();
function decode(token: string, ctx: Context) {
  try {
    const [body, mac, ...extra] = token.split(".");
    const actual = Buffer.from(mac ?? "", "base64url"),
      expected = sign(body);
    if (
      extra.length ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw Error();
    const value = sealed.parse(
      JSON.parse(Buffer.from(body, "base64url").toString()),
    );
    if (
      value.workspaceId !== ctx.workspaceId ||
      value.principalId !== ctx.principalId ||
      value.credentialId !== (ctx.credentialId ?? null) ||
      value.expires < Date.now()
    )
      throw Error();
    return value;
  } catch {
    throw Error("INVALID_BULK_PREVIEW");
  }
}
export async function bulkPreview(
  service: WorkflowService,
  ctx: Context,
  raw: unknown,
) {
  const d = input.parse(raw),
    items: z.infer<typeof item>[] = [];
  for (const pageId of d.pageIds) {
    try {
      await ctx.authorization?.revalidate();
      await transaction(service.pool, ctx.workspaceId, async (db) => {
        await membership(db, ctx);
        await ctx.authorization?.assertSession(db);
        await service.authorize(
          db,
          ctx,
          d.operation.kind === "archive"
            ? "lifecycle.manage"
            : "knowledge.protect",
          { kind: "page", id: pageId },
        );
      });
      const doc = await service.document(ctx, pageId);
      let patch: Record<string, unknown>;
      if (d.operation.kind === "archive") patch = { state: "archived" };
      else if (d.operation.kind === "move") {
        if (d.operation.parentId === pageId) throw Error("VALIDATION_FAILED");
        let ancestor = d.operation.parentId;
        const seen = new Set([pageId]);
        while (ancestor) {
          if (seen.has(ancestor)) throw Error("VALIDATION_FAILED");
          seen.add(ancestor);
          const parent = await service.document(ctx, ancestor);
          ancestor = parent.settings.parent_id;
        }
        patch = { parentId: d.operation.parentId };
      } else
        patch = {
          properties: {
            ...(doc.settings.data?.properties ?? {}),
            tags: [...new Set(d.operation.tags)].join(", "),
          },
        };
      items.push({
        id: pageId,
        status: "ready",
        expectedRevision: doc.settings.revision,
        patch,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        ["NOT_FOUND", "FORBIDDEN", "VALIDATION_FAILED"].includes(e.message)
      )
        items.push({ id: pageId, status: "unavailable" });
      else throw e;
    }
  }
  const data = {
    workspaceId: ctx.workspaceId,
    principalId: ctx.principalId,
    credentialId: ctx.credentialId ?? null,
    expires: Date.now() + 10 * 60_000,
    reason: d.reason,
    items,
  };
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  return {
    items,
    expiresAt: new Date(data.expires).toISOString(),
    token: body + "." + sign(body).toString("base64url"),
  };
}
export async function bulkApply(
  service: WorkflowService,
  ctx: Context,
  raw: unknown,
) {
  const { token } = z
      .object({ token: z.string().max(500000) })
      .strict()
      .parse(raw),
    value = decode(token, ctx),
    items = [];
  for (const i of value.items) {
    if (i.status !== "ready") {
      items.push({ id: i.id, status: "skipped" as const, code: "UNAVAILABLE" });
      continue;
    }
    try {
      const result = await service.setDocumentState(ctx, i.id, {
        ...i.patch,
        expectedRevision: i.expectedRevision,
        reason: value.reason,
      });
      items.push({
        id: i.id,
        status: "applied" as const,
        revision: result.revision,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        [
          "NOT_FOUND",
          "FORBIDDEN",
          "STALE_VERSION",
          "VALIDATION_FAILED",
          "POLICY_UNAVAILABLE",
        ].includes(e.message)
      )
        items.push({ id: i.id, status: "failed" as const, code: e.message });
      else throw e;
    }
  }
  return { items };
}
