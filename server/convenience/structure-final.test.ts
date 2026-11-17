import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture, adoptFixture, page } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { WorkflowService } from "../workflows/service";
import { GovernanceService } from "../workflows/governance/service";
import { HomeService } from "./home";
import { authorizeInTransaction } from "../access";
let f: Awaited<ReturnType<typeof fixture>>,
  endpoint: string,
  rawSession: string;
let provider: ReturnType<typeof createServer>,
  server: ReturnType<typeof createServer>;
const clients: Client[] = [];
beforeEach(async () => {
  rawSession = randomUUID();
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const { versions, ...data } = page;
  await f.pool.query("INSERT INTO resources VALUES($1,'page','linked')", [
    f.workspaceId,
  ]);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT $1,'page','linked',unnest($2::text[])",
    [f.workspaceId, ["editor", "reviewer", "reader"]],
  );
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,'linked',$2)",
    [f.workspaceId, { ...data, id: "linked", title: "Linked" }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'linked',1,$2)", [
    f.workspaceId,
    versions[0],
  ]);
  provider = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ sub: "reviewer", groups: ["reviewers"] }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as any).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    reviewers: "reviewer",
  });
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','csrf',now()+interval '1 hour','reviewer','token')",
    [sessionHash(rawSession), f.workspaceId],
  );
  server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const s of [server, provider])
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  await f?.pool.end();
  delete process.env.IMPORT_DISCLOSURE_REVIEWERS;
});
async function call(path: string, body?: unknown, secret?: string) {
  const r = await fetch(endpoint + "/api/v1" + path, {
    method: body ? "POST" : "GET",
    headers: secret
      ? {
          Authorization: "Bearer " + secret,
          "X-Space-Id": f.workspaceId,
          "Content-Type": "application/json",
        }
      : {
          Cookie: `akh_session=${rawSession}`,
          Origin: "http://localhost",
          "X-CSRF-Token": "csrf",
          "Content-Type": "application/json",
        },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
async function issue(operation: string, input: unknown) {
  const r = await call("/convenience/credentials", {
    operation,
    input,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  expect(r.status).toBe(201);
  return r.body;
}
async function machine(
  transport: string,
  operation: string,
  input: any,
  secret: string,
) {
  if (transport === "HTTP")
    return call("/convenience/pages/" + operation, input, secret);
  const client = new Client({ name: "c7-final", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint + "/mcp"), {
      requestInit: {
        headers: {
          Authorization: "Bearer " + secret,
          "X-Space-Id": f.workspaceId,
        },
      },
    }),
  );
  try {
    const result = await client.callTool({
      name: "knowledge_" + operation,
      arguments: input,
    });
    return {
      status: result.isError ? 400 : 200,
      body: JSON.parse((result.content as any)[0].text),
    };
  } catch {
    return { status: 403, body: { code: "DENIED" } };
  }
}
async function placement() {
  const tree = await call("/convenience/tree");
  expect(tree.status).toBe(200);
  return {
    pageId: "topic",
    parentId: null,
    beforeId: "linked",
    expectedRevision: 0,
    expectedStructureRevision: tree.body.revision,
    reason: "exact issued reorder",
    mutationId: randomUUID(),
  };
}
test.each(["HTTP", "MCP"])(
  "actual issued %s before-neighbor token executes and replays unchanged",
  async (transport) => {
    const input = await placement(),
      grant = await issue("move", input);
    const first = await machine(transport, "move", input, grant.secret);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      id: "topic",
      revision: 1,
      parentId: null,
    });
    expect(await machine(transport, "move", input, grant.secret)).toEqual(
      first,
    );
    const tree = await call("/convenience/tree");
    expect(tree.body.items.map((x: any) => x.id)).toEqual(["topic", "linked"]);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM workflow_events WHERE workspace_id=$1 AND resource_id='topic' AND kind='page.structure.move'",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
test.each(["neighbor", "ACL", "credential"])(
  "issued placement rejects queued %s changes without partial move",
  async (change) => {
    const input = await placement(),
      grant = await issue("move", input),
      db = await f.pool.connect();
    await db.query("BEGIN");
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      f.workspaceId,
    ]);
    let pending: ReturnType<typeof call> | undefined;
    try {
      pending = call("/convenience/pages/move", input, grant.secret);
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const r = await f.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspaces%'",
        );
        if (r.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      if (change === "neighbor")
        await db.query(
          "INSERT INTO workflow_document_order(workspace_id,page_id,position) VALUES($1,'linked',100) ON CONFLICT(workspace_id,page_id) DO UPDATE SET position=100",
          [f.workspaceId],
        );
      if (change === "ACL")
        await db.query(
          "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='linked' AND principal_id='reviewer'",
          [f.workspaceId],
        );
      if (change === "credential")
        await db.query(
          "UPDATE access_credentials SET revoked=true WHERE id=$1",
          [grant.id],
        );
      await db.query("COMMIT");
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
    const result = await pending!;
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await f.pool.query(
          "SELECT revision,parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id='topic'",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM workflow_events WHERE workspace_id=$1 AND resource_id='topic' AND kind='page.structure.move'",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
  },
);
test("ordinary and mixed credential rows still invalidate structure snapshots", async () => {
  for (const last of ["knowledge.read", null, "{malformed snapshot"]) {
    const input = await placement(),
      grant = await issue("move", input);
    // Mixed/unknown/null action payloads cannot qualify for the exact C7-only exclusion.
    await f.pool.query(
      "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES($1,$2,'reviewer',$3,$4,now()+interval '1 hour')",
      [
        randomUUID(),
        randomUUID(),
        f.workspaceId,
        ["c7.operation.v1", "move", "a".repeat(64), "b".repeat(64), last],
      ],
    );
    expect(
      (await call("/convenience/pages/move", input, grant.secret)).body.code,
    ).toBe("STALE_VERSION");
  }
  const next = await placement(),
    nextGrant = await issue("move", next);
  const ordinary = await call("/credentials", {
    actions: ["knowledge.read"],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  expect(ordinary.status).toBe(201);
  expect(
    (await call("/convenience/pages/move", next, nextGrant.secret)).body.code,
  ).toBe("STALE_VERSION");
});
test.each(["relative", "absolute", "external"])(
  "%s rendered-link lineage and replay have actual HTTP/MCP parity",
  async (kind) => {
    const path = `/?app=1&space=${f.workspaceId}&document=linked`,
      href =
        kind === "relative"
          ? path
          : (kind === "absolute"
              ? "http://localhost"
              : "https://external.invalid") + path;
    await f.pool.query(
      "UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1 AND page_id='topic'",
      [f.workspaceId, `[Linked](${href})`],
    );
    const copies = [];
    for (const transport of ["HTTP", "MCP"]) {
      const input = {
          pageId: "topic",
          version: 1,
          parentId: null,
          mutationId: randomUUID(),
        },
        grant = await issue("duplicate", input);
      const first = await machine(transport, "duplicate", input, grant.secret);
      expect(first.status).toBe(200);
      expect(first.body.dependencyVersions).toEqual(
        kind === "external" ? { topic: 1 } : { topic: 1, linked: 1 },
      );
      expect(
        await machine(transport, "duplicate", input, grant.secret),
      ).toEqual(first);
      copies.push({ transport, input, grant, first });
    }
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='linked' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    for (const c of copies) {
      const replay = await machine(
        c.transport,
        "duplicate",
        c.input,
        c.grant.secret,
      );
      if (kind === "external") expect(replay).toEqual(c.first);
      else {
        expect(replay.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(replay.body)).not.toContain("[Linked]");
      }
    }
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    for (const c of copies) {
      const replay = await machine(
        c.transport,
        "duplicate",
        c.input,
        c.grant.secret,
      );
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(replay.body)).not.toContain("[Linked]");
    }
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM workflow_drafts WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(2);
  },
);
test("C6 and Home cursors retain credential issuance/current-authority invalidation", async () => {
  process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
  const workflows = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
    "http://localhost",
  );
  for (let i = 0; i < 26; i++) {
    const id = "cursor-" + i;
    await workflows.saveDraft(f.editor, {
      id,
      expectedRevision: 0,
      title: id,
      content: "private",
    });
    await workflows.manualDisclosures.request(f.editor, id, {
      expectedRevision: 1,
      title: id,
      parentId: null,
      readers: ["editor", "reviewer"],
      reviewerId: "reviewer",
      reason: "share",
      mutationId: randomUUID(),
    });
  }
  const home = new HomeService(
    f.pool,
    workflows,
    new GovernanceService(f.pool, authorizeInTransaction),
  );
  const first = await home.widget(f.editor, "drafts"),
    manual = await workflows.manualDisclosures.list(f.editor, {});
  expect(first.nextCursor).toBeTruthy();
  expect(manual.nextCursor).toBeTruthy();
  await issue("duplicate", {
    pageId: "topic",
    version: 1,
    parentId: null,
    mutationId: randomUUID(),
  });
  await expect(
    home.widget(f.editor, "drafts", first.nextCursor!),
  ).rejects.toThrow("STALE_CURSOR");
  await expect(
    workflows.manualDisclosures.list(f.editor, { cursor: manual.nextCursor! }),
  ).rejects.toThrow("STALE_CURSOR");
});
