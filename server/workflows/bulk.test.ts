import { beforeEach, afterEach, expect, test } from "vitest";
import { fixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { WorkflowService } from "./service";
import { membership } from "../repository";
let f: Awaited<ReturnType<typeof fixture>>, service: WorkflowService;
beforeEach(async () => {
  f = await fixture();
  service = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    async (db, ctx, action) => {
      const role = await membership(db, ctx);
      if (action !== "knowledge.read" && role !== "reviewer")
        throw Error("FORBIDDEN");
    },
  );
});
afterEach(async () => {
  await f.pool.end();
});
test("bulk preview does not change document metadata; apply preserves other properties and enforces CAS", async () => {
  await service.setDocumentState(f.ctx, "topic", {
    expectedRevision: 0,
    properties: { environment: "prod", tags: "old" },
    reason: "prepare",
  });
  const preview = await service.bulkPreview(f.ctx, {
    pageIds: ["topic"],
    operation: { kind: "tags", tags: ["guide", "한글"] },
    reason: "분류 정리",
  });
  expect(preview.items[0]).toMatchObject({
    id: "topic",
    status: "ready",
    expectedRevision: 1,
  });
  expect(
    (await service.document(f.ctx, "topic")).settings.data.properties.tags,
  ).toBe("old");
  const applied = await service.bulkApply(f.ctx, { token: preview.token });
  expect(applied.items[0]).toMatchObject({
    id: "topic",
    status: "applied",
    revision: 2,
  });
  expect(
    (await service.document(f.ctx, "topic")).settings.data.properties,
  ).toEqual({ environment: "prod", tags: "old" });
  expect((await service.document(f.ctx, "topic")).page.tags).toEqual([
    "guide",
    "한글",
  ]);
  const { adoptFixture } = await import("../test-support");
  await adoptFixture(f.pool, f.workspaceId);
  const { ScopedSearch } = await import("../questions/search");
  const search = new ScopedSearch(f.pool, {
    runtime: service.runtime,
    authorize: service.authorize,
  });
  expect(
    (await search.search(f.ctx, { tags: ["guide"] })).items.map(
      (i) => i.pageId,
    ),
  ).toContain("topic");
  expect(
    (await service.bulkApply(f.ctx, { token: preview.token })).items[0],
  ).toMatchObject({ status: "applied", revision: 2 });
});
test("bulk operations keep per-target failures and reject forged or cross-user previews", async () => {
  const preview = await service.bulkPreview(f.ctx, {
    pageIds: ["topic", "missing"],
    operation: { kind: "archive" },
    reason: "문서 보관",
  });
  expect(preview.items.map((x) => x.status)).toEqual(["ready", "unavailable"]);
  await expect(
    service.bulkApply(f.editor, { token: preview.token }),
  ).rejects.toThrow("INVALID_BULK_PREVIEW");
  await expect(
    service.bulkApply(f.ctx, { token: preview.token + "x" }),
  ).rejects.toThrow("INVALID_BULK_PREVIEW");
  const denied = await service.bulkPreview(f.reader, {
    pageIds: ["topic"],
    operation: { kind: "archive" },
    reason: "권한 없음",
  });
  expect(denied.items[0].status).toBe("unavailable");
  const result = await service.bulkApply(f.ctx, { token: preview.token });
  expect(result.items.map((x) => x.status)).toEqual(["applied", "skipped"]);
});
test("permission changes after preview prevent bulk writes", async () => {
  const preview = await service.bulkPreview(f.ctx, {
    pageIds: ["topic"],
    operation: { kind: "archive" },
    reason: "문서 보관",
  });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  const result = await service.bulkApply(f.ctx, { token: preview.token });
  expect(result.items[0]).toMatchObject({
    status: "unconfirmed",
    code: "OUTCOME_UNCONFIRMED",
  });
});
test("native runtime bulk routes require authenticated current roles and CSRF", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const oidc = await import("openid-client");
  const { OidcAuth, sessionHash } = await import("../runtime/auth");
  const { createRuntimeHandler } = await import("../runtime/http");
  const { adoptFixture } = await import("../test-support");
  await adoptFixture(f.pool, f.workspaceId);
  const provider = createServer((req, res) => {
    const sub = req.headers.authorization?.replace("Bearer ", "") ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ sub, groups: [sub] }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    reviewer: "reviewer",
    reader: "reader",
  });
  for (const user of ["reviewer", "reader"])
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,'csrf',now()+interval '1 hour',$3,$3)",
      [sessionHash("bulk-" + user), f.workspaceId, user],
    );
  const host = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  ).listen(0, "127.0.0.1");
  await once(host, "listening");
  const base = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  const request = async (
    path: string,
    body: unknown,
    user = "reviewer",
    csrf = "csrf",
  ) => {
    const r = await fetch(base + "/api/v1/workflows/bulk/" + path, {
      method: "POST",
      headers: {
        Cookie: "akh_session=bulk-" + user,
        Origin: "http://localhost",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const raw = {
      pageIds: ["topic"],
      operation: { kind: "archive" },
      reason: "인증된 일괄 편집",
    };
    expect((await request("preview", raw, "reviewer", "wrong")).status).toBe(
      403,
    );
    const preview = await request("preview", raw);
    expect(preview.status).toBe(200);
    expect(preview.body.items[0].status).toBe("ready");
    expect((await request("preview", raw, "reader")).body.items[0].status).toBe(
      "unavailable",
    );
    const applied = await request("apply", { token: preview.body.token });
    expect(applied.status).toBe(200);
    expect(applied.body.items[0].status).toBe("applied");
    expect(
      (await request("apply", { token: preview.body.token + "bad" })).status,
    ).toBe(409);
  } finally {
    await new Promise<void>((r) => host.close(() => r()));
    await new Promise<void>((r) => provider.close(() => r()));
  }
});

test("bulk recovers a committed result after response loss and reports unprocessed targets", async () => {
  const preview = await service.bulkPreview(f.ctx, {
    pageIds: ["topic"],
    operation: { kind: "archive" },
    reason: "복구 확인",
  });
  const apply = service.setDocumentState.bind(service);
  let lost = true;
  service.setDocumentState = async (
    ...args: Parameters<typeof service.setDocumentState>
  ) => {
    const r = await apply(...args);
    if (lost) {
      lost = false;
      throw Error("CONNECTION_LOST_AFTER_COMMIT");
    }
    return r;
  };
  expect(
    (await service.bulkApply(f.ctx, { token: preview.token })).items[0],
  ).toMatchObject({ status: "unconfirmed", code: "OUTCOME_UNCONFIRMED" });
  expect(
    (await service.bulkApply(f.ctx, { token: preview.token })).items[0],
  ).toMatchObject({ status: "applied", revision: 1 });
  expect((await service.document(f.ctx, "topic")).settings.revision).toBe(1);
});
test("partial commit receipts survive a later target failure and remaining targets resume once", async () => {
  for (const id of ["second", "third"]) {
    await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
      f.workspaceId,
      id,
    ]);
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,$2,data||jsonb_build_object('id',$2::text) FROM pages WHERE workspace_id=$1 AND id='topic'",
      [f.workspaceId, id],
    );
    await f.pool.query(
      "INSERT INTO versions SELECT workspace_id,$2,number,data FROM versions WHERE workspace_id=$1 AND page_id='topic'",
      [f.workspaceId, id],
    );
    await f.pool.query(
      "INSERT INTO resource_readers SELECT workspace_id,kind,$2,principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic'",
      [f.workspaceId, id],
    );
  }
  const preview = await service.bulkPreview(f.ctx, {
    pageIds: ["topic", "second", "third"],
    operation: { kind: "archive" },
    reason: "partial retry",
  });
  const apply = service.setDocumentState.bind(service);
  let fail = true;
  service.setDocumentState = async (
    ...args: Parameters<typeof service.setDocumentState>
  ) => {
    if (args[1] === "second" && fail) {
      fail = false;
      throw Error("VERSION_METADATA_LIMIT");
    }
    return apply(...args);
  };
  expect(
    (await service.bulkApply(f.ctx, { token: preview.token })).items.map(
      (i) => i.status,
    ),
  ).toEqual(["applied", "unconfirmed", "skipped"]);
  expect(
    (await service.bulkApply(f.ctx, { token: preview.token })).items.map(
      (i) => i.status,
    ),
  ).toEqual(["applied", "applied", "applied"]);
  for (const id of ["topic", "second", "third"])
    expect((await service.document(f.ctx, id)).settings.revision).toBe(1);
});
