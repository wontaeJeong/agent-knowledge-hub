import { expect, test } from "vitest";
import { createServer } from "node:http";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import { CollaborationService, resolveGovernanceResponsibility } from "./index";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import type { OidcAuth } from "../runtime/auth";
test("native inbox endpoints enforce identity, CSRF, typed boundaries, CAS and current source ACL", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  let revoked = false;
  const service = new CollaborationService(
    f.pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async () => {},
      verifyRecipient: async () => {
        throw Error("UNCONFIGURED");
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  const auth = {
    authenticate: async (req: any) =>
      req.headers.cookie
        ? {
            ...(req.headers.cookie === "editor" ? f.editor : f.reader),
            csrfToken: "csrf",
          }
        : null,
    requestGuard: () => ({
      revalidate: async () => {
        if (revoked) throw Error("UNAUTHENTICATED");
      },
      assertSession: async () => {
        if (revoked) throw Error("UNAUTHENTICATED");
      },
    }),
  } as unknown as OidcAuth;
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      origin: "https://knowledge.example.test",
      workspaceId: f.workspaceId,
      auth,
      collaboration: service,
    } as any),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  const headers = {
    cookie: "reader",
    origin: "https://knowledge.example.test",
    "x-csrf-token": "csrf",
    "content-type": "application/json",
  };
  const post = (path: string, body: unknown, extra = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  try {
    await f.pool.query(
      "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data) VALUES($1,'n','reader','topic',1,'publication','{}')",
      [f.workspaceId],
    );
    expect((await fetch(base + "/collaboration/inbox")).status).toBe(401);
    const first = (await (
      await fetch(base + "/collaboration/inbox?limit=5", { headers })
    ).json()) as any;
    expect(first.items.map((i: any) => i.id)).toEqual(["n"]);
    expect(
      (
        await post(
          "/collaboration/inbox/n/state",
          { read: true, expectedRevision: 1, mutationId: "m" },
          { "x-csrf-token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/collaboration/inbox/read-all", {
          boundary: first.readBoundary + "x",
          mutationId: "tamper",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/collaboration/inbox/n/state", {
          read: true,
          expectedRevision: 1,
          mutationId: "m",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/collaboration/inbox/n/state", {
          read: false,
          expectedRevision: 1,
          mutationId: "stale",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post("/collaboration/inbox/n/state", {
          read: false,
          expectedRevision: 1,
          mutationId: "m",
        })
      ).status,
    ).toBe(409);
    await f.pool.query(
      "INSERT INTO workflow_access_requests(id,workspace_id,principal_id,resource_id,reason,status) VALUES('r',$1,'reader','hidden-page','private request','rejected')",
      [f.workspaceId],
    );
    const detail = await fetch(base + "/governance/access-requests/r", {
      headers,
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: "r",
      status: "rejected",
      readOnly: true,
    });
    expect(
      (
        await fetch(base + "/governance/access-requests/r", {
          headers: { ...headers, cookie: "editor" },
        })
      ).status,
    ).toBe(404);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND principal_id='reader' AND kind='source'",
      [f.workspaceId],
    );
    const cleared = (await (
      await fetch(base + "/collaboration/inbox", { headers })
    ).json()) as any;
    expect(cleared).toMatchObject({ items: [], unreadCount: 0 });
    revoked = true;
    expect(
      (await fetch(base + "/collaboration/inbox", { headers })).status,
    ).toBe(401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});

test("exact review HTTP reads distinguish pending, rejected and canonical author withdrawal with current membership and lineage", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const { KnowledgeService } = await import("../service");
  const { WorkflowService } = await import("../workflows/service");
  const core = new KnowledgeService(f.pool), runtime = new RuntimeService(f.pool);
  const auth = {
    authenticate: async (req: any) => ({
      ...(req.headers.cookie === "editor" ? f.editor : req.headers.cookie === "reviewer" ? f.ctx : f.reader), csrfToken: "csrf",
    }),
    requestGuard: () => ({ revalidate: async () => {}, assertSession: async () => {} }),
  } as unknown as OidcAuth;
  const server = createServer(createRuntimeHandler({ pool: f.pool, service: runtime,
    origin: "https://knowledge.example.test", workspaceId: f.workspaceId, auth } as any));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1/changesets/`;
  const read = (id: string, actor = "editor") => fetch(base + id, { headers: { cookie: actor } });
  const propose = () => core.propose(f.editor, [{ id: "topic", title: "protected review title", summary: "summary", content: "protected body", sourceIds: ["source-a"], baseVersion: 1, scope: "team", links: [], facts: [] }], ["source-a"]);
  try {
    const withdrawn = await propose();
    expect(await (await read(withdrawn.id)).json()).toMatchObject({ status: "pending", readOnly: true });
    expect((await read(withdrawn.id, "reviewer")).status).toBe(200);
    const other = await read(withdrawn.id, "reader");
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(await other.text()).not.toContain("protected review title");
    await new WorkflowService(f.pool, runtime, authorizeInTransaction).withdrawChangeset(f.editor, withdrawn.id, withdrawn.hash, "withdraw");
    expect((await read(withdrawn.id)).status).toBe(404);
    expect((await read(withdrawn.id, "reviewer")).status).toBe(404);
    const rejected = await propose();
    await runtime.reject(f.ctx, rejected.id, rejected.hash, "revise");
    expect(await (await read(rejected.id)).json()).toMatchObject({ status: "rejected", readOnly: true, reviewFeedback: { reason: "revise" } });
    await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'", [f.workspaceId]);
    const hidden = await read(rejected.id);
    expect(hidden.status).toBeGreaterThanOrEqual(400);
    expect(await hidden.text()).not.toContain("protected review title");
    await f.pool.query("DELETE FROM access_grants WHERE workspace_id=$1 AND principal_id='reviewer'", [f.workspaceId]);
    const removed = await read(rejected.id, "reviewer");
    expect(removed.status).toBeGreaterThanOrEqual(400);
    expect(await removed.text()).not.toContain("protected review title");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
