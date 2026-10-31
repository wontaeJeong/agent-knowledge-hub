import { z } from "zod";
import type { Context } from "../service";
import type { WorkflowService } from "./service";

/** Mounted only after the host's identity, CSRF, body and selected-space checks. */
export async function handleWorkflowRoute(
  input: {
    method: string;
    path: string;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: WorkflowService,
): Promise<boolean> {
  const { method, path, body, ctx, send } = input;
  if (!path.startsWith("/api/v1/workflows/")) return false;
  const route = path.slice("/api/v1/workflows".length);
  const reply = (value: unknown, status = 200) => {
    send(status, value);
    return true;
  };
  const empty = () => z.object({}).strict().parse(body);
  if (method === "GET") {
    if (route === "/drafts") return reply(await service.drafts(ctx));
    if (route === "/templates") return reply(await service.templates(ctx));
    if (route === "/notifications")
      return reply(await service.notifications(ctx));
    if (route === "/favorites")
      return reply(await service.activity(ctx, "favorite"));
    if (route === "/recent")
      return reply(await service.activity(ctx, "recent"));
    if (route === "/trash") return reply(await service.trash(ctx));
    if (route === "/preferences") return reply(await service.preferences(ctx));
    const page = route.match(/^\/pages\/([^/]+)(?:\/(comments))?$/);
    if (page)
      return reply(
        page[2]
          ? await service.comments(ctx, page[1])
          : await service.document(ctx, page[1]),
      );
  }
  if (method !== "POST") return false;
  if (route === "/drafts")
    return reply(await service.saveDraft(ctx, body), 201);
  if (route === "/templates")
    return reply(await service.saveTemplate(ctx, body), 201);
  if (route === "/preferences")
    return reply(await service.preferences(ctx, body));
  if (route === "/access-requests") {
    const d = z
      .object({
        resourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(body);
    return reply(await service.requestAccess(ctx, d.resourceId, d.reason), 202);
  }
  const draft = route.match(/^\/drafts\/([^/]+)\/(submit|delete)$/);
  if (draft) {
    if (draft[2] === "submit") {
      const d = z
        .object({
          expectedRevision: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(body);
      return reply(
        await service.submitDraft(ctx, draft[1], d.expectedRevision, d.reason),
        201,
      );
    }
    const d = z
      .object({ expectedRevision: z.number().int().positive() })
      .strict()
      .parse(body);
    return reply(await service.deleteDraft(ctx, draft[1], d.expectedRevision));
  }
  const page = route.match(
    /^\/pages\/([^/]+)\/(edit|restore|state|comments|subscribe|favorite)$/,
  );
  if (page) {
    if (page[2] === "edit")
      return reply(await service.proposeEdit(ctx, page[1], body), 201);
    if (page[2] === "state")
      return reply(await service.setDocumentState(ctx, page[1], body));
    if (page[2] === "comments")
      return reply(await service.addComment(ctx, page[1], body), 201);
    if (page[2] === "restore") {
      const d = z
        .object({
          version: z.number().int().positive(),
          baseVersion: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(body);
      return reply(
        await service.proposeRestore(
          ctx,
          page[1],
          d.version,
          d.baseVersion,
          d.reason,
        ),
        201,
      );
    }
    const d = z.object({ enabled: z.boolean() }).strict().parse(body);
    return reply(
      page[2] === "favorite"
        ? await service.favorite(ctx, page[1], d.enabled)
        : await service.subscribe(ctx, page[1], d.enabled),
    );
  }
  const comment = route.match(/^\/comments\/([^/]+)\/(edit|delete|resolve)$/);
  if (comment) {
    if (comment[2] === "resolve") {
      const d = z.object({ resolved: z.boolean() }).strict().parse(body);
      return reply(await service.resolveComment(ctx, comment[1], d.resolved));
    }
    if (comment[2] === "edit") {
      const d = z
        .object({
          expectedRevision: z.number().int().positive(),
          content: z.string().trim().min(1).max(20000),
        })
        .strict()
        .parse(body);
      return reply(
        await service.editComment(
          ctx,
          comment[1],
          d.expectedRevision,
          d.content,
        ),
      );
    }
    const d = z
      .object({ expectedRevision: z.number().int().positive() })
      .strict()
      .parse(body);
    return reply(
      await service.deleteComment(ctx, comment[1], d.expectedRevision),
    );
  }
  const notification = route.match(/^\/notifications\/([^/]+)\/read$/);
  if (notification) {
    empty();
    return reply(await service.readNotification(ctx, notification[1]));
  }
  const source = route.match(/^\/sources\/([^/]+)\/(correct|withdraw)$/);
  if (source) {
    if (source[2] === "correct")
      return reply(await service.correctSource(ctx, source[1], body), 201);
    const d = z
      .object({ reason: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(body);
    return reply(await service.withdrawSource(ctx, source[1], d.reason));
  }
  const batch = route.match(/^\/changesets\/([^/]+)\/withdraw$/);
  if (batch) {
    const d = z
      .object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(body);
    return reply(
      await service.withdrawChangeset(ctx, batch[1], d.hash, d.reason),
    );
  }
  return false;
}
