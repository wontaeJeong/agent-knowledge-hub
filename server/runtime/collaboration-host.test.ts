import { test, expect } from "vitest";
import { createServer } from "node:http";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import {
  CollaborationService,
  resolveGovernanceResponsibility,
} from "../collaboration";
import { RuntimeService } from "./knowledge";
import { createRuntimeHandler } from "./http";
import type { OidcAuth } from "./auth";

test("runtime routes personal notifications through session, CSRF and current source ACL", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const collaboration = new CollaborationService(
    f.pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async () => {},
      verifyRecipient: async () => {
        throw Error("RECIPIENT_STATUS_UNKNOWN");
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  const auth = {
    authenticate: async (req: { headers: { cookie?: string } }) =>
      req.headers.cookie ? { ...f.editor, csrfToken: "csrf" } : null,
    requestGuard: () => ({
      revalidate: async () => {},
      assertSession: async () => {},
    }),
  } as unknown as OidcAuth;
  const handler = createRuntimeHandler({
    pool: f.pool,
    service: new RuntimeService(f.pool),
    origin: "https://knowledge.example.test",
    workspaceId: f.workspaceId,
    auth,
    collaboration,
  } as Parameters<typeof createRuntimeHandler>[0]);
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/collaboration`;
  const headers = {
    cookie: "session=fixture",
    origin: "https://knowledge.example.test",
    "x-csrf-token": "csrf",
    "content-type": "application/json",
  };
  try {
    expect((await fetch(base + "/preferences")).status).toBe(401);
    expect(
      (
        await fetch(base + "/preferences", {
          method: "POST",
          headers: { ...headers, "x-csrf-token": "wrong" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const pref = await fetch(base + "/preferences", { headers });
    expect(pref.status).toBe(200);
    await f.pool.query(
      "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data,created_at) VALUES($1,'notif','editor','topic',1,'mention','{}',now())",
      [f.workspaceId],
    );
    const list = await fetch(base + "/notifications?offset=0", { headers });
    const items = (
      (await list.json()) as {
        items: { events: { id: string; read: boolean }[] }[];
      }
    ).items;
    expect(items).toHaveLength(1);
    expect((items[0] as unknown as { url: string }).url).toBe(
      `https://knowledge.example.test/?app=1&space=${encodeURIComponent(f.workspaceId)}&document=topic`,
    );
    expect(items[0].events).toEqual([{ id: "notif", read: false }]);
    expect(
      (
        await fetch(base + "/notifications/notif/read", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.pool.query(
          "SELECT read_at FROM workflow_notifications WHERE workspace_id=$1 AND id='notif'",
          [f.workspaceId],
        )
      ).rows[0].read_at,
    ).toBeTruthy();
    const reread = (await (
      await fetch(base + "/notifications", { headers })
    ).json()) as { items: { events: { id: string; read: boolean }[] }[] };
    expect(reread.items[0].events).toEqual([{ id: "notif", read: true }]);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [f.workspaceId],
    );
    expect(
      (
        (await (await fetch(base + "/notifications", { headers })).json()) as {
          items: unknown[];
        }
      ).items,
    ).toEqual([]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});

test("runtime host exposes one durable worker and fails closed without an approved dispatcher", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  try {
    const runtime = await import("./http");
    const factory = (
      runtime as unknown as { createCollaborationHost?: Function }
    ).createCollaborationHost;
    expect(factory).toBeTypeOf("function");
    const host = factory!(f.pool, "https://knowledge.example.test", {});
    await expect(host.worker.tick()).rejects.toThrow(
      "COLLABORATION_DISPATCHER_NOT_CONFIGURED",
    );
    await expect(host.service.preferences(f.editor)).resolves.toMatchObject({
      revision: 0,
    });
  } finally {
    await f.pool.end();
  }
});

test("loopback development origin supports in-app notifications without enabling outbound delivery", async () => {
  const f = await fixture();
  try {
    const { createCollaborationHost } = await import("./http");
    expect(() =>
      createCollaborationHost(f.pool, "http://localhost:8080", {}),
    ).not.toThrow();
  } finally {
    await f.pool.end();
  }
});
test("configured recipient binding is intersected with current directory and database identity", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  try {
    await f.pool.query(
      "UPDATE access_principals SET active=true,issuer='https://id.example.test',subject='subject-1' WHERE id='editor'",
    );
    const { createCollaborationHost } = await import("./http");
    const now = Date.now();
    const host = createCollaborationHost(
      f.pool,
      "https://knowledge.example.test",
      {
        directoryProviderId: "fixture",
        directoryStatus: async (subject) => ({
          ...subject,
          active: true,
          verifiedAt: new Date(now).toISOString(),
          validUntil: new Date(now + 20000).toISOString(),
        }),
        recipientBinding: async () => ({
          address: "person@example.test",
          verifiedAt: new Date(now).toISOString(),
          validUntil: new Date(now + 10000).toISOString(),
        }),
      } as Parameters<typeof createCollaborationHost>[2],
    );
    const proof = await host.service.hooks.verifyRecipient(
      { workspaceId: f.workspaceId, principalId: "editor" },
      { signal: new AbortController().signal },
    );
    expect(proof.address).toBe("person@example.test");
    await f.pool.query(
      "UPDATE access_principals SET active=false WHERE id='editor'",
    );
    const db = await f.pool.connect();
    try {
      await expect(proof.assertCurrent(db)).rejects.toThrow(
        "RECIPIENT_DISABLED",
      );
    } finally {
      db.release();
    }
  } finally {
    await f.pool.end();
  }
});
test("a fresh email binding cannot refresh a stale directory identity assertion", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  try {
    await f.pool.query(
      "UPDATE access_principals SET active=true,issuer='https://id.example.test',subject='subject-1' WHERE id='editor'",
    );
    const { createCollaborationHost } = await import("./http");
    const now = Date.now();
    const host = createCollaborationHost(
      f.pool,
      "https://knowledge.example.test",
      {
        directoryProviderId: "fixture",
        directoryStatus: async (subject) => ({
          ...subject,
          active: true,
          verifiedAt: new Date(now - 60000).toISOString(),
          validUntil: new Date(now + 20000).toISOString(),
        }),
        recipientBinding: async () => ({
          address: "person@example.test",
          verifiedAt: new Date(now).toISOString(),
          validUntil: new Date(now + 10000).toISOString(),
        }),
      },
    );
    await expect(
      host.service.hooks.verifyRecipient(
        { workspaceId: f.workspaceId, principalId: "editor" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("RECIPIENT_STATUS_UNKNOWN");
  } finally {
    await f.pool.end();
  }
});
test("preferences save succeeds over HTTP when the background dispatcher is not configured", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const { createCollaborationHost } = await import("./http");
  const collaboration = createCollaborationHost(
    f.pool,
    "https://knowledge.example.test",
    {},
  );
  const auth = {
    authenticate: async () => ({ ...f.editor, csrfToken: "csrf" }),
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
      collaboration: collaboration.service,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(base + "/api/v1/collaboration/preferences", {
      method: "POST",
      headers: {
        origin: "https://knowledge.example.test",
        "x-csrf-token": "csrf",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 0, dailyDigest: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: 1,
      dailyDigest: true,
    });
    expect(
      (
        await f.pool.query(
          "SELECT revision FROM workflow_preferences WHERE workspace_id=$1 AND principal_id=$2",
          [f.workspaceId, "editor"],
        )
      ).rows[0].revision,
    ).toBe(1);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM collaboration_digest_outbox WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
