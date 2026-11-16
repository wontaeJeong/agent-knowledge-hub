import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { Context } from "../service";
import { transaction } from "../database";
import { readers } from "../repository";
import { fingerprint } from "../provenance";
import { authorizeActionDb, type AccessService } from "./index";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  secret = randomBytes(32);
const sign = (s: string) => createHmac("sha256", secret).update(s).digest();
const entry = z
  .object({
    pageId: id,
    version: z.number().int().positive(),
    title: z.string(),
    parentId: id.nullable(),
    fingerprint: z.string(),
    audienceChange: z.literal("unchanged"),
  })
  .strict();
const previewBody = z
  .object({
    workspaceId: id,
    principalId: z.string(),
    credentialId: z.string().nullable(),
    recipientId: id,
    expectedVersion: z.number().int().positive(),
    expires: z.number(),
    items: z.array(entry).min(1).max(50),
  })
  .strict();
async function snapshot(
  a: AccessService,
  db: PoolClient,
  ctx: Context,
  pageId: string,
  recipient: string,
) {
  await authorizeActionDb(db, ctx, "knowledge.read", {
    kind: "page",
    id: pageId,
  });
  const p = (
    await db.query(
      "SELECT p.data,v.number,v.data version,s.parent_id,s.state FROM pages p JOIN LATERAL(SELECT number,data FROM versions WHERE workspace_id=p.workspace_id AND page_id=p.id ORDER BY number DESC LIMIT 1)v ON true LEFT JOIN workflow_document_state s ON s.workspace_id=p.workspace_id AND s.page_id=p.id WHERE p.workspace_id=$1 AND p.id=$2",
      [ctx.workspaceId, pageId],
    )
  ).rows[0];
  if (!p || p.state === "trash") throw Error("NOT_FOUND");
  await a.assertShareInputs(
    db,
    { workspaceId: ctx.workspaceId, principalId: recipient },
    pageId,
    p.number,
  );
  return {
    pageId,
    version: p.number,
    title: String(p.data.title),
    parentId: p.parent_id ?? null,
    fingerprint: fingerprint({
      page: p.data,
      version: p.version,
      parent: p.parent_id ?? null,
      state: p.state ?? "active",
      readers: await readers(db, ctx.workspaceId, "page", pageId),
    }),
    audienceChange: "unchanged" as const,
  };
}
export async function previewShareSelection(
  a: AccessService,
  ctx: Context,
  raw: unknown,
) {
  const d = z
    .object({
      rootPageId: id,
      includeDescendants: z.boolean().default(false),
      principalId: id,
    })
    .strict()
    .parse(raw);
  await ctx.authorization?.revalidate();
  const result = await transaction(a.pool, ctx.workspaceId, async (db) => {
    await ctx.authorization?.assertSession(db);
    const access = await authorizeActionDb(db, ctx, "share.manage");
    if (access.space.namespaceKind !== "team") throw Error("FORBIDDEN");
    await a.activeMember(db, access.space.namespaceId, d.principalId);
    const items = [await snapshot(a, db, ctx, d.rootPageId, d.principalId)];
    if (d.includeDescendants) {
      const rows = (
        await db.query(
          "WITH RECURSIVE tree(id,path) AS(SELECT $2::text,ARRAY[$2::text] UNION ALL SELECT s.page_id,t.path||s.page_id FROM workflow_document_state s JOIN tree t ON s.parent_id=t.id WHERE s.workspace_id=$1 AND s.state<>'trash' AND NOT(s.page_id=ANY(t.path)) AND cardinality(t.path)<51) SELECT id FROM tree WHERE id<>$2 ORDER BY id",
          [ctx.workspaceId, d.rootPageId],
        )
      ).rows;
      for (const r of rows) {
        try {
          items.push(await snapshot(a, db, ctx, r.id, d.principalId));
          if (items.length > 50) throw Error("SHARE_SELECTION_LIMIT");
        } catch (e) {
          if (!(
            e instanceof Error && ["NOT_FOUND", "FORBIDDEN"].includes(e.message)
          ))
            throw e;
        }
      }
    }
    const data = {
      workspaceId: ctx.workspaceId,
      principalId: ctx.principalId,
      credentialId: ctx.credentialId ?? null,
      recipientId: d.principalId,
      expectedVersion: access.space.policyVersion,
      expires: Date.now() + 600000,
      items,
    };
    const body = Buffer.from(JSON.stringify(data)).toString("base64url");
    return {
      items: items.map(({ fingerprint: _, ...v }) => v),
      token: body + "." + sign(body).toString("base64url"),
      expiresAt: new Date(data.expires).toISOString(),
      recipientId: d.principalId,
      audienceChange: "unchanged",
    };
  });
  await ctx.authorization?.revalidate();
  await transaction(a.pool, ctx.workspaceId, async (db) => {
    await ctx.authorization?.assertSession(db);
    await authorizeActionDb(db, ctx, "share.manage");
    for (const old of result.items) {
      const now = await snapshot(a, db, ctx, old.pageId, d.principalId);
      if (
        now.version !== old.version ||
        now.parentId !== old.parentId ||
        now.title !== old.title
      )
        throw Error("STALE_VERSION");
    }
  });
  return result;
}
export async function createShareSelection(
  a: AccessService,
  ctx: Context,
  raw: unknown,
) {
  const d = z
    .object({
      token: z.string().max(100000),
      pageIds: z
        .array(id)
        .min(1)
        .max(50)
        .refine((v) => new Set(v).size === v.length),
      expiresAt: z.iso
        .datetime()
        .refine(
          (v) =>
            Date.parse(v) > Date.now() &&
            Date.parse(v) <= Date.now() + 366 * 86400000,
        ),
    })
    .strict()
    .parse(raw);
  let data: z.infer<typeof previewBody>;
  try {
    const [body, mac, ...extra] = d.token.split("."),
      expected = sign(body),
      actual = Buffer.from(mac ?? "", "base64url");
    if (
      extra.length ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw Error();
    data = previewBody.parse(
      JSON.parse(Buffer.from(body, "base64url").toString()),
    );
    if (
      data.workspaceId !== ctx.workspaceId ||
      data.principalId !== ctx.principalId ||
      data.credentialId !== (ctx.credentialId ?? null) ||
      data.expires < Date.now() ||
      d.pageIds.some((id) => !data.items.some((p) => p.pageId === id))
    )
      throw Error();
  } catch {
    throw Error("INVALID_SHARE_PREVIEW");
  }
  await ctx.authorization?.revalidate();
  const result = await a.mutate(ctx, "share.manage", async (db, access) => {
    if (access.space.namespaceKind !== "team") throw Error("FORBIDDEN");
    await a.activeMember(db, access.space.namespaceId, data.recipientId);
    for (const id of d.pageIds) {
      const old = data.items.find((p) => p.pageId === id)!,
        now = await snapshot(a, db, ctx, id, data.recipientId);
      if (now.fingerprint !== old.fingerprint || now.version !== old.version)
        throw Error("STALE_VERSION");
    }
    await a.bump(db, ctx, data.expectedVersion);
    const items = [];
    for (const pageId of d.pageIds) {
      const p = data.items.find((p) => p.pageId === pageId)!,
        shareId = randomUUID();
      await db.query(
        "INSERT INTO access_shares(id,workspace_id,page_id,version,principal_id,actions,expires_at) VALUES($1,$2,$3,$4,$5,ARRAY['knowledge.read'],$6)",
        [
          shareId,
          ctx.workspaceId,
          pageId,
          p.version,
          data.recipientId,
          d.expiresAt,
        ],
      );
      items.push({ id: shareId, pageId, version: p.version });
    }
    return { items };
  });
  await ctx.authorization?.revalidate();
  return result;
}
