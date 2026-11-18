import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { adoptFixture, fixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { inventory } from "../retention/inventory";
import { migrate, assertSchemaCurrent } from "../database";

test("personal saved views persist across sessions, authorize runs afresh and serialize competing mutations", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  let expired = false;
  const auth = {
    authenticate: async (req: any) =>
      req.headers.cookie
        ? {
            ...(req.headers.cookie === "editor" ? f.editor : f.reader),
            csrfToken:
              req.headers.cookie === "reader-session-2" ? "csrf-new" : "csrf",
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin =
    "http://127.0.0.1:" +
    (server.address() as { port: number }).port +
    "/api/v1";
  const path = "/convenience/views";
  const call = (
    url = path,
    method = "GET",
    data?: unknown,
    cookie = "reader",
    csrf = "csrf",
  ) =>
    fetch(origin + url, {
      method,
      headers: {
        cookie,
        origin: "https://knowledge.example.test",
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const change = (revision: number) => ({
    expectedRevision: revision,
    mutationId: randomUUID(),
  });
  const filters = {
    query: "기존",
    tags: [],
    historical: false,
    limit: 25,
    sort: "recent",
  };
  const create = {
    name: "가".repeat(100),
    filters,
    sort: "recent",
    ...change(0),
  };
  try {
    expect((await call()).status).toBe(200);
    expect((await call(path, "POST", create, "reader", "invalid")).status).toBe(
      403,
    );
    for (const invalid of [
      { name: "가".repeat(101) },
      { filters: { unknown: true } },
      { filters: { cursor: "stale" } },
    ]) {
      expect((await call(path, "POST", { ...create, ...invalid })).status).toBe(
        400,
      );
    }
    const first = await call(path, "POST", create);
    expect(first.status).toBe(201);
    const saved = (await first.json()) as any;
    expect(saved).toMatchObject({ id: expect.any(String), revision: 1 });
    expect(await (await call(path, "POST", create)).json()).toEqual(saved);
    const item = path + "/" + saved.id;
    const bound = async (cookie: string, csrf: string, url = path) =>
      fetch(origin + url, {
        headers: {
          cookie,
          "x-expected-principal": "reader",
          "x-csrf-token": csrf,
          "x-space-id": f.workspaceId,
        },
      });
    const verified = await bound("reader", "csrf");
    expect(verified.headers.get("X-Personal-Scope-Verified")).toBe("1");
    for (const response of [
      await bound("editor", "csrf"),
      await bound("reader-session-2", "csrf", item),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "SESSION_CHANGED" });
      expect(response.headers.has("X-Personal-Scope-Verified")).toBe(false);
    }
    expect((await bound("reader-session-2", "csrf-new", item)).status).toBe(
      200,
    );
    expect((await call(item, "GET", undefined, "editor")).status).toBe(404);
    expect(
      (await (await call(path, "GET", undefined, "editor")).json()).items,
    ).toEqual([]);
    const restored = await (
      await call(item, "GET", undefined, "reader-session-2")
    ).json();
    expect(restored).toMatchObject({
      name: create.name,
      ownerId: "reader",
      workspaceId: f.workspaceId,
      filters,
    });
    expect(
      (await (await call("/questions/search", "POST", restored.filters)).json())
        .items,
    ).toHaveLength(1);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND principal_id='reader' AND kind='source'",
      [f.workspaceId],
    );
    expect(
      (await (await call("/questions/search", "POST", restored.filters)).json())
        .items,
    ).toEqual([]);
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','source-a','reader')",
      [f.workspaceId],
    );
    await f.pool.query("INSERT INTO resources VALUES($1,'page','parent')", [
      f.workspaceId,
    ]);
    await f.pool.query(
      'INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,\'parent\',data || \'{"id":"parent","title":"parent"}\'::jsonb FROM pages WHERE workspace_id=$1 AND id=\'topic\'',
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO versions SELECT workspace_id,'parent',number,data || '{\"content\":\"parent\"}'::jsonb FROM versions WHERE workspace_id=$1 AND page_id='topic'",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page','parent','reader')",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id) VALUES($1,'topic','parent')",
      [f.workspaceId],
    );
    expect(
      (await (await call("/questions/search", "POST", restored.filters)).json())
        .items,
    ).toHaveLength(1);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='parent' AND principal_id='reader'",
      [f.workspaceId],
    );
    expect(
      (await (await call("/questions/search", "POST", restored.filters)).json())
        .items,
    ).toEqual([]);
    const rows = await inventory(f.pool as any, f.workspaceId);
    expect(
      JSON.stringify(
        rows.filter((row) => row.table.startsWith("personal_saved_view")),
      ),
    ).not.toContain(create.name);
    const edits = await Promise.all(
      ["a", "b"].map((name) =>
        call(item, "PATCH", { name, filters, sort: "recent", ...change(1) }),
      ),
    );
    expect(edits.map((r) => r.status).sort()).toEqual([200, 409]);
    const edited = await (await call(item)).json();
    const second = await (
      await call(path, "POST", { ...create, ...change(0) })
    ).json();
    const move = {
      direction: "up",
      ...change(second.revision),
      neighborId: saved.id,
      neighborRevision: edited.revision,
    };
    expect((await call(path + "/" + second.id, "PATCH", move)).status).toBe(
      200,
    );
    expect((await (await call()).json()).items.map((i: any) => i.id)).toEqual([
      second.id,
      saved.id,
    ]);
    expect((await call(item, "DELETE", change(edited.revision))).status).toBe(
      409,
    );
    const latest = await (await call(item)).json(),
      remove = change(latest.revision);
    expect((await call(item, "DELETE", remove)).status).toBe(200);
    expect((await call(item, "DELETE", remove)).status).toBe(200);
    expect((await call(item)).status).toBe(404);
    await migrate(f.pool);
    await assertSchemaCurrent(f.pool);
    expired = true;
    expect((await call()).status).toBe(401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.pool.end();
  }
});

test("the 100th view is admitted once under a concurrent create; other owner and space remain independent", async () => {
  const { SavedViewService } = await import("./views");
  const f = await fixture(),
    other = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    await adoptFixture(other.pool, other.workspaceId);
    const views = new SavedViewService(f.pool);
    const data = () => ({
      name: "🔎".repeat(100),
      filters: { query: "fixture term" },
      sort: "title",
      expectedRevision: 0,
      mutationId: randomUUID(),
    });
    const first = await views.save(f.reader, data());
    await expect(views.read(other.reader, first.id)).rejects.toThrow(
      "NOT_FOUND",
    );
    for (let i = 1; i < 99; i++) await views.save(f.reader, data());
    const results = await Promise.allSettled([
      views.save(f.reader, data()),
      views.save(f.reader, data()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason.message),
    ).toEqual(["SAVED_VIEW_CAPACITY"]);
    expect((await views.list(f.reader)).items).toHaveLength(100);
    await expect(views.save(f.editor, data())).resolves.toHaveProperty("id");
    await expect(views.save(other.reader, data())).resolves.toHaveProperty(
      "id",
    );
    await expect(
      views.read({ ...f.reader, credentialId: "fixture-machine" }, first.id),
    ).rejects.toThrow("FORBIDDEN");
  } finally {
    await Promise.all([f.pool.end(), other.pool.end()]);
  }
});

test("adjacent reorder racing a delete has exactly one winner and preserves the list", async () => {
  const { SavedViewService } = await import("./views");
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    const service = new SavedViewService(f.pool);
    const create = (name: string) =>
      service.save(f.reader, {
        name,
        filters: {},
        sort: "recent",
        expectedRevision: 0,
        mutationId: randomUUID(),
      });
    const a = await create("A"),
      b = await create("B");
    const attempts = await Promise.allSettled([
      service.save(f.reader, {
        id: b.id,
        direction: "up",
        neighborId: a.id,
        neighborRevision: a.revision,
        expectedRevision: b.revision,
        mutationId: randomUUID(),
      }),
      service.remove(f.reader, a.id, {
        expectedRevision: a.revision,
        mutationId: randomUUID(),
      }),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      attempts
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason.message),
    ).toEqual(["STALE_VERSION"]);
    expect((await service.list(f.reader)).items.map((view) => view.id)).toEqual(
      attempts[0].status === "fulfilled" ? [b.id, a.id] : [b.id],
    );
  } finally {
    await f.pool.end();
  }
});

test("private audit records exactly one operation and timestamp per committed nonce", async () => {
  const { SavedViewService } = await import("./views"),
    f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    const s = new SavedViewService(f.pool),
      d = {
        name: "private fixture",
        filters: { query: "private query" },
        sort: "title",
        expectedRevision: 0,
        mutationId: randomUUID(),
      };
    const [a, replay] = await Promise.all([
      s.save(f.reader, d),
      s.save(f.reader, d),
    ]);
    expect(replay).toEqual(a);
    await s.save(f.editor, d);
    const failed = randomUUID(),
      guard = "c11_guard_" + failed.replaceAll("-", "");
    await f.pool.query(
      "ALTER TABLE personal_saved_view_mutations ADD CONSTRAINT " +
        guard +
        " CHECK(mutation_id <> '" +
        failed +
        "'::uuid) NOT VALID",
    );
    try {
      await expect(
        s.save(f.reader, {
          ...d,
          id: a.id,
          name: "rolled back",
          expectedRevision: 1,
          mutationId: failed,
        }),
      ).rejects.toThrow();
      expect(await s.read(f.reader, a.id)).toMatchObject({
        name: d.name,
        revision: 1,
      });
    } finally {
      await f.pool.query(
        "ALTER TABLE personal_saved_view_mutations DROP CONSTRAINT " + guard,
      );
    }

    await expect(s.save(f.reader, { ...d, name: "another" })).rejects.toThrow(
      "STALE_VERSION",
    );
    const b = await s.save(f.reader, { ...d, mutationId: randomUUID() });
    const edit = {
      ...d,
      expectedRevision: 1,
      id: a.id,
      mutationId: randomUUID(),
    };
    expect(await s.save(f.reader, edit)).toEqual(await s.save(f.reader, edit));
    const move = {
      id: b.id,
      direction: "up",
      neighborId: a.id,
      neighborRevision: 2,
      expectedRevision: 1,
      mutationId: randomUUID(),
    };
    expect(await s.save(f.reader, move)).toEqual(await s.save(f.reader, move));
    const del = { expectedRevision: 2, mutationId: randomUUID() };
    await s.remove(f.reader, b.id, del);
    await s.remove(f.reader, b.id, del);
    const audit = (
      await f.pool.query(
        "SELECT owner_id,operation,applied_at,view_id FROM personal_saved_view_mutations WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows;
    expect(
      audit
        .filter((r) => r.owner_id === "reader")
        .map((r) => r.operation)
        .sort(),
    ).toEqual(["create", "create", "delete", "edit", "move"]);
    expect(
      audit.filter((r) => r.owner_id === "editor").map((r) => r.operation),
    ).toEqual(["create"]);
    expect(audit.every((r) => r.applied_at instanceof Date)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("private");
    expect(await s.list(f.ctx)).toEqual({ items: [] });
  } finally {
    await f.pool.end();
  }
});
