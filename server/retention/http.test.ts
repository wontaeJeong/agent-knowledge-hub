import { beforeAll, afterAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { createRuntimeHandler } from "../runtime/http";
import {
  DraftAutosave,
  RecoveryCache,
  type Draft,
  type RecoveryBinding,
  type RecoveryValidation,
} from "../../src/operational/draft-recovery";
import { ApiError } from "../../src/operational/api";

let f: Awaited<ReturnType<typeof fixture>>,
  server: Server,
  provider: Server,
  base: string;
let admitted = true,
  dropNextDraftAck = false;
const cookie = randomUUID();
beforeAll(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  provider = createServer((_req, res) => {
    res.writeHead(admitted ? 200 : 401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(admitted ? { sub: "editor", groups: ["writers"] } : {}),
    );
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "fixture-client",
    "fixture-secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    writers: "editor",
  });
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()+interval '1 hour','editor','fixture-access')",
    [sessionHash(cookie), f.workspaceId],
  );
  const handler = createRuntimeHandler({
    pool: f.pool,
    service: new RuntimeService(f.pool),
    auth,
    origin: "http://localhost",
    workspaceId: f.workspaceId,
  });
  server = createServer((req, res) => {
    // Drop the actual response ONLY after the real transaction and handler finish.
    if (
      dropNextDraftAck &&
      req.url === "/api/v1/workflows/drafts" &&
      req.method === "POST"
    ) {
      dropNextDraftAck = false;
      res.end = (() => {
        res.destroy();
        return res;
      }) as typeof res.end;
    }
    void handler(req, res);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => server?.close(() => r())),
    new Promise<void>((r) => provider?.close(() => r())),
  ]);
  await f?.pool.end();
});
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + "/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: `akh_session=${cookie}`,
      Origin: "http://localhost",
      "X-CSRF-Token": "csrf",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.code, response.status, data.code);
  return data;
}
test("actual HTTP commit/lost ACK/reconnect CAS preserves the winner and unsent competing input", async () => {
  const draft: Draft = {
    id: "http-draft",
    title: "개인 작업",
    content: "초기",
    revision: 0,
    pageId: "topic",
    baseVersion: 1,
  };
  const client = new DraftAutosave(
    draft,
    (input) => request<Draft>("/workflows/drafts", input),
    () => {},
  );
  dropNextDraftAck = true;
  client.edit("서버가 받았지만 응답은 유실");
  await client.flush();
  expect(client.status).toBe("offline");
  await request("/workflows/drafts", {
    id: draft.id,
    title: draft.title,
    pageId: "topic",
    baseVersion: 1,
    expectedRevision: 1,
    content: "다른 탭의 승자",
    mutationId: randomUUID(),
  });
  client.edit("아직 보내지 않은 새 입력");
  await client.flush();
  expect(client.status).toBe("conflict");
  expect(client.content).toBe("아직 보내지 않은 새 입력");
  const serverDraft = (
    await request<{ items: Draft[] }>("/workflows/drafts")
  ).items.find((d) => d.id === draft.id)!;
  expect(serverDraft.content).toBe("다른 탭의 승자");
  expect(serverDraft.revision).toBe(2);
  client.resolve(serverDraft.revision, "사용자가 두 입력을 검토하여 병합");
  await client.flush();
  expect(client.status).toBe("saved");
  expect(client.draft.revision).toBe(3);
  client.dispose();
});
test("actual server identity/current source revocation gates browser restart; local-copy denial stores zero body bytes", async () => {
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    key: (n: number) => [...map.keys()][n] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
  const d: Draft = {
    id: "recovery-http",
    title: "복구",
    content: "서버 본문",
    revision: 0,
    pageId: "topic",
    baseVersion: 1,
  };
  const cache = new RecoveryCache(storage);
  await expect(
    request("/workflows/recovery/permission", { ...d, expectedRevision: 0 }),
  ).rejects.toThrow();
  cache.write(null, d, "로컬 복사 금지된 내용");
  expect(map.size).toBe(0);
  await f.pool.query(
    "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false)",
    [f.workspaceId],
  );
  const binding = await request<RecoveryBinding>(
    "/workflows/recovery/permission",
    { ...d, expectedRevision: 0 },
  );
  cache.write(binding, d, "재시작 전 미전송 입력");
  const validate = async (binding: RecoveryBinding) => {
    const me = await request<{ principalId: string; workspaceId: string }>(
      "/me",
    );
    if (
      me.principalId !== binding.principalId ||
      me.workspaceId !== binding.workspaceId
    )
      throw Error("IDENTITY_CHANGED");
    return request<RecoveryValidation>("/workflows/recovery/validate", {
      binding,
    });
  };
  const restarted = new RecoveryCache(storage);
  expect(
    (await restarted.recover("editor", f.workspaceId, "topic", validate))
      ?.content,
  ).toBe("재시작 전 미전송 입력");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
    [f.workspaceId],
  );
  await expect(
    restarted.recover("editor", f.workspaceId, "topic", validate),
  ).rejects.toThrow();
  expect(map.size).toBe(0);
  cache.write(binding, d, "과거 허용 사본");
  admitted = false;
  await expect(
    restarted.recover("editor", f.workspaceId, "topic", validate),
  ).rejects.toThrow();
  expect(map.size).toBe(0);
});
