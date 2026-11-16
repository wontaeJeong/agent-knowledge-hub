import { test, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as oidc from "openid-client";
import { fixture, adoptFixture, page } from "../test-support";
import { transaction } from "../database";
import { capturePublishedVersionMetadata } from "../workflows/versions/service";
import { AccessService } from "../access/index";
import { RuntimeService } from "./knowledge";
import { createRuntimeHandler } from "./http";
import { OidcAuth, sessionHash } from "./auth";

async function host() {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const provider = createServer((req, res) => {
    const sub = req.headers.authorization?.replace("Bearer ", "") ?? "";
    res.setHeader("Content-Type", "application/json");
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
    editor: "editor",
    reviewer: "reviewer",
    reader: "reader",
  });
  const cookies: Record<string, string> = {};
  for (const principal of ["editor", "reviewer", "reader"]) {
    cookies[principal] = randomUUID();
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,'csrf',now()+interval '1 hour',$3,$3)",
      [sessionHash(cookies[principal]), f.workspaceId, principal],
    );
  }
  const runtime = new RuntimeService(f.pool);
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (
    path: string,
    principal = "reader",
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await fetch(base + "/api/v1/versions" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: `akh_session=${cookies[principal] ?? "missing"}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  const close = async () => {
    for (const s of [server, provider])
      await new Promise<void>((r) => s.close(() => r()));
    await f.pool.end();
  };
  return { ...f, runtime, request, close };
}

test("native version history and paginated compare preserve authentication, CSRF, unknown metadata and current source ACL", async () => {
  const h = await host();
  try {
    expect((await h.request("/pages/topic/history", "missing")).status).toBe(
      401,
    );
    const history = await h.request("/pages/topic/history");
    expect(history.status).toBe(200);
    expect(history.body.items).toEqual([
      expect.objectContaining({ number: 1, metadataKnown: false }),
    ]);
    await h.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
      h.workspaceId,
      {
        ...page.versions[0],
        number: 2,
        content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
      },
    ]);
    const compare = await h.request("/pages/topic/compare", "reader", {
      from: 1,
      to: 2,
      offset: 25,
    });
    expect(compare.status).toBe(200);
    expect(compare.body.text).toMatchObject({ offset: 25, next: 50 });
    expect(compare.body.text.lines).toHaveLength(25);
    expect(
      compare.body.metadata.every((m: { known: boolean }) => !m.known),
    ).toBe(true);
    expect(
      (
        await h.request(
          "/pages/topic/compare",
          "reader",
          { from: 1, to: 2 },
          { "X-CSRF-Token": "bad" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await h.request("/pages/topic/compare", "reader", { from: 0, to: 2 }))
        .status,
    ).toBe(400);
    await h.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
      [h.workspaceId],
    );
    expect((await h.request("/pages/topic/history")).status).toBe(404);
  } finally {
    await h.close();
  }
});

test("native restore creates only a pending proposal; reader, stale preview and credential writes are blocked", async () => {
  const h = await host();
  try {
    await transaction(h.pool, h.workspaceId, async (db) => {
      await db.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
        h.workspaceId,
        { ...page.versions[0], number: 2 },
      ]);
      await capturePublishedVersionMetadata(db, h.editor, "topic", 2);
      await db.query(
        "INSERT INTO batches VALUES($1,'published','{\"status\":\"published\"}','fixture')",
        [h.workspaceId],
      );
      await db.query("INSERT INTO publications VALUES($1,'published',$2)", [
        h.workspaceId,
        { batchId: "published", versions: { topic: 2 } },
      ]);
    });
    const selection = {
      batchId: "published",
      pages: [{ pageId: "topic", fields: ["content"] }],
    };
    expect(
      (await h.request("/restore/preview", "reader", selection)).status,
    ).toBe(403);
    const preview = await h.request("/restore/preview", "editor", selection);
    expect(preview.status).toBe(200);
    expect(preview.body.conflicts).toEqual([]);
    const proposed = await h.request("/restore/propose", "editor", {
      previewHash: preview.body.previewHash,
      reason: "본문 복원 검토",
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({
      status: "pending",
      requiresIndependentReview: true,
    });
    expect(
      (
        await h.pool.query("SELECT 1 FROM approvals WHERE workspace_id=$1", [
          h.workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await h.pool.query("SELECT 1 FROM publications WHERE workspace_id=$1", [
          h.workspaceId,
        ])
      ).rowCount,
    ).toBe(1);
    await h.pool.query("INSERT INTO versions VALUES($1,'topic',3,$2)", [
      h.workspaceId,
      { ...page.versions[0], number: 3, content: "later human change" },
    ]);
    const stale = await h.request("/restore/propose", "editor", {
      previewHash: preview.body.previewHash,
      reason: "오래된 미리보기",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("STALE_VERSION");
    const secret = (
      await new AccessService(h.pool).issueCredential(h.editor, {
        actions: ["knowledge.read", "changeset.propose"],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      })
    ).secret;
    expect(
      (
        await h.request("/restore/preview", "editor", selection, {
          Authorization: `Bearer ${secret}`,
        })
      ).status,
    ).toBe(403);
  } finally {
    await h.close();
  }
});

test("native partial decisions expose dependency conflicts and preserve independent approval", async () => {
  const h = await host();
  try {
    const b = await h.runtime.core.propose(
      h.editor,
      [
        {
          id: "first",
          title: "First",
          summary: "Test",
          content: "First",
          scope: "team",
          baseVersion: 0,
          sourceIds: ["source-a"],
          links: ["second"],
          facts: [],
        },
        {
          id: "second",
          title: "Second",
          summary: "Test",
          content: "Second",
          scope: "team",
          baseVersion: 0,
          sourceIds: ["source-a"],
          links: [],
          facts: [],
        },
      ],
      ["source-a"],
    );
    const input = {
      batchId: b.id,
      expectedHash: b.hash,
      pageIds: ["first"],
      decision: "approve",
    };
    const preview = await h.request("/decisions/preview", "reviewer", input);
    expect(preview.status).toBe(200);
    expect(preview.body.allowed).toBe(false);
    const blocked = await h.request("/decisions", "reviewer", {
      ...input,
      reasons: { first: "검토" },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("DEPENDENCY_CLOSURE_REQUIRED");
    const selected = await h.request("/decisions", "reviewer", {
      ...input,
      pageIds: ["first", "second"],
      reasons: { first: "의존 포함", second: "의존 포함" },
    });
    expect(selected.status).toBe(201);
    expect(selected.body.batchId).not.toBe(b.id);
    const row = (
      await h.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [h.workspaceId, selected.body.batchId],
      )
    ).rows[0];
    expect(row.data.status).toBe("pending");
    expect(row.data.proposedBy).toBe("editor");
    expect(
      (
        await h.pool.query("SELECT 1 FROM approvals WHERE workspace_id=$1", [
          h.workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    await h.close();
  }
});

test("native restore rechecks source access after preview and rejects protected page mutation", async () => {
  const h = await host();
  try {
    await h.pool.query(
      "INSERT INTO batches VALUES($1,'original-publication','{\"status\":\"published\"}','fixture')",
      [h.workspaceId],
    );
    await h.pool.query(
      "INSERT INTO publications VALUES($1,'original-publication',$2)",
      [
        h.workspaceId,
        { batchId: "original-publication", versions: { topic: 1 } },
      ],
    );
    const selection = {
      batchId: "original-publication",
      pages: [{ pageId: "topic", fields: ["content"] }],
    };
    const preview = await h.request("/restore/preview", "editor", selection);
    expect(preview.status).toBe(200);
    await h.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [h.workspaceId],
    );
    expect(
      (
        await h.request("/restore/propose", "editor", {
          previewHash: preview.body.previewHash,
          reason: "권한 변경 후 시도",
        })
      ).status,
    ).toBe(404);
    await h.pool.query(
      "INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'source','source-a','editor')",
      [h.workspaceId],
    );
    await h.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"protected\":true}')",
      [h.workspaceId],
    );
    const protectedPreview = await h.request(
      "/restore/preview",
      "editor",
      selection,
    );
    expect(protectedPreview.status).toBe(200);
    expect(
      (
        await h.request("/restore/propose", "editor", {
          previewHash: protectedPreview.body.previewHash,
          reason: "보호 문서 시도",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.pool.query(
          "SELECT 1 FROM batches WHERE workspace_id=$1 AND data->>'status'='pending'",
          [h.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await h.close();
  }
});

test("native comment anchor comparison retains the original version and never rewrites the comment", async () => {
  const h = await host();
  try {
    await transaction(h.pool, h.workspaceId, async (db) => {
      await db.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
        h.workspaceId,
        { ...page.versions[0], number: 2 },
      ]);
      await capturePublishedVersionMetadata(db, h.editor, "topic", 2);
      await db.query("INSERT INTO versions VALUES($1,'topic',3,$2)", [
        h.workspaceId,
        { ...page.versions[0], number: 3, content: "새 단락\n\n기존 내용" },
      ]);
      await capturePublishedVersionMetadata(db, h.editor, "topic", 3);
    });
    await h.pool.query(
      "INSERT INTO workflow_comments(workspace_id,id,page_id,principal_id,revision,version,anchor,data) VALUES($1,'comment-anchor','topic','reviewer',1,2,'기존 내용','{\"body\":\"검토 의견\"}')",
      [h.workspaceId],
    );
    const result = await h.request(
      "/comments/comment-anchor/anchor",
      "reader",
      { targetVersion: 3 },
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      originalVersion: 2,
      targetVersion: 3,
      status: "moved",
      resolved: true,
      target: { startLine: 3, endLine: 3 },
    });
    expect(
      (
        await h.pool.query(
          "SELECT version,anchor FROM workflow_comments WHERE workspace_id=$1 AND id='comment-anchor'",
          [h.workspaceId],
        )
      ).rows[0],
    ).toEqual({ version: 2, anchor: "기존 내용" });
  } finally {
    await h.close();
  }
});
