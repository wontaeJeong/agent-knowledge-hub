import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Context } from "../service";
import type { WorkflowService } from "../workflows/service";
import { fingerprint } from "../provenance";
import type { LibraryKind, LibraryPage } from "./types";
// Process-local signed cursors deliberately expire on restart; no document ID or title in tokens.
const secret = randomBytes(32);
const query = z
  .object({
    kind: z.enum(["favorites", "recent", "subscriptions"]),
    limit: z.number().int().min(1).max(25).default(25),
    cursor: z.string().max(4096).nullable().optional(),
  })
  .strict();
type Snapshot = Awaited<ReturnType<WorkflowService["personalSnapshot"]>>;
export class PersonalLibraryService {
  constructor(readonly workflows: WorkflowService) {}
  private binding(
    ctx: Context,
    kind: LibraryKind,
    limit: number,
    snapshot: Snapshot,
  ) {
    return fingerprint({
      workspace: ctx.workspaceId,
      principal: ctx.principalId,
      kind,
      limit,
      ...snapshot,
    });
  }
  private cursor(binding: string, offset: number) {
    if (!offset) return null;
    const body = Buffer.from(JSON.stringify({ binding, offset })).toString(
      "base64url",
    );
    return body + "." + createHmac("sha256", secret).update(body).digest("hex");
  }
  async moveFavorite(ctx: Context, input: unknown) {
    const d = z
      .object({
        pageId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        direction: z.enum(["up", "down"]),
        expectedRevision: z.number().int().min(0),
        mutationId: z.string().min(1).max(200),
      })
      .strict()
      .parse(input);
    await this.workflows.movePersonalFavorite(ctx, d);
    // Never replay an old protected view/cursor: current context is re-authorized.
    const snapshot = await this.workflows.personalSnapshot(ctx, "favorites");
    const index = snapshot.items.findIndex((item) => item.id === d.pageId);
    if (index < 0) throw Error("NOT_FOUND");
    return {
      revision: snapshot.revision,
      cursor: this.cursor(
        this.binding(ctx, "favorites", 25, snapshot),
        Math.floor(index / 25) * 25,
      ),
    };
  }
  async list(
    ctx: Context,
    input: { kind: LibraryKind; cursor?: string | null; limit?: number },
  ): Promise<LibraryPage> {
    const q = query.parse(input),
      snapshot = await this.workflows.personalSnapshot(ctx, q.kind);
    const binding = this.binding(ctx, q.kind, q.limit, snapshot);
    let offset = 0;
    if (q.cursor) {
      try {
        const [body, sig, ...extra] = q.cursor.split(".");
        const expected = createHmac("sha256", secret).update(body).digest();
        const actual = Buffer.from(sig, "hex");
        if (
          extra.length ||
          actual.length !== expected.length ||
          !timingSafeEqual(expected, actual)
        )
          throw Error();
        const token = JSON.parse(Buffer.from(body, "base64url").toString());
        if (
          token.binding !== binding ||
          !Number.isSafeInteger(token.offset) ||
          token.offset < 1 ||
          token.offset >= snapshot.items.length
        )
          throw Error();
        offset = token.offset;
      } catch {
        throw Error("STALE_CURSOR");
      }
    }
    const next = offset + q.limit;
    return {
      items: snapshot.items
        .slice(offset, next)
        .map((item, index) =>
          q.kind === "favorites"
            ? {
                ...item,
                canMoveUp: offset + index > 0,
                canMoveDown: offset + index < snapshot.items.length - 1,
              }
            : item,
        ),
      revision: snapshot.revision,
      nextCursor:
        next < snapshot.items.length ? this.cursor(binding, next) : null,
    };
  }
  documentState(ctx: Context, pageId: string) {
    return this.workflows.personalDocumentState(ctx, pageId);
  }
  reorderFavorites(ctx: Context, input: unknown) {
    const d = z
      .object({
        pageIds: z
          .array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/))
          .min(1)
          .max(50),
        expectedRevision: z.number().int().min(0),
        mutationId: z.string().min(1).max(200),
      })
      .strict()
      .parse(input);
    if (new Set(d.pageIds).size !== d.pageIds.length)
      throw Error("VALIDATION_FAILED");
    return this.workflows.reorderPersonalFavorites(ctx, d);
  }
}
