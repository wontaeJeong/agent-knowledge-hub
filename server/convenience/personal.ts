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
export class PersonalLibraryService {
  constructor(readonly workflows: WorkflowService) {}
  async list(
    ctx: Context,
    input: { kind: LibraryKind; cursor?: string | null; limit?: number },
  ): Promise<LibraryPage> {
    const q = query.parse(input),
      snapshot = await this.workflows.personalSnapshot(ctx, q.kind);
    const binding = fingerprint({
      workspace: ctx.workspaceId,
      principal: ctx.principalId,
      kind: q.kind,
      limit: q.limit,
      ...snapshot,
    });
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
    const body = Buffer.from(
      JSON.stringify({ binding, offset: next }),
    ).toString("base64url");
    return {
      items: snapshot.items.slice(offset, next),
      revision: snapshot.revision,
      nextCursor:
        next < snapshot.items.length
          ? body + "." + createHmac("sha256", secret).update(body).digest("hex")
          : null,
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
