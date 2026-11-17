import type { Pool } from "pg";
import type { Context } from "../service";
import { transaction } from "../database";
import { authorizeInTransaction, effectiveAccess } from "../access";
import { fingerprint } from "../provenance";
import {
  encodeCursor,
  decodeCursor,
  listRevision,
} from "../workflows/manual-disclosure";
import type { WorkflowService } from "../workflows/service";
import type { GovernanceService } from "../workflows/governance/service";
import type { JobService } from "../jobs/service";
import { PersonalLibraryService } from "./personal";
export const homeWidgets = [
  "recent",
  "favorites",
  "drafts",
  "requests",
  "revisions",
  "reviews",
  "failedJobs",
  "accessRequests",
] as const;
export type HomeWidget = (typeof homeWidgets)[number];
export interface HomeItem {
  id: string;
  title: string;
  state: string;
  href: string;
  assigned?: boolean;
  stale?: boolean;
}
export interface HomePage {
  status: "ready" | "error";
  items: HomeItem[];
  nextCursor: string | null;
  partial?: boolean;
}
export type HomeSummary = Record<HomeWidget, HomePage>;
const fatal = (e: unknown) =>
  e instanceof Error &&
  /UNAUTHENTICATED|SESSION_|CREDENTIAL_REVOKED|IDENTITY_REVOKED/.test(
    e.message,
  );
// Feed-specific data is separate from shared authority/source/erasure fences.
const feedTables = {
  recent: ["workflow_activity", "workflow_personal_library_state"],
  favorites: ["workflow_activity", "workflow_personal_library_state"],
  drafts: [],
  requests: ["batches", "access_batch_authors"],
  revisions: ["batches", "access_batch_authors"],
  reviews: [
    "batches",
    "access_batch_authors",
    "access_review_rules",
    "governance_review_assignments",
  ],
  failedJobs: ["durable_jobs"],
  accessRequests: ["workflow_access_requests"],
} as const;
/** Read-only adapter: independent canonical transactions keep one SQL failure local. */
export class HomeService {
  constructor(
    readonly pool: Pool,
    readonly workflows: WorkflowService,
    readonly governance: GovernanceService,
    readonly jobs?: JobService,
  ) {}
  private async binding(ctx: Context, widget?: HomeWidget) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await ctx.authorization?.assertSession(db);
      await authorizeInTransaction(db, ctx, "knowledge.read");
      return fingerprint({
        workspace: ctx.workspaceId,
        principal: ctx.principalId,
        credential: ctx.credentialId ?? null,
        session: ctx.authorization?.sessionId ?? null,
        agent: ctx.agent ?? null,
        widget: widget ?? "admission",
        limit: 25,
        access: await effectiveAccess(db, ctx),
        revision: await listRevision(
          db,
          ctx,
          widget ? feedTables[widget] : [],
          widget === "drafts"
            ? "drafts"
            : widget === "requests" || widget === "revisions"
              ? "all"
              : "none",
        ),
      });
    });
  }
  async widget(
    ctx: Context,
    widget: HomeWidget,
    cursor?: string | null,
  ): Promise<HomePage> {
    await ctx.authorization?.revalidate();
    const binding = await this.binding(ctx, widget);
    const old = cursor ? decodeCursor(cursor) : null;
    if (old && (old.binding !== binding || old.expires < Date.now()))
      throw Error("STALE_CURSOR");
    const after = old?.id ?? null;
    const link = (targetKind: string, id: string) =>
      `/?${new URLSearchParams({ app: "1", space: ctx.workspaceId, section: "tasks", targetKind, targetId: id })}`;
    let items: HomeItem[] = [],
      nextAfter: string | null = null;
    if (widget === "recent" || widget === "favorites") {
      const result = await new PersonalLibraryService(this.workflows).list(
        ctx,
        { kind: widget, cursor: old?.at || null },
      );
      items = result.items.map((x) => ({
        id: x.id,
        title: x.title,
        state: `v${x.version}`,
        href: `/?${new URLSearchParams({ app: "1", space: ctx.workspaceId, document: x.id })}`,
      }));
      nextAfter = result.nextCursor ? "personal" : null;
      if ((await this.binding(ctx, widget)) !== binding)
        throw Error("STALE_CURSOR");
      await ctx.authorization?.revalidate();
      return {
        status: "ready",
        items,
        nextCursor: nextAfter
          ? encodeCursor({
              binding,
              id: nextAfter,
              at: result.nextCursor!,
              expires: Date.now() + 15 * 60 * 1000,
            })
          : null,
      };
    } else if (widget === "drafts") {
      const result = await this.workflows.drafts(ctx, { after });
      nextAfter = result.nextAfter ?? null;
      items = result.items.map((x) => ({
        id: x.id,
        title: x.title,
        state: "개인 저장",
        href: `/?${new URLSearchParams({ app: "1", space: ctx.workspaceId, section: "compose", draft: x.id })}`,
      }));
    } else if (widget === "requests" || widget === "revisions") {
      const result = await this.governance.ownRequests(
        ctx,
        this.workflows.manualDisclosures,
        after,
        widget === "revisions",
      );
      nextAfter = result.nextAfter ?? null;
      items = result.items.map((x) => ({
        id: x.id,
        title: x.title,
        state: x.state,
        href:
          x.kind === "disclosure"
            ? `/?${new URLSearchParams({ app: "1", space: ctx.workspaceId, section: "compose", draft: x.draftId! })}`
            : link("review", x.id),
      }));
    } else if (widget === "accessRequests") {
      const result = await this.governance.ownAccessRequests(ctx, after);
      nextAfter = result.nextAfter ?? null;
      items = result.items.map((x) => ({
        id: x.id,
        title: "접근 요청",
        state: "access-" + x.status,
        href: link("access-request", x.id),
      }));
    } else if (widget === "reviews") {
      const result = await this.governance.reviewInbox(ctx, { after });
      nextAfter = result.nextAfter ?? null;
      items = result.items.map((x) => ({
        id: x.id,
        title: "변경 검토",
        state: x.status,
        assigned: x.assigned,
        stale: x.stale,
        href: link("review", x.id),
      }));
    } else {
      if (!this.jobs) throw Error("EXECUTION_NOT_CONFIGURED");
      const offset = after === null ? 0 : Number(after);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw Error("STALE_CURSOR");
      const result = await this.jobs.list(ctx, offset, "own", true);
      nextAfter = result.nextOffset === null ? null : String(result.nextOffset);
      items = result.items.map((x) => ({
        id: x.id,
        title: x.kind,
        state: x.status,
        href: link("job", x.id),
      }));
    }
    if ((await this.binding(ctx, widget)) !== binding)
      throw Error("STALE_CURSOR");
    await ctx.authorization?.revalidate();
    return {
      status: "ready",
      items,
      nextCursor: nextAfter
        ? encodeCursor({
            binding,
            id: nextAfter,
            at: "",
            expires: Date.now() + 15 * 60 * 1000,
          })
        : null,
      partial: !!nextAfter && items.length < 25,
    };
  }
  async read(ctx: Context): Promise<HomeSummary> {
    await ctx.authorization?.revalidate();
    await this.binding(ctx);
    // Sequential independent transactions also avoid exhausting the shared pool.
    const result = {} as HomeSummary;
    for (const widget of homeWidgets) {
      try {
        result[widget] = await this.widget(ctx, widget);
      } catch (e) {
        if (fatal(e)) throw e;
        result[widget] = { status: "error", items: [], nextCursor: null };
      }
    }
    await ctx.authorization?.revalidate();
    return result;
  }
}
