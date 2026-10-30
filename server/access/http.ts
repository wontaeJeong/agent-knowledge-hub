import type { Context } from "../service";
import { AccessService, authorizeAction, type Action } from "./index";
import { z } from "zod";

/** Returns undefined only when the route is not owned by the access module. */
export async function accessRoute(
  access: AccessService,
  ctx: Context,
  method: string | undefined,
  path: string,
  body: unknown,
  query: URLSearchParams,
): Promise<{ status: number; body: unknown } | undefined> {
  const send = (body: unknown, status = 200) => ({ status, body });
  const spaceTarget = path.match(/^\/api\/v1\/spaces\/([^/]+)/);
  if (ctx.credentialId && spaceTarget && spaceTarget[1] !== ctx.workspaceId)
    throw Error("NOT_FOUND");
  const scoped = path.match(
    /^\/api\/v1\/spaces\/([a-zA-Z0-9_-]{1,100})\/(access|grants|visibility|review-policy|credentials|shares|service-principals)(?:\/([a-zA-Z0-9_-]{1,100}))?$/,
  );
  if (scoped) {
    ctx = { ...ctx, workspaceId: scoped[1] };
    if (ctx.credentialId)
      await authorizeAction(access.pool, ctx, "knowledge.read");
    path = `/api/v1/${scoped[2]}${scoped[3] ? "/" + scoped[3] : ""}`;
  }
  if (method === "GET") {
    const sourcePolicy = path.match(/^\/api\/v1\/sources\/([^/]+)\/policy$/);
    if (sourcePolicy)
      return send(await access.sourcePolicy(ctx, sourcePolicy[1]));
    const teamMembers = path.match(/^\/api\/v1\/teams\/([^/]+)\/members$/);
    if (teamMembers) return send(await access.teamMembers(ctx, teamMembers[1]));
    const serviceCredentials = path.match(
      /^\/api\/v1\/service-principals\/([^/]+)\/credentials$/,
    );
    if (serviceCredentials)
      return send({
        items: await access.serviceCredentials(ctx, serviceCredentials[1]),
      });
    if (path === "/api/v1/service-principals")
      return send({ items: await access.servicePrincipals(ctx) });
    if (path === "/api/v1/shares")
      return send({ items: await access.shares(ctx) });
    const share = path.match(/^\/api\/v1\/shares\/([^/]+)$/);
    if (share) return send(await access.readShare(ctx, share[1]));
    if (path === "/api/v1/spaces")
      return send({ items: await access.spaces(ctx) });
    if (path === "/api/v1/teams")
      return send({ items: await access.teams(ctx) });
    if (path === "/api/v1/groups")
      return send({
        items: await access.groups(ctx, query.get("teamId") ?? undefined),
      });
    if (path === "/api/v1/invitations")
      return send({ items: await access.invitations(ctx) });
    if (path === "/api/v1/access") {
      return send(
        await access.accessFor(ctx, query.get("principalId") ?? undefined),
      );
    }
    if (path === "/api/v1/review-policy")
      return send(await access.reviewPolicy(ctx));
    if (path === "/api/v1/credentials")
      return send({ items: await access.credentials(ctx) });
  }
  if (method === "POST") {
    const sourcePolicy = path.match(/^\/api\/v1\/sources\/([^/]+)\/policy$/);
    if (sourcePolicy)
      return send(await access.setSourcePolicy(ctx, sourcePolicy[1], body));
    const updateService = path.match(
      /^\/api\/v1\/service-principals\/([^/]+)$/,
    );
    if (updateService)
      return send(
        await access.updateServicePrincipal(ctx, updateService[1], body),
      );
    if (path === "/api/v1/service-principals")
      return send(await access.createServicePrincipal(ctx, body), 201);
    const serviceCredential = path.match(
      /^\/api\/v1\/service-principals\/([^/]+)\/credentials$/,
    );
    if (serviceCredential)
      return send(
        await access.issueServiceCredential(ctx, serviceCredential[1], body),
        201,
      );
    if (path === "/api/v1/shares")
      return send(await access.createShare(ctx, body), 201);
    const personalSave = path.match(/^\/api\/v1\/changesets\/([^/]+)\/save$/);
    if (personalSave) {
      const b = z
        .object({
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z.string().min(1).max(200),
        })
        .strict()
        .parse(body);
      return send(
        await access.savePersonal(
          ctx,
          personalSave[1],
          b.hash,
          b.idempotencyKey,
        ),
      );
    }
    if (path === "/api/v1/spaces")
      return send(await access.createSpace(ctx, body), 201);
    if (path === "/api/v1/teams")
      return send(await access.createTeam(ctx, body), 201);
    if (path === "/api/v1/groups")
      return send(await access.createGroup(ctx, body), 201);
    if (path === "/api/v1/grants")
      return send(await access.setGrant(ctx, body), 201);
    if (path === "/api/v1/visibility")
      return send(await access.setVisibility(ctx, body));
    if (path === "/api/v1/review-policy")
      return send(await access.setReviewPolicy(ctx, body));
    if (path === "/api/v1/credentials")
      return send(await access.issueCredential(ctx, body), 201);
    const invite = path.match(
      /^\/api\/v1\/teams\/([^/]+)\/(invitations|ownership-transfer)$/,
    );
    if (invite) {
      const b = z
        .object({ principalId: z.string(), expiresAt: z.string() })
        .strict()
        .parse(body);
      return send(
        await access.invite(ctx, invite[1], {
          ...b,
          kind:
            invite[2] === "ownership-transfer" ? "owner-transfer" : "member",
        }),
        201,
      );
    }
    const accept = path.match(/^\/api\/v1\/invitations\/([^/]+)\/accept$/);
    if (accept) {
      z.object({}).strict().parse(body);
      return send(await access.acceptInvite(ctx, accept[1]));
    }
    const group = path.match(/^\/api\/v1\/groups\/([^/]+)\/members$/);
    if (group) return send(await access.setGroupMembers(ctx, group[1], body));
  }
  if (method === "DELETE") {
    const deletedSpace = path.match(/^\/api\/v1\/spaces\/([^/]+)$/);
    if (deletedSpace)
      return send(
        await access.deleteSpace(
          { ...ctx, workspaceId: deletedSpace[1] },
          body,
        ),
      );
    const serviceCredential = path.match(
      /^\/api\/v1\/service-principals\/([^/]+)\/credentials\/([^/]+)$/,
    );
    if (serviceCredential) {
      z.object({}).strict().parse(body);
      return send(
        await access.revokeServiceCredential(
          ctx,
          serviceCredential[1],
          serviceCredential[2],
        ),
      );
    }
    const servicePrincipal = path.match(
      /^\/api\/v1\/service-principals\/([^/]+)$/,
    );
    if (servicePrincipal) {
      z.object({}).strict().parse(body);
      return send(
        await access.revokeServicePrincipal(ctx, servicePrincipal[1]),
      );
    }
    const share = path.match(/^\/api\/v1\/shares\/([^/]+)$/);
    if (share) {
      const b = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(body);
      return send(await access.revokeShare(ctx, share[1], b.expectedVersion));
    }
    const credential = path.match(/^\/api\/v1\/credentials\/([^/]+)$/);
    if (credential) {
      z.object({}).strict().parse(body);
      return send(await access.revokeCredential(ctx, credential[1]));
    }
    const grant = path.match(/^\/api\/v1\/grants\/([^/]+)$/);
    if (grant) {
      const b = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(body);
      return send(await access.removeGrant(ctx, grant[1], b.expectedVersion));
    }
    const member = path.match(/^\/api\/v1\/teams\/([^/]+)\/members\/([^/]+)$/);
    if (member) {
      const b = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(body);
      return send(
        await access.removeMember(ctx, member[1], member[2], b.expectedVersion),
      );
    }
    const invite = path.match(
      /^\/api\/v1\/teams\/([^/]+)\/invitations\/([^/]+)$/,
    );
    if (invite) {
      z.object({}).strict().parse(body);
      return send(await access.revokeInvite(ctx, invite[1], invite[2]));
    }
  }
  return undefined;
}

/** Coarse route gate; finer resource/provenance checks remain in the domain transaction. */
export function routeAction(path: string, method: string | undefined): Action {
  if (path.endsWith("/approve") || path.endsWith("/reject"))
    return "changeset.approve";
  if (path.endsWith("/publish")) return "changeset.publish";
  if (path === "/api/v1/sources" && method === "POST") return "source.create";
  if (path === "/api/v1/sources") return "changeset.propose";
  if (path === "/api/v1/ingest" || path.endsWith("/file"))
    return "changeset.propose";
  if (path === "/api/v1/changesets") return "queue.triage";
  if (path === "/api/v1/lint") return "lint.run";
  if (path === "/api/v1/members") return "space.admin";
  return "knowledge.read";
}
