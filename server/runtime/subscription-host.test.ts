import { test, expect } from "vitest";
import { createServer } from "node:http";
import { fixture, adoptFixture, page } from "../test-support";
import { authorizeInTransaction } from "../access";
import {
  CollaborationService,
  resolveGovernanceResponsibility,
} from "../collaboration";
import { RuntimeService } from "./knowledge";
import { createRuntimeHandler } from "./http";
import type { OidcAuth } from "./auth";
test("native HTTP subscription and processing honor session, CSRF, input identity and current ACL", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
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
  let actor = f.reader;
  const auth = {
    authenticate: async (req: { headers: { cookie?: string } }) =>
      req.headers.cookie ? { ...actor, csrfToken: "csrf" } : null,
    requestGuard: () => ({
      revalidate: async () => {},
      assertSession: async () => {},
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
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/collaboration`;
  const headers = {
    cookie: "session=synthetic",
    origin: "https://knowledge.example.test",
    "x-csrf-token": "csrf",
    "content-type": "application/json",
  };
  const post = (route: string, body: unknown, extra = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  try {
    expect((await fetch(base + "/subscriptions")).status).toBe(401);
    expect(
      (
        await post(
          "/subscriptions",
          { scope: "space", enabled: true },
          { "x-csrf-token": "bad" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/subscriptions", {
          scope: "space",
          enabled: true,
          principalId: "editor",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/subscriptions", {
          scope: "topic",
          target: page.category,
          enabled: true,
        })
      ).status,
    ).toBe(200);
    expect((await fetch(base + "/subscriptions", { headers })).status).toBe(
      200,
    );
    actor = f.ctx;
    const expiryUrl = base.replace(
      "/collaboration",
      "/workflows/pages/topic/state",
    );
    const expiryBody = {
      expectedRevision: 0,
      effectiveUntil: "2020-01-01T00:00:00Z",
      reason: "Synthetic expiry review",
    };
    expect(
      (
        await fetch(expiryUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(expiryBody),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(expiryUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(expiryBody),
        })
      ).status,
    ).toBe(409);
    actor = f.reader;
    await service.scanEvents();
    const n = (await (
      await fetch(base + "/notifications", { headers })
    ).json()) as any;
    expect(n.items[0].events[0]).toMatchObject({
      kind: "expiry",
      processed: false,
    });
    expect(JSON.stringify(n)).not.toContain("envelope");
    const id = n.items[0].events[0].id;
    expect((await post(`/notifications/${id}/process`, {})).status).toBe(200);
    expect(
      (
        (await (
          await fetch(base + "/notifications", { headers })
        ).json()) as any
      ).items[0].events[0],
    ).toMatchObject({ read: true, processed: true });
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
      [f.workspaceId],
    );
    expect((await post(`/notifications/${id}/process`, {})).status).toBe(404);
    expect(
      (
        (await (
          await fetch(base + "/notifications", { headers })
        ).json()) as any
      ).items,
    ).toEqual([]);
    expect(
      (
        await post("/subscriptions", {
          scope: "topic",
          target: page.category,
          enabled: false,
        })
      ).status,
    ).toBe(200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
