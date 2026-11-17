import { test, expect } from "vitest";
import { createServer } from "node:http";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { WorkflowService } from "../workflows/service";
import { authorizeInTransaction } from "../access";
import { createRuntimeHandler } from "../runtime/http";
import { PersonalLibraryService } from "./personal";
import { migrate, assertSchemaCurrent } from "../database";
import { inventory } from "../retention/inventory";
test("native personal HTTP endpoints preserve identity/CSRF, legacy toggles, current ACL and non-visit rendering", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  let expired = false;
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
      service: new RuntimeService(f.pool),
      origin: "https://knowledge.example.test",
      workspaceId: f.workspaceId,
      auth,
    } as any),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`,
    headers = {
      cookie: "reader",
      origin: "https://knowledge.example.test",
      "content-type": "application/json",
      "x-csrf-token": "csrf",
    };
  const get = (path: string) => fetch(base + path, { headers });
  const post = (path: string, body: unknown, extra = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  try {
    expect((await fetch(base + "/workflows/favorites")).status).toBe(401);
    expect(
      (
        await post(
          "/workflows/pages/topic/favorite",
          { enabled: true },
          { "x-csrf-token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("/workflows/pages/topic/favorite", { enabled: true })).status,
    ).toBe(200);
    expect(
      (await post("/workflows/pages/topic/subscribe", { enabled: true }))
        .status,
    ).toBe(200);
    expect(
      await (await get("/workflows/pages/topic/personal-state")).json(),
    ).toEqual({ favorite: true, subscribed: true });
    const first = (await (
      await get("/workflows/favorites?limit=25")
    ).json()) as any;
    expect(first.items.map((i: any) => i.id)).toEqual(["topic"]);
    expect((await get("/workflows/favorites?limit=26")).status).toBe(400);
    expect((await get("/workflows/favorites?cursor=forged")).status).toBe(409);
    expect(await (await get("/workflows/recent")).json()).toMatchObject({
      items: [],
    });
    expect((await get("/workflows/subscriptions")).status).toBe(200);
    const input = {
      pageIds: ["topic"],
      expectedRevision: first.revision,
      mutationId: "reorder",
    };
    expect((await post("/workflows/favorites/reorder", input)).status).toBe(
      200,
    );
    expect((await post("/workflows/favorites/reorder", input)).status).toBe(
      200,
    );
    expect(
      (
        await post("/workflows/favorites/reorder", {
          ...input,
          mutationId: "stale",
        })
      ).status,
    ).toBe(409);
    expect(
      (await post("/workflows/favorites/reorder", input, { cookie: "editor" }))
        .status,
    ).toBe(404);
    expect((await get("/workflows/pages/topic")).status).toBe(200);
    expect((await get("/workflows/pages/topic")).status).toBe(200);
    expect(await (await get("/workflows/recent")).json()).toMatchObject({
      items: [{ id: "topic" }],
    });
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
      [f.workspaceId],
    );
    for (const kind of ["favorites", "recent", "subscriptions"])
      expect(await (await get("/workflows/" + kind)).json()).toMatchObject({
        items: [],
      });
    expect((await get("/workflows/pages/topic/personal-state")).status).toBe(
      404,
    );
    expect((await post("/workflows/favorites/reorder", input)).status).toBe(
      404,
    );
    expired = true;
    expect((await get("/workflows/favorites")).status).toBe(401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
test("141 upgrades legacy activity without backfill loss, restarts idempotently and classifies content-free controls", async () => {
  const f = await fixture();
  try {
    await f.pool.query(
      "DROP TABLE workflow_personal_library_mutations;DROP TABLE workflow_personal_library_state;ALTER TABLE workflow_activity DROP COLUMN position;DELETE FROM schema_migrations WHERE version=141",
    );
    await f.pool.query(
      "INSERT INTO workflow_activity VALUES($1,'reader','topic','favorite','2026-11-17')",
      [f.workspaceId],
    );
    await expect(assertSchemaCurrent(f.pool)).rejects.toThrow(
      "SCHEMA_NOT_CURRENT",
    );
    await migrate(f.pool);
    await assertSchemaCurrent(f.pool);
    await f.pool.query(
      "INSERT INTO workflow_activity VALUES($1,'reader','topic','recent','2026-11-17')",
      [f.workspaceId],
    );
    const before = (
      await f.pool.query(
        "SELECT * FROM workflow_activity WHERE workspace_id=$1 ORDER BY kind",
        [f.workspaceId],
      )
    ).rows;
    expect(before).toHaveLength(2);
    expect(before.every((r) => r.position === null)).toBe(true);
    await migrate(f.pool);
    expect(
      (
        await f.pool.query(
          "SELECT * FROM workflow_activity WHERE workspace_id=$1 ORDER BY kind",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual(before);
    const db = await f.pool.connect();
    try {
      await expect(inventory(db, f.workspaceId)).resolves.toBeDefined();
      await db.query(
        "ALTER TABLE workflow_personal_library_mutations ADD COLUMN unclassified_content text",
      );
      await expect(inventory(db, f.workspaceId)).rejects.toThrow(
        "RETENTION_GRAPH_UNSUPPORTED",
      );
    } finally {
      db.release();
    }
  } finally {
    await f.pool.end();
  }
});
test("concurrent favorite toggles and reorder share a revision lock; post-computation session revocation prevents disclosure", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    const workflows = new WorkflowService(
        f.pool,
        new RuntimeService(f.pool),
        authorizeInTransaction,
      ),
      library = new PersonalLibraryService(workflows);
    await workflows.favorite(f.reader, "topic", true);
    const before = await library.list(f.reader, { kind: "favorites" });
    await Promise.all([
      workflows.favorite(f.reader, "topic", false),
      library
        .reorderFavorites(f.reader, {
          pageIds: ["topic"],
          expectedRevision: before.revision,
          mutationId: "race",
        })
        .catch((e) => expect(e.message).toMatch(/NOT_FOUND|STALE_VERSION/)),
    ]);
    expect((await library.list(f.reader, { kind: "favorites" })).items).toEqual(
      [],
    );
    let checks = 0;
    const ctx = {
      ...f.reader,
      authorization: {
        revalidate: async () => {
          if (++checks === 2) throw Error("UNAUTHENTICATED");
        },
        assertSession: async () => {},
      },
    };
    await expect(
      library.list(ctx as any, { kind: "favorites" }),
    ).rejects.toThrow("UNAUTHENTICATED");
  } finally {
    await f.pool.end();
  }
});
