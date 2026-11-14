import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import { StorageService } from "./service";
import { FileBlobStore } from "./content";
import {
  TrustedArtifactCollector,
  createCollectorJsonReader,
} from "./trusted-collector";
import { storageRoutes } from "./routes";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { testTlsCertificate } from "../test-tls-fixture";
import * as oidc from "openid-client";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  await f.pool.query(
    "UPDATE access_principals SET active=true WHERE id='editor'",
  );
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "UPDATE access_principals SET issuer='https://identity.invalid',subject='synthetic-editor' WHERE id='editor'",
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), "collector-test-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = new StorageService(
    f.pool,
    new FileBlobStore(root),
    authorizeInTransaction,
  );
  const artifact = JSON.parse(
    await readFile(
      new URL("./fixtures/opencode-2.2.2-synthetic.json", import.meta.url),
      "utf8",
    ),
  );
  const config = {
    id: "personal-host",
    workspaceId: f.workspaceId,
    principalId: "editor",
    issuer: "https://identity.invalid",
    subject: "synthetic-editor",
    label: "Synthetic personal host",
    baseUrl: "https://collector.invalid",
    versionPath: "/version",
    authorization: "Bearer synthetic-only",
    allowedSessionIds: [artifact.data.sessionID],
    excludedSessionIds: [],
    excludedText: [],
  };
  const requests: string[] = [];
  let version = "2.2.2";
  let onArtifact: undefined | (() => Promise<unknown>);
  const read = async (url: URL) => {
    requests.push(url.href);
    if (url.pathname === "/version") return { version };
    await onArtifact?.();
    return artifact;
  };
  const collector = new TrustedArtifactCollector(storage, [config], read);
  await collector.initialize();
  const input = {
    expectedRevision: 1,
    sessionId: artifact.data.sessionID,
    artifactId: artifact.data.id,
    format: "api.synthetic-message",
    selectedToolIds: [],
    title: "선택 자료",
    project: "합성 검증",
  };
  return {
    ...f,
    storage,
    collector,
    config,
    artifact,
    input,
    requests,
    setVersion: (v: string) => (version = v),
    setHook: (fn: () => Promise<unknown>) => (onArtifact = fn),
  };
}
test("fetches exactly the approved selected artifact into one private unverified source and deduplicates", async () => {
  const f = await setup();
  const a = await f.collector.collect(f.editor, "personal-host", f.input);
  const b = await f.collector.collect(f.editor, "personal-host", f.input);
  expect(b).toMatchObject({ id: a.id, duplicate: true });
  expect(f.requests).toContain(
    `https://collector.invalid/api/session/${f.input.sessionId}/message/${f.input.artifactId}`,
  );
  const rows = await f.pool.query(
    "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, a.id],
  );
  expect(rows.rows[0].data).toMatchObject({
    scope: "private",
    verification: "미검증",
    content: f.artifact.data.payload.text,
    tool: "opencode@2.2.2",
  });
});
test("unapproved sessions and unsupported changed provider version create no source", async () => {
  const f = await setup();
  const count = async () =>
    Number(
      (
        await f.pool.query(
          "SELECT count(*) n FROM sources WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    );
  const before = await count();
  await expect(
    f.collector.collect(f.editor, "personal-host", {
      ...f.input,
      sessionId: "ses_spoof",
    }),
  ).rejects.toThrow("COLLECTION_EXCLUDED");
  expect(f.requests).toHaveLength(0);
  f.setVersion("1.15.0");
  await expect(
    f.collector.collect(f.editor, "personal-host", f.input),
  ).rejects.toThrow("UNSUPPORTED_COLLECTOR_VERSION");
  expect(await count()).toBe(before);
});
test("connection revoked during fetch cannot store and restart cannot reactivate it", async () => {
  const f = await setup();
  const before = (
    await f.pool.query("SELECT count(*) n FROM sources WHERE workspace_id=$1", [
      f.workspaceId,
    ])
  ).rows;
  f.setHook(() => f.collector.revoke(f.editor, "personal-host", 1));
  await expect(
    f.collector.collect(f.editor, "personal-host", f.input),
  ).rejects.toThrow("COLLECTOR_CONNECTION_REVOKED");
  await f.collector.initialize();
  expect((await f.collector.list(f.editor)).items[0]).toMatchObject({
    active: false,
    revision: 2,
  });
  expect(
    (
      await f.pool.query(
        "SELECT count(*) n FROM sources WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual(before);
});
test("native storage extension fetches selected IDs and rejects caller-supplied artifact bodies", async () => {
  const f = await setup();
  const route = storageRoutes(f.storage, undefined, f.collector);
  let status = 0;
  let result: any;
  const send = (s: number, b: unknown) => {
    status = s;
    result = b;
  };
  expect(
    await route({
      method: "GET",
      path: "/api/v1/storage/collector-connections",
      body: null,
      ctx: f.editor,
      send,
    }),
  ).toBe(true);
  expect(result.items[0].id).toBe("personal-host");
  expect(JSON.stringify(result)).not.toContain("Bearer");
  expect(
    await route({
      method: "POST",
      path: "/api/v1/storage/collector-connections/personal-host/collect",
      body: f.input,
      ctx: f.editor,
      send,
    }),
  ).toBe(true);
  expect(status).toBe(201);
  expect(result.id).toBeTruthy();
  await expect(
    route({
      method: "POST",
      path: "/api/v1/storage/collector-connections/personal-host/collect",
      body: { ...f.input, artifact: f.artifact },
      ctx: f.editor,
      send,
    }),
  ).rejects.toThrow();
});
test("wrong owner, revoked identity and changed config never bypass current authorization", async () => {
  const f = await setup();
  await expect(
    f.collector.collect(f.reader, "personal-host", f.input),
  ).rejects.toThrow("NOT_FOUND");
  expect(f.requests).toHaveLength(0);
  await expect(
    new TrustedArtifactCollector(f.storage, [
      { ...f.config, label: "changed" },
    ]).initialize(),
  ).rejects.toThrow("COLLECTOR_CONFIGURATION_CHANGED");
  f.setHook(async () => {
    await f.pool.query(
      "UPDATE access_principals SET active=false WHERE id='editor'",
    );
  });
  await expect(
    f.collector.collect(f.editor, "personal-host", f.input),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT count(*) n FROM sources WHERE workspace_id=$1 AND data->>'tool'='opencode@2.2.2'",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe("0");
});
test("server exclusions and session identity apply to fetched bytes", async () => {
  const f = await setup();
  const c = new TrustedArtifactCollector(
    f.storage,
    [
      {
        ...f.config,
        id: "excluded-host",
        excludedText: [f.artifact.data.payload.text],
      },
    ],
    async (url) =>
      url.pathname === "/version" ? { version: "2.2.2" } : f.artifact,
  );
  await c.initialize();
  await expect(c.collect(f.editor, "excluded-host", f.input)).rejects.toThrow(
    "COLLECTION_EXCLUDED",
  );
  f.artifact.data.sessionID = "ses_someoneElse";
  await expect(
    f.collector.collect(f.editor, "personal-host", f.input),
  ).rejects.toThrow("ARTIFACT_SESSION_UNVERIFIED");
});
test("assistant selection omits reasoning and tool inputs, rejects incomplete response and preserves event order", async () => {
  const f = await setup();
  const assistant = JSON.parse(
    await readFile(
      new URL("./fixtures/opencode-2.2.2-assistant.json", import.meta.url),
      "utf8",
    ),
  );
  const c = new TrustedArtifactCollector(
    f.storage,
    [{ ...f.config, id: "assistant-host" }],
    async (url) =>
      url.pathname === "/version" ? { version: "2.2.2" } : assistant,
  );
  await c.initialize();
  const tool = assistant.data.content.find(
    (p: any) => p.type === "tool" && p.state.status === "completed",
  );
  tool.state.input = { secret: "DO_NOT_COPY_INPUT" };
  tool.state.content = [{ type: "text", text: "SYNTHETIC_TOOL_RESULT" }];
  const input = {
    ...f.input,
    artifactId: assistant.data.id,
    format: "api.assistant-message",
    selectedToolIds: [tool.id],
  };
  const a = await c.collect(f.editor, "assistant-host", input);
  const source = (
    await f.pool.query(
      "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, a.id],
    )
  ).rows[0].data;
  expect(source.collection.omitted.reasoning).toBeGreaterThan(0);
  expect(source.content).toContain("SYNTHETIC_TOOL_RESULT");
  expect(source.content).not.toContain("DO_NOT_COPY_INPUT");
  assistant.data.time.completed--;
  expect(await c.collect(f.editor, "assistant-host", input)).toMatchObject({
    id: a.id,
    duplicate: true,
    stale: true,
  });
  delete assistant.data.time.completed;
  await expect(c.collect(f.editor, "assistant-host", input)).rejects.toThrow(
    "ARTIFACT_INCOMPLETE",
  );
});
test("real HTTP and UserInfo protect selected collection with cookie, CSRF and current connection revision", async () => {
  const f = await setup();
  const provider = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ sub: "synthetic-editor", groups: ["editor"] }));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => provider.close(() => r())));
  const addr = provider.address();
  if (!addr || typeof addr === "string") throw Error("LISTEN");
  const config = new oidc.Configuration(
    {
      issuer: f.config.issuer,
      userinfo_endpoint: `http://127.0.0.1:${addr.port}/userinfo`,
    },
    "synthetic",
    "synthetic",
  );
  oidc.allowInsecureRequests(config);
  const token = "synthetic-http-token";
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','synthetic-csrf',now()+interval '1 hour','synthetic-editor','synthetic-access')",
    [sessionHash(token), f.workspaceId],
  );
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    editor: "editor",
  });
  const app = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      storage: f.storage,
      artifacts: f.collector,
    }),
  );
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => app.close(() => r())));
  const a = app.address();
  if (!a || typeof a === "string") throw Error("LISTEN");
  const base = `http://127.0.0.1:${a.port}/api/v1/storage/collector-connections/personal-host/collect`;
  expect(
    (
      await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(f.input),
      })
    ).status,
  ).toBe(401);
  const headers = {
    Cookie: `akh_session=${token}`,
    Origin: "http://localhost",
    "content-type": "application/json",
    "X-CSRF-Token": "wrong",
  };
  expect(
    (
      await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify(f.input),
      })
    ).status,
  ).toBe(403);
  const ok = await fetch(base, {
    method: "POST",
    headers: { ...headers, "X-CSRF-Token": "synthetic-csrf" },
    body: JSON.stringify(f.input),
  });
  expect(await ok.json()).toMatchObject({ duplicate: false });
  expect(ok.status).toBe(201);
  f.setVersion("1.15.0");
  expect(
    (
      await fetch(base, {
        method: "POST",
        headers: { ...headers, "X-CSRF-Token": "synthetic-csrf" },
        body: JSON.stringify(f.input),
      })
    ).status,
  ).toBe(409);
});
test("same host artifact deduplicates across renewed bindings but a different session stays distinct", async () => {
  const f = await setup();
  const a = await f.collector.collect(f.editor, "personal-host", f.input);
  const c = new TrustedArtifactCollector(
    f.storage,
    [
      {
        ...f.config,
        id: "renewed-host",
        allowedSessionIds: [f.input.sessionId, "ses_second"],
      },
    ],
    async (url) =>
      url.pathname === "/version" ? { version: "2.2.2" } : f.artifact,
  );
  await c.initialize();
  expect(await c.collect(f.editor, "renewed-host", f.input)).toMatchObject({
    id: a.id,
    duplicate: true,
  });
  f.artifact.data.sessionID = "ses_second";
  expect(
    (
      await c.collect(f.editor, "renewed-host", {
        ...f.input,
        sessionId: "ses_second",
      })
    ).id,
  ).not.toBe(a.id);
});
test("real bounded TLS transport fetches configured host bytes and refuses redirects, encoding and oversized bodies", async () => {
  const f = await setup(),
    { cert, key } = testTlsCertificate();
  let mode = "ok";
  let artifactRequests = 0;
  let seenAuthorization = "";
  const provider = createHttpsServer({ cert, key }, (req, res) => {
    seenAuthorization = String(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (mode === "redirect") {
      res.writeHead(302, { location: "https://unapproved.invalid/" });
      res.end();
      return;
    }
    if (mode === "encoding") {
      res.setHeader("content-encoding", "gzip");
      res.end("{}");
      return;
    }
    if (mode === "large") {
      res.setHeader("content-length", "999999999");
      res.end("{}");
      return;
    }
    if (req.url === "/version") res.end(JSON.stringify({ version: "2.2.2" }));
    else {
      artifactRequests++;
      res.end(JSON.stringify(f.artifact));
    }
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        provider.closeAllConnections();
        provider.close(() => r());
      }),
  );
  const addr = provider.address();
  if (!addr || typeof addr === "string") throw Error("LISTEN");
  const origin = `https://127.0.0.1:${addr.port}`;
  const read = createCollectorJsonReader({ ca: cert });
  const c = new TrustedArtifactCollector(
    f.storage,
    [{ ...f.config, id: "tls-host", baseUrl: origin }],
    read,
  );
  await c.initialize();
  expect(await c.collect(f.editor, "tls-host", f.input)).toMatchObject({
    duplicate: false,
  });
  expect(artifactRequests).toBe(1);
  expect(seenAuthorization).toBe("Bearer synthetic-only");
  mode = "redirect";
  await expect(read(new URL("/version", origin), "synthetic")).rejects.toThrow(
    "COLLECTOR_FETCH_FAILED",
  );
  mode = "encoding";
  await expect(read(new URL("/version", origin), "synthetic")).rejects.toThrow(
    "ENCODING_DENIED",
  );
  mode = "large";
  await expect(read(new URL("/version", origin), "synthetic")).rejects.toThrow(
    "PAYLOAD_TOO_LARGE",
  );
  expect(artifactRequests).toBe(1);
});
