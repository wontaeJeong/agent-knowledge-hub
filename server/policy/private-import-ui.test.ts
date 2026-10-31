import { afterEach, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { registerTrustedDestinations } from "./model";
import { OperationalApi } from "../../src/operational/api";
import {
  approvePrivateImport,
  startApprovedPrivateImport,
  privateImportApproved,
  type PrivateImportPolicySnapshot,
} from "../../src/operational/PrivateImportPolicy";
import type { ImportView } from "../../src/domain/imports";
import { hash } from "../imports/parser";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
  vi.unstubAllEnvs();
});
async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test("fresh actual HTTP upload → parser → explicit owner UI consent → guarded real model HTTP → review_ready; changed selection sends zero additional model requests", async () => {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  await adoptFixture(f.pool, f.workspaceId);
  // A genuinely empty synthetic team workspace: uploader is Write, NOT global/space Admin.
  for (const table of ["versions", "pages", "sources"])
    await f.pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [
      f.workspaceId,
    ]);
  let calls = 0;
  const modelBase = await listen(
    createServer(async (req, res) => {
      let text = "";
      for await (const part of req) text += part;
      calls++;
      const input = JSON.parse(JSON.parse(text).messages[1].content);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          model: "synthetic-provider-fixture",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  topics: [
                    {
                      key: "fixture",
                      title: "합성 검토 후보",
                      summary: "원문 보존",
                      content: "# 합성 검토 후보",
                      targetPageId: null,
                      relatedPageIds: [],
                      statements: input.records.map(
                        (r: { id: string; text: string }) => ({
                          kind: "proposal",
                          text: r.text,
                          context: "합성 작성자 진술 · 독립 실행 증거 아님",
                          recordId: r.id,
                          quote: r.text,
                        }),
                      ),
                    },
                  ],
                  excluded: [],
                }),
              },
            },
          ],
        }),
      );
    }),
  );
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", modelBase + "/v1");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "synthetic-request");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "local-model");
  await registerTrustedDestinations(f.pool, [
    {
      id: "local-model",
      url: modelBase + "/v1/chat/completions",
      purposes: ["organize"],
      classifications: ["synthetic"],
      active: true,
    },
  ]);
  const issuer = await listen(
    createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sub: "editor", groups: ["writers"] }));
    }),
  );
  const configuration = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "fixture-client",
    "fixture-only-secret",
  );
  oidc.allowInsecureRequests(configuration);
  const session = randomUUID();
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','fixture-csrf','editor','fixture-token',now()+interval '1 hour')",
    [sessionHash(session), f.workspaceId],
  );
  const runtime = new RuntimeService(f.pool);
  let handler: ReturnType<typeof createRuntimeHandler>;
  const base = await listen(createServer((req, res) => void handler(req, res)));
  handler = createRuntimeHandler({
    pool: f.pool,
    service: runtime,
    auth: new OidcAuth(f.pool, configuration, base, f.workspaceId, {
      writers: "editor",
    }),
    origin: base,
    workspaceId: f.workspaceId,
  });
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    if (new URL(String(url)).origin !== base) return nativeFetch(url, init);
    const headers = new Headers(init?.headers);
    headers.set("Cookie", `akh_session=${session}`);
    headers.set("Origin", base);
    return nativeFetch(url, { ...init, headers });
  });
  const api = new OperationalApi(base, f.workspaceId);
  const me = await api.me();
  expect(me.capabilities).not.toContain("space.admin");
  const bytes = Buffer.from(
    "[2026-10-19 10:00] A: 합성 TTL 변경을 제안합니다.",
  );
  const created = await api.post<{ id: string }>(
    "/imports",
    {
      title: "합성 개인 수집 자료",
      files: [
        {
          id: "file",
          name: "chat.txt",
          size: bytes.length,
          sha256: hash(bytes),
        },
      ],
    },
    randomUUID(),
  );
  await api.post(`/imports/${created.id}/files/file/parts/0`, {
    data: bytes.toString("base64"),
    sha256: hash(bytes),
  });
  await api.post(`/imports/${created.id}/finalize`, {}, randomUUID());
  await runtime.imports.tick();
  let view = await api.get<ImportView>(`/imports/${created.id}`);
  expect(view.parsed).toBeTruthy();
  if (view.parsed!.warnings.length) {
    await api.request(
      `/imports/${view.id}/selection`,
      "PATCH",
      { ...view.selection, acknowledgeWarnings: true },
      undefined,
      { "If-Match": String(view.revision) },
    );
    await api.post(`/imports/${view.id}/finalize`, {}, randomUUID());
    await runtime.imports.tick();
    view = await api.get<ImportView>(`/imports/${view.id}`);
  }
  let policy = await api.get<PrivateImportPolicySnapshot>(
    `/policy/imports/${view.id}`,
  );
  expect(policy.modelDestinationApproved).toBe(true);
  expect(privateImportApproved(policy, view.id, view.revision, false)).toBe(
    false,
  );
  await expect(
    startApprovedPrivateImport(api, view.id, view.revision, randomUUID()),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  policy = await approvePrivateImport(
    api,
    policy,
    "local-model",
    "synthetic",
    true,
  );
  expect(privateImportApproved(policy, view.id, view.revision, false)).toBe(
    true,
  );
  await startApprovedPrivateImport(api, view.id, view.revision, randomUUID());
  await runtime.imports.tick();
  view = await api.get<ImportView>(`/imports/${view.id}`);
  expect(view.runs[0].status).toBe("review_ready");
  expect(calls).toBeGreaterThan(0);
  const before = calls;
  const oldRevision = view.revision;
  await api.request(
    `/imports/${view.id}/selection`,
    "PATCH",
    { ...view.selection, project: "changed-selection" },
    undefined,
    { "If-Match": String(view.revision) },
  );
  await expect(
    startApprovedPrivateImport(api, view.id, oldRevision, randomUUID()),
  ).rejects.toThrow();
  // Even bypassing the UI cannot transmit the newer selection under an old approval.
  await api.post(`/imports/${view.id}/finalize`, {}, randomUUID());
  await runtime.imports.tick();
  view = await api.get<ImportView>(`/imports/${view.id}`);
  if (view.parsed!.warnings.length && !view.selection.acknowledgeWarnings) {
    await api.request(
      `/imports/${view.id}/selection`,
      "PATCH",
      { ...view.selection, acknowledgeWarnings: true },
      undefined,
      { "If-Match": String(view.revision) },
    );
    await api.post(`/imports/${view.id}/finalize`, {}, randomUUID());
    await runtime.imports.tick();
    view = await api.get<ImportView>(`/imports/${view.id}`);
  }
  const stalePolicy = await api.get<PrivateImportPolicySnapshot>(
    `/policy/imports/${view.id}`,
  );
  expect(stalePolicy.currentInputApproved).toBe(false);
  expect(
    privateImportApproved(stalePolicy, view.id, view.revision, false),
  ).toBe(false);
  await expect(
    startApprovedPrivateImport(api, view.id, view.revision, randomUUID()),
  ).rejects.toThrow();
  expect(calls).toBe(before);
  await api.post(
    `/imports/${view.id}/runs`,
    { revision: view.revision, mode: "model" },
    randomUUID(),
  );
  await runtime.imports.tick();
  expect(calls).toBe(before);
  const denied = await api.get<ImportView>(`/imports/${view.id}`);
  expect(denied.runs[0].status).not.toBe("review_ready");
  expect(denied.runs[0].errorCode).toBe("MODEL_TRANSMISSION_DENIED");
}, 30000);
