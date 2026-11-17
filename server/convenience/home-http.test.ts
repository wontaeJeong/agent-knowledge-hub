import { test, expect } from "vitest";
import { createServer } from "node:http";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { WorkflowService } from "../workflows/service";
import { authorizeInTransaction } from "../access";
import { createRuntimeHandler } from "../runtime/http";
test("authenticated Home HTTP keeps own scope, strict cursor queries, current ACL and global session failure", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const runtime = new RuntimeService(f.pool);
  const workflows = new WorkflowService(
    f.pool,
    runtime,
    authorizeInTransaction,
  );
  await workflows.saveDraft(f.editor, {
    id: "exact",
    expectedRevision: 0,
    title: "own",
    content: "never in home",
  });
  await workflows.saveDraft(f.ctx, {
    id: "other",
    expectedRevision: 0,
    title: "OTHER_SECRET",
    content: "private",
  });
  let expired = false;
  const auth = {
    authenticate: async (req: any) =>
      req.headers.cookie
        ? {
            ...(req.headers.cookie === "editor" ? f.editor : f.reader),
            csrfToken: "test",
          }
        : null,
    requestGuard: () => ({
      revalidate: async () => {
        if (expired) throw Error("UNAUTHENTICATED");
      },
      assertSession: async () => {
        if (expired) throw Error("UNAUTHENTICATED");
      },
    }),
  };
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      origin: "https://home.example.test",
      workspaceId: f.workspaceId,
      auth,
    } as any),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1/convenience/home`;
  const get = (query = "", cookie = "editor") =>
    fetch(base + query, { headers: { cookie } });
  try {
    expect((await fetch(base)).status).toBe(401);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const h = (await response.json()) as any;
    expect(h.drafts.items.map((x: any) => x.id)).toEqual(["exact"]);
    expect(JSON.stringify(h)).not.toContain("OTHER_SECRET");
    expect(JSON.stringify(h)).not.toContain("never in home");
    expect(h.failedJobs.status).toBe("error");
    expect(h.favorites.status).toBe("ready");
    expect((await get("?widget=drafts&principalId=reviewer")).status).toBe(400);
    expect((await get("?widget=drafts&widget=requests")).status).toBe(400);
    expect((await get("?cursor=forged")).status).toBe(400);
    expect((await get("?widget=drafts&cursor=forged")).status).toBe(409);
    expect((await get("?widget=drafts", "reader")).status).toBe(403);
    expect(
      (await workflows.personalSnapshot(f.editor, "recent")).items,
    ).toEqual([]);
    expired = true;
    expect((await get()).status).toBe(401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
