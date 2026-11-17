import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { transaction } from "../database";
import { audit } from "../repository";
import { fingerprint } from "../provenance";
import type { CollaborationHooks } from "./types";
export const inboxTypes = [
  "mention",
  "document-updated",
  "review-requested",
  "review-decided",
  "review-due",
  "job-succeeded",
  "job-failed",
  "access-decided",
] as const;
export type InboxTarget =
  | { kind: "document"; pageId: string }
  | { kind: "comment"; pageId: string; commentId: string }
  | { kind: "review" | "job" | "access-request"; id: string };
export interface InboxItem {
  id: string;
  sequence: number;
  revision: number;
  type: (typeof inboxTypes)[number];
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
  target: InboxTarget;
  title: string;
  actionState: string;
}
export interface InboxQuery {
  state?: "all" | "unread" | "archived";
  type?: (typeof inboxTypes)[number];
  limit?: number;
  cursor?: string | null;
}
export interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null;
  unreadCount: number;
  readBoundary: string;
}
type Row = Record<string, any>;
export type InboxContent = { authorizationHash: string } & Pick<
  InboxItem,
  "type" | "target" | "title" | "actionState"
>;
export interface InboxEvent {
  workspaceId: string;
  principalId: string;
  id: string;
  eventKey: string;
  pageId?: string | null;
  version?: number | null;
  kind: string;
  data: Record<string, unknown>;
  createdAt?: Date;
}
/** Called within the existing business/outbox transaction, never from UI reads. */
export async function recordInboxEvent(
  db: PoolClient,
  event: InboxEvent,
): Promise<void> {
  await db.query(
    "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data,event_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
    [
      event.workspaceId,
      event.id,
      event.principalId,
      event.pageId ?? null,
      event.version ?? null,
      event.kind,
      event.data,
      event.eventKey,
      event.createdAt ?? new Date(),
    ],
  );
}
const mutation = z.string().min(1).max(200),
  stamp = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
export class InboxService {
  private readonly secret: Buffer;
  constructor(
    readonly pool: Pool,
    readonly hooks: CollaborationHooks,
    readonly content: (
      db: PoolClient,
      ctx: Context,
      row: Row,
    ) => Promise<InboxContent | null>,
    readonly clock = () => new Date(),
    signingKey?: string,
  ) {
    this.secret =
      signingKey === undefined
        ? randomBytes(32)
        : Buffer.from(z.string().min(32).max(4096).parse(signingKey));
  }
  private sign(data: unknown) {
    const body = Buffer.from(JSON.stringify(data)).toString("base64url");
    return (
      body + "." + createHmac("sha256", this.secret).update(body).digest("hex")
    );
  }
  private decode(token: string, ctx: Context, kind: string, code: string): Row {
    try {
      const [body, sig, ...extra] = token.split(".");
      const expected = createHmac("sha256", this.secret).update(body).digest();
      const actual = Buffer.from(sig, "hex");
      if (
        !/^[a-f0-9]{64}$/.test(sig) ||
        extra.length ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw Error();
      const data = JSON.parse(Buffer.from(body, "base64url").toString());
      if (
        data.workspaceId !== ctx.workspaceId ||
        data.principalId !== ctx.principalId ||
        data.kind !== kind
      )
        throw Error();
      return data;
    } catch {
      throw Error(code);
    }
  }
  private async run<T>(ctx: Context, work: (db: PoolClient) => Promise<T>) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await ctx.authorization?.assertSession(db);
      await this.hooks.authorize(db, ctx, "knowledge.read");
      await db.query(
        "INSERT INTO collaboration_inbox_state(workspace_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [ctx.workspaceId, ctx.principalId],
      );
      await db.query(
        "SELECT 1 FROM collaboration_inbox_state WHERE workspace_id=$1 AND principal_id=$2 FOR UPDATE",
        [ctx.workspaceId, ctx.principalId],
      );
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async snapshot(db: PoolClient, ctx: Context) {
    const rows = (
      await db.query(
        "SELECT * FROM workflow_notifications WHERE workspace_id=$1 AND principal_id=$2 ORDER BY sequence DESC LIMIT 10001",
        [ctx.workspaceId, ctx.principalId],
      )
    ).rows;
    if (rows.length > 10000) throw Error("INBOX_QUERY_LIMIT");
    const visible: { item: InboxItem; row: Row }[] = [];
    for (const row of rows) {
      const content = await this.content(db, ctx, row);
      if (content) {
        const { authorizationHash, ...safe } = content;
        visible.push({
          row: { ...row, authorizationHash },
          item: {
            id: row.id,
            sequence: Number(row.sequence),
            revision: row.revision,
            createdAt: stamp(row.created_at)!,
            readAt: stamp(row.read_at),
            archivedAt: stamp(row.archived_at),
            ...safe,
          },
        });
      }
    }
    return visible;
  }
  async list(ctx: Context, input: InboxQuery = {}): Promise<InboxPage> {
    const query = z
      .object({
        state: z.enum(["all", "unread", "archived"]).default("all"),
        type: z.enum(inboxTypes).optional(),
        limit: z.number().int().min(1).max(25).default(25),
        cursor: z.string().max(4000).nullable().optional(),
      })
      .strict()
      .parse(input);
    return this.run(ctx, async (db) => {
      const visible = await this.snapshot(db, ctx),
        state = (
          await db.query(
            "SELECT * FROM collaboration_inbox_state WHERE workspace_id=$1 AND principal_id=$2",
            [ctx.workspaceId, ctx.principalId],
          )
        ).rows[0];
      const policy = (
        await db.query(
          "SELECT policy_version FROM access_spaces WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows[0];
      const visibility = fingerprint({
        policy: policy?.policy_version ?? null,
        items: visible.map(({ item, row }) => [item, row.authorizationHash]),
      });
      const filters = {
        state: query.state,
        type: query.type ?? null,
        limit: query.limit,
      };
      let before = Infinity;
      if (query.cursor) {
        const old = this.decode(query.cursor, ctx, "cursor", "STALE_CURSOR");
        if (
          old.visibility !== visibility ||
          fingerprint(old.filters) !== fingerprint(filters)
        )
          throw Error("STALE_CURSOR");
        before = old.before;
      }
      const selected = visible
        .map((v) => v.item)
        .filter(
          (i) =>
            (query.state === "archived"
              ? !!i.archivedAt
              : !i.archivedAt && (query.state !== "unread" || !i.readAt)) &&
            (!query.type || i.type === query.type) &&
            i.sequence < before,
        );
      const items = selected.slice(0, query.limit);
      const binding = {
        workspaceId: ctx.workspaceId,
        principalId: ctx.principalId,
      };
      return {
        items,
        nextCursor:
          selected.length > items.length
            ? this.sign({
                ...binding,
                kind: "cursor",
                filters,
                visibility,
                before: items.at(-1)!.sequence,
              })
            : null,
        unreadCount: visible.filter((v) => !v.item.readAt && !v.item.archivedAt)
          .length,
        readBoundary: this.sign({
          ...binding,
          kind: "boundary",
          sequence: Number(state.next_sequence),
          revision: Number(state.revision),
        }),
      };
    });
  }
  private async replay(
    db: PoolClient,
    ctx: Context,
    mutationId: string,
    payload: unknown,
  ) {
    const hash = fingerprint(payload);
    const row = (
      await db.query(
        "SELECT * FROM collaboration_inbox_mutations WHERE workspace_id=$1 AND principal_id=$2 AND mutation_id=$3",
        [ctx.workspaceId, ctx.principalId, mutationId],
      )
    ).rows[0];
    if (row && row.payload_hash !== hash) throw Error("MUTATION_CONFLICT");
    return { row, hash };
  }
  private async remember(
    db: PoolClient,
    ctx: Context,
    id: string,
    hash: string,
    updated: number,
    visibilityHash: string | null = null,
  ) {
    await db.query(
      "INSERT INTO collaboration_inbox_mutations(workspace_id,principal_id,mutation_id,payload_hash,updated,visibility_hash) VALUES($1,$2,$3,$4,$5,$6)",
      [ctx.workspaceId, ctx.principalId, id, hash, updated, visibilityHash],
    );
    await audit(db, ctx, "inbox.state", id);
  }
  async setState(ctx: Context, id: string, input: unknown): Promise<InboxItem> {
    z.string().min(1).max(200).parse(id);
    const p = z
      .object({
        read: z.boolean().optional(),
        archived: z.boolean().optional(),
        expectedRevision: z.number().int().positive(),
        mutationId: mutation,
      })
      .strict()
      .refine((p) => p.read !== undefined || p.archived !== undefined)
      .parse(input);
    return this.run(ctx, async (db) => {
      const old = await this.replay(db, ctx, p.mutationId, { id, ...p });
      const found = (await this.snapshot(db, ctx)).find(
        (v) => v.item.id === id,
      );
      if (!found) throw Error("NOT_FOUND");
      if (old.row) return found.item;
      if (found.item.revision !== p.expectedRevision)
        throw Error("STALE_VERSION");
      await db.query(
        "UPDATE workflow_notifications SET read_at=CASE WHEN $4::boolean IS NULL THEN read_at WHEN $4 THEN coalesce(read_at,$6) ELSE NULL END,archived_at=CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN coalesce(archived_at,$6) ELSE NULL END WHERE workspace_id=$1 AND principal_id=$2 AND id=$3",
        [
          ctx.workspaceId,
          ctx.principalId,
          id,
          p.read ?? null,
          p.archived ?? null,
          this.clock(),
        ],
      );
      await this.remember(db, ctx, p.mutationId, old.hash, 1);
      return (await this.snapshot(db, ctx)).find((v) => v.item.id === id)!.item;
    });
  }
  async readAll(ctx: Context, input: unknown): Promise<{ updated: number }> {
    const p = z
      .object({ boundary: z.string().max(4000), mutationId: mutation })
      .strict()
      .parse(input);
    const boundary = this.decode(
      p.boundary,
      ctx,
      "boundary",
      "INVALID_BOUNDARY",
    );
    return this.run(ctx, async (db) => {
      const old = await this.replay(db, ctx, p.mutationId, p);
      const visible = await this.snapshot(db, ctx);
      const visibilityHash = fingerprint(
        visible
          .filter((v) => v.item.sequence <= boundary.sequence)
          .map((v) => v.item.id),
      );
      if (old.row) {
        if (old.row.visibility_hash !== visibilityHash)
          throw Error("NOT_FOUND");
        return { updated: old.row.updated };
      }
      const ids = visible
        .filter(
          (v) =>
            !v.item.readAt &&
            !v.item.archivedAt &&
            v.item.sequence <= boundary.sequence &&
            Number(v.row.state_revision) <= boundary.revision,
        )
        .map((v) => v.item.id);
      const result = await db.query(
        "UPDATE workflow_notifications SET read_at=$4 WHERE workspace_id=$1 AND principal_id=$2 AND id=ANY($3::text[]) AND read_at IS NULL",
        [ctx.workspaceId, ctx.principalId, ids, this.clock()],
      );
      const updated = result.rowCount ?? 0;
      await this.remember(
        db,
        ctx,
        p.mutationId,
        old.hash,
        updated,
        visibilityHash,
      );
      return { updated };
    });
  }
}
