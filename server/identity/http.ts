import { z } from "zod";
import type { Context } from "../service";
import { authorizeActionDb } from "../access/index";
import { bindDirectoryGroup, type AssertGroupAdmin } from "./directory";
import type { EmergencyAccess } from "./emergency";
import {
  assertSessionPolicy,
  identityTransaction,
  sessionBinding,
  type IdentityOperations,
} from "./sessions";

export type DirectoryBindingOption = {
  key: string;
  issuer: string;
  externalGroupId: string;
  groupId: string;
  label: string;
};
export interface IdentityHttpServices {
  sessions: IdentityOperations;
  emergency?: EmergencyAccess;
  /** Approved mappings registered at server construction. Browser can select a
   * mapping key, not fabricate a proof, issuer, group name or principal. */
  directory?: {
    options: readonly DirectoryBindingOption[];
    assertGroupAdmin: AssertGroupAdmin;
    allowLoopbackHttp?: boolean;
  };
}
const page = z.coerce.number().int().min(0).max(100000);
const decision = z
  .object({
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["approved", "rejected"]),
  })
  .strict();
/** Host MUST authenticate, revalidate and enforce its normal Origin/CSRF and
 * JSON size limit before this dispatch. No client Context fields are parsed. */
export async function handleIdentityRequest(
  services: IdentityHttpServices,
  ctx: Context,
  method: string,
  path: string,
  body: unknown,
) {
  const url = new URL(path, "https://identity.invalid");
  if (!url.pathname.startsWith("/api/v1/identity/")) return null;
  sessionBinding(ctx);
  await ctx.authorization!.revalidate();
  const route = url.pathname,
    offset = page.parse(url.searchParams.get("offset") ?? 0);
  const pinned = route.match(
    /^\/api\/v1\/identity\/emergency-pages\/([a-zA-Z0-9_-]{1,100})\/versions\/([1-9][0-9]{0,8})$/,
  );
  if (pinned && services.emergency && method === "GET")
    return identityTransaction(services.sessions.pool, async (db) => {
      const resource = {
        kind: "page" as const,
        id: pinned[1],
        version: Number(pinned[2]),
      };
      await authorizeActionDb(db, ctx, "knowledge.read", resource);
      const row = (
        await db.query(
          "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 AND number=$3",
          [ctx.workspaceId, resource.id, resource.version],
        )
      ).rows[0];
      if (!row) throw Error("NOT_FOUND");
      await ctx.authorization!.assertSession(db);
      return {
        status: 200,
        body: {
          pageId: resource.id,
          version: resource.version,
          content: row.data.content,
        },
      };
    });
  if (route === "/api/v1/identity/sessions" && method === "GET")
    return { status: 200, body: await services.sessions.sessions(ctx, offset) };
  if (route === "/api/v1/identity/logout-all" && method === "POST") {
    z.object({}).strict().parse(body);
    return { status: 200, body: await services.sessions.logoutAll(ctx) };
  }
  const session = route.match(
    /^\/api\/v1\/identity\/sessions\/([a-f0-9]{64})$/,
  );
  if (session && method === "DELETE") {
    z.object({}).strict().parse(body);
    return {
      status: 200,
      body: await services.sessions.revokeSession(ctx, session[1]),
    };
  }
  if (route === "/api/v1/identity/emergencies" && services.emergency) {
    if (method === "GET")
      return { status: 200, body: await services.emergency.list(ctx, offset) };
    if (method === "POST") {
      const input = z
        .object({
          reason: z.string().trim().min(10).max(2000),
          pageIds: z.array(z.string().min(1).max(100)).min(1).max(100),
          actions: z
            .array(z.enum(["knowledge.read", "queue.triage", "triage.manage"]))
            .min(1)
            .max(3),
          minutes: z.number().int().min(1).max(30),
        })
        .strict()
        .parse(body);
      return {
        status: 201,
        body: await services.emergency.request(ctx, input),
      };
    }
  }
  const emergency = route.match(
    /^\/api\/v1\/identity\/emergencies\/([a-f0-9-]{36})\/(decision|revoke)$/,
  );
  if (emergency && services.emergency && method === "POST") {
    if (emergency[2] === "decision") {
      const input = decision.parse(body);
      return {
        status: 200,
        body: await services.emergency.decide(
          ctx,
          emergency[1],
          input.expectedRevision,
          input.decision,
        ),
      };
    }
    const input = z
      .object({ expectedRevision: z.number().int().positive() })
      .strict()
      .parse(body);
    return {
      status: 200,
      body: await services.emergency.revoke(
        ctx,
        emergency[1],
        input.expectedRevision,
      ),
    };
  }
  if (route === "/api/v1/identity/directory-bindings" && services.directory) {
    return identityTransaction(services.sessions.pool, async (db) => {
      await assertSessionPolicy(
        db,
        sessionBinding(ctx),
        services.sessions.sessionPolicy,
      );
      const allowed: DirectoryBindingOption[] = [];
      for (const option of services.directory!.options) {
        const group = (
          await db.query("SELECT team_id FROM access_groups WHERE id=$1", [
            option.groupId,
          ])
        ).rows[0];
        if (!group) continue;
        try {
          await services.directory!.assertGroupAdmin(
            db,
            ctx,
            option.groupId,
            group.team_id,
          );
          allowed.push(option);
        } catch (e) {
          if (
            e instanceof Error &&
            ["FORBIDDEN", "NOT_FOUND"].includes(e.message)
          )
            continue;
          throw e;
        }
      }
      if (method === "GET") {
        const items = [];
        for (const option of allowed.slice(offset, offset + 25)) {
          const row = (
            await db.query(
              "SELECT revision,active FROM identity_directory_bindings WHERE issuer=$1 AND external_group_id=$2 AND group_id=$3",
              [option.issuer, option.externalGroupId, option.groupId],
            )
          ).rows[0];
          items.push({
            key: option.key,
            label: option.label,
            revision: row?.revision ?? 0,
            active: row?.active ?? false,
          });
        }
        return {
          status: 200,
          body: { items, total: allowed.length, offset, limit: 25 },
        };
      }
      if (method === "PUT") {
        const input = z
          .object({
            key: z.string(),
            expectedRevision: z.number().int().nonnegative(),
            active: z.boolean(),
          })
          .strict()
          .parse(body);
        const option = allowed.find((o) => o.key === input.key);
        if (!option) throw Error("FORBIDDEN");
        return {
          status: 200,
          body: await bindDirectoryGroup(
            db,
            ctx,
            {
              issuer: option.issuer,
              externalGroupId: option.externalGroupId,
              groupId: option.groupId,
              expectedRevision: input.expectedRevision,
              active: input.active,
            },
            services.directory!.assertGroupAdmin,
            { allowLoopbackHttp: services.directory!.allowLoopbackHttp },
          ),
        };
      }
      throw Error("NOT_FOUND");
    });
  }
  throw Error("NOT_FOUND");
}
