import { z } from "zod";
import type { Context } from "./service";
import { AccessService } from "./access";
import { spaceRoles } from "../src/domain/access";
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const name = z.string().trim().min(1).max(100);
export async function handleAccessRequest(
  s: AccessService,
  ctx: Context,
  method: string,
  path: string,
  body: unknown,
  query: URLSearchParams,
) {
  const p = path.replace(/^\/api\/v1\/access/, "");
  if (method === "GET") {
    if (p === "") return { status: 200, body: await s.state(ctx) };
    if (p === "/spaces")
      return { status: 200, body: { items: await s.spaces(ctx) } };
    if (p === "/organizations")
      return { status: 200, body: { items: await s.organizations(ctx) } };
    if (p === "/invitations")
      return { status: 200, body: { items: await s.invitations(ctx) } };
    if (p === "/directory")
      return {
        status: 200,
        body: {
          items: await s.directory(
            ctx,
            z.string().trim().min(2).max(160).parse(query.get("q")),
          ),
        },
      };
  }
  if (method === "POST") {
    if (p === "/reviewers") {
      const b = z
        .object({ principalId: id, enabled: z.boolean() })
        .strict()
        .parse(body);
      return {
        status: 200,
        body: await s.reviewer(ctx, b.principalId, b.enabled),
      };
    }
    if (p === "/bootstrap")
      return {
        status: 201,
        body: await s.bootstrap(
          ctx,
          z
            .object({
              name,
              confirm: z.literal(
                "adopt-existing-members-and-preserve-source-acls",
              ),
            })
            .strict()
            .parse(body).name,
        ),
      };
    if (p === "/organizations")
      return {
        status: 201,
        body: await s.createOrganization(
          ctx,
          z.object({ name }).strict().parse(body).name,
        ),
      };
    if (p === "/spaces") {
      const b = z
        .object({ name, organizationId: id.optional() })
        .strict()
        .parse(body);
      return {
        status: 201,
        body: await s.createSpace(ctx, b.name, b.organizationId),
      };
    }
    if (p === "/invitations") {
      const b = z
        .object({
          principalId: id,
          role: z.enum(["owner", "member", ...spaceRoles]),
          workspaceId: id.optional(),
        })
        .strict()
        .refine((v) =>
          v.workspaceId
            ? !["owner", "member"].includes(v.role)
            : ["owner", "member"].includes(v.role),
        )
        .parse(body);
      return { status: 201, body: await s.invite(ctx, b) };
    }
    const invitation = p.match(/^\/invitations\/([^/]+)\/(accept|cancel)$/);
    if (invitation) {
      z.object({}).strict().parse(body);
      return {
        status: 200,
        body: await s.invitation(
          ctx,
          id.parse(invitation[1]),
          invitation[2] as "accept" | "cancel",
        ),
      };
    }
    if (p === "/teams")
      return {
        status: 201,
        body: await s.createTeam(
          ctx,
          z.object({ name }).strict().parse(body).name,
        ),
      };
    if (p === "/grants") {
      const b = z
        .object({
          principalId: id.optional(),
          teamId: id.optional(),
          role: z.enum(spaceRoles),
          expiresAt: z.iso
            .datetime()
            .refine(
              (v) =>
                new Date(v) > new Date() &&
                new Date(v).getTime() < Date.now() + 366 * 86400000,
            )
            .optional(),
        })
        .strict()
        .refine((v) => !!v.principalId !== !!v.teamId)
        .parse(body);
      return { status: 200, body: await s.grant(ctx, b) };
    }
    if (p === "/visibility") {
      const b = z
        .object({
          visibility: z.enum(["private", "team"]),
          revision: z.number().int().positive(),
          confirm: z.literal("source-acls-remain-restricted"),
        })
        .strict()
        .parse(body);
      return {
        status: 200,
        body: await s.visibility(ctx, b.visibility, b.revision),
      };
    }
  }
  const member = p.match(/^\/members\/([^/]+)$/);
  if (member && method === "PATCH") {
    const b = z
      .object({ role: z.enum(["owner", "member"]) })
      .strict()
      .parse(body);
    return {
      status: 200,
      body: await s.member(ctx, id.parse(member[1]), b.role),
    };
  }
  if (member && method === "DELETE") {
    z.object({}).strict().parse(body);
    return {
      status: 200,
      body: await s.member(ctx, id.parse(member[1]), null),
    };
  }
  const team = p.match(/^\/teams\/([^/]+)\/members\/([^/]+)$/);
  if (team && (method === "POST" || method === "DELETE")) {
    z.object({}).strict().parse(body);
    return {
      status: 200,
      body: await s.teamMember(
        ctx,
        id.parse(team[1]),
        id.parse(team[2]),
        method === "POST",
      ),
    };
  }
  const grant = p.match(/^\/grants\/([^/]+)$/);
  if (grant && method === "DELETE") {
    z.object({}).strict().parse(body);
    return { status: 200, body: await s.revoke(ctx, id.parse(grant[1])) };
  }
  return undefined;
}
