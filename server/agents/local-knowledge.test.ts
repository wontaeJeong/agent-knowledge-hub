import { test, expect, vi } from "vitest";
import { createServer } from "node:http";
import * as oidc from "openid-client";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, adoptFixture } from "../test-support";
import { AccessService } from "../access/index";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { randomUUID } from "node:crypto";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { createRuntimeJobs } from "../jobs/runtime";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
// @ts-expect-error Portable client is plain JavaScript.
import { openClient } from "../../scripts/wiki-connector/client.mjs";
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

test.each(["offline", "model"] as const)(
  "selected new source completes the native %s loop with independent review and no agent publication",
  async (mode) => {
    const f = await fixture();
    await adoptFixture(f.pool, f.workspaceId);
    const access = new AccessService(f.pool);
    const credential = await access.issueCredential(f.editor, {
      actions: [
        "source.create",
        "knowledge.read",
        "changeset.propose",
        "lint.run",
      ],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    let modelCalls = 0;
    let invalidModel = false;
    let noChanges = false;
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const context = JSON.parse(JSON.parse(raw).messages[1].content);
      modelCalls++;
      if (invalidModel) {
        res.end(
          JSON.stringify({
            model: "loopback-fixture-model",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
        );
        return;
      }
      if (noChanges && context.answer) {
        res.end(
          JSON.stringify({
            model: "loopback-fixture-model",
            usage: { prompt_tokens: 10, completion_tokens: 10 },
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    updates: [],
                    reason: "No additional knowledge",
                  }),
                },
              },
            ],
          }),
        );
        return;
      }
      const page = context.pages?.find((p: any) => p.id === "topic");
      const data = context.question
        ? {
            content: page.content,
            insufficient: false,
            citations: [
              {
                pageId: page.id,
                title: page.title,
                version: page.version,
                quote: page.content,
              },
            ],
          }
        : {
            updates: [
              {
                id: "topic",
                title: "Connected source knowledge",
                summary: "Synthetic test",
                content: context.answer
                  ? "Derived comparison: " + context.answer.content
                  : "Reconnect with the same selected operation key.",
                scope: "team",
                baseVersion: page.baseVersion,
                links: [],
                sourceIds: context.sources.map((s: any) => s.id),
                facts: [],
              },
            ],
            reason: "Explicit synthetic transport fixture",
          };
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          model: "loopback-fixture-model",
          usage: { prompt_tokens: 10, completion_tokens: 10 },
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(data) },
            },
          ],
        }),
      );
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    if (mode === "model") {
      vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", base);
      vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "loopback-fixture-model");
      vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_PROVIDER", "loopback-fixture");
      vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
      vi.stubEnv(
        "AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID",
        "local-loop-fixture",
      );
    }
    const runtime = new RuntimeService(f.pool);
    const jobs = createRuntimeJobs(f.pool, runtime, {
      workerCount: 1,
      directoryProviderId: "synthetic-local-fixture",
      directoryStatus: async (subject) => ({
        ...subject,
        active: true,
        verifiedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 10000).toISOString(),
      }),
    });
    const reviewerCookie = randomUUID();
    const userinfo = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sub: "reviewer", groups: ["reviewers"] }));
    });
    await new Promise<void>((r) => userinfo.listen(0, "127.0.0.1", r));
    const issuer = `http://127.0.0.1:${(userinfo.address() as { port: number }).port}`;
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','review-csrf',now()+interval '1 hour','reviewer','synthetic-review-token')",
      [sessionHash(reviewerCookie), f.workspaceId],
    );
    const config = new oidc.Configuration(
      { issuer, userinfo_endpoint: issuer + "/userinfo" },
      "client",
      "secret",
    );
    oidc.allowInsecureRequests(config);
    const auth = new OidcAuth(
      f.pool,
      config,
      "http://localhost",
      f.workspaceId,
      { reviewers: "reviewer" },
    );
    const server = createServer(
      createRuntimeHandler({
        pool: f.pool,
        service: runtime,
        auth,
        origin: "http://localhost",
        workspaceId: f.workspaceId,
        jobs,
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(join(tmpdir(), "akh-local-loop-"));
    await writeFile(
      join(root, "selected.md"),
      "## 지식: 재연결\n선택 원본의 새 지식은 재연결 시 같은 키로 재개한다.",
    );
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/connector`;
    const client = await openClient({
      directory: join(root, "state"),
      sourceRoot: root,
      url,
      token: credential.secret,
    });
    const poll = async (id: string) => {
      for (let i = 0; i < 150; i++) {
        const job = await client.pollKnowledge(id);
        if (["succeeded", "dead", "cancelled"].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("POLL_TIMEOUT");
    };
    try {
      const reg = await client.registerSource({
        id: "new-source",
        file: "selected.md",
        source: {
          title: "Explicit shared synthetic source",
          targetPageId: "topic",
          scope: "team",
          readers: ["editor", "reviewer", "reader"],
        },
      });
      expect(reg).toMatchObject({ status: "registered", published: false });
      if (mode === "model")
        await approveLocalTransmissionFixture(
          f.pool,
          f.workspaceId,
          base + "/chat/completions",
          ["ingest", "query"],
          "local-loop-fixture",
          ["source-a", reg.source_id],
        );
      const env = {
        ...process.env,
        AGENT_KNOWLEDGE_HUB_WIKI_URL: url,
        AGENT_KNOWLEDGE_HUB_WIKI_TOKEN: credential.secret,
        AGENT_KNOWLEDGE_HUB_SOURCE_ROOT: root,
      };
      const selection = {
        id: "cli-private",
        file: "selected.md",
        source: {
          title: "Private selected source",
          targetPageId: "topic",
          scope: "private",
          readers: ["editor"],
        },
      };
      const selectedFile = join(root, "selection.json");
      await writeFile(selectedFile, JSON.stringify(selection));
      const child = spawn(
        process.execPath,
        ["scripts/wiki-connector/cli.mjs", "source-register", selectedFile],
        {
          env: {
            ...env,
            AGENT_KNOWLEDGE_HUB_WIKI_DIR: join(root, "cli-state"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      expect(await new Promise((r) => child.on("close", r)), stderr).toBe(0);
      const privateSource = JSON.parse(stdout);
      expect(
        (
          await f.pool.query(
            "SELECT principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2",
            [f.workspaceId, privateSource.source_id],
          )
        ).rows.map((r) => r.principal_id),
      ).toEqual(["editor"]);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve("scripts/wiki-connector/mcp.mjs")],
        env: { ...env, AGENT_KNOWLEDGE_HUB_WIKI_DIR: join(root, "mcp-state") },
        stderr: "pipe",
      });
      const sdk = new Client({
        name: "local-loop-native-fixture",
        version: "1.0.0",
      });
      try {
        await sdk.connect(transport);
        const tools = (await sdk.listTools()).tools.map((t) => t.name);
        expect(tools).toContain("wiki_register_source");
        expect(tools.some((t) => /approve|publish/.test(t))).toBe(false);
        const registered = await sdk.callTool({
          name: "wiki_register_source",
          arguments: { selection: { ...selection, id: "mcp-private" } },
        });
        expect(registered.isError, JSON.stringify(registered)).not.toBe(true);
        const q = await sdk.callTool({
          name: "wiki_knowledge",
          arguments: { operation: { id: "mcp-lint", kind: "lint" } },
        });
        expect(q.isError, JSON.stringify(q)).not.toBe(true);
      } finally {
        await sdk.close();
      }
      const stored = (
        await f.pool.query(
          "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, reg.source_id],
        )
      ).rows[0].data;
      expect(stored.verification).toBe("미검증");
      const admission = await client.knowledge({
        id: "ingest-new",
        kind: "ingest",
        sourceIds: [reg.source_id],
        mode,
      });
      expect(admission.status).toBe("queued");
      expect((await client.resumeKnowledge("ingest-new")).id).toBe(
        admission.id,
      );
      jobs.start();
      const ingest = await poll("ingest-new");
      expect(ingest, JSON.stringify(ingest)).toMatchObject({
        status: "succeeded",
        result: { status: "pending", published: false },
      });
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM publications WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(0);
      for (const action of ["approve", "publish"]) {
        const reviewed = await fetch(
          url.replace(
            "/api/v1/connector",
            `/api/v1/changesets/${ingest.result.id}/${action}`,
          ),
          {
            method: "POST",
            headers: {
              Cookie: `akh_session=${reviewerCookie}`,
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "X-CSRF-Token": "review-csrf",
              "Idempotency-Key": "independent-publish",
            },
            body: JSON.stringify({ hash: ingest.result.hash }),
          },
        );
        expect(reviewed.status, await reviewed.clone().text()).toBe(200);
      }
      await client.knowledge({
        id: "query-new",
        kind: "query",
        question: mode === "model" ? "Reconnect" : "재연결",
        mode,
      });
      const answer = await poll("query-new");
      expect(answer).toMatchObject({
        status: "succeeded",
        result: { kind: "derived-answer" },
      });
      expect(
        answer.result.citations.some(
          (c: { version: number }) => c.version >= 1,
        ),
      ).toBe(true);
      expect(answer.result.citations).toContainEqual({
        pageId: "topic",
        version: 2,
      });
      expect(
        (
          await f.pool.query(
            "SELECT data FROM runtime_answers WHERE workspace_id=$1 AND id=$2",
            [f.workspaceId, answer.result.id],
          )
        ).rows[0].data.insufficient,
      ).toBe(false);
      const sourceCount = (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM sources WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n;
      expect(await client.resumeKnowledge("new-source")).toEqual(reg);
      const resumedQuery = await client.resumeKnowledge("query-new");
      expect(resumedQuery).not.toHaveProperty("result.content");
      expect(resumedQuery).not.toHaveProperty("checkpoint");
      await client.knowledge({
        id: "file-new",
        kind: "file-answer",
        answerId: answer.result.id,
      });
      expect((await client.resumeKnowledge("file-new")).status).toBe("pending");
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM sources WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(sourceCount);
      await client.knowledge({ id: "lint-new", kind: "lint" });
      expect(await poll("lint-new")).toMatchObject({
        status: "succeeded",
        result: { kind: "lint-review" },
      });
      expect(
        (await readFile(join(root, "state", "state.json"), "utf8")).includes(
          "선택 원본의 새 지식",
        ),
      ).toBe(false);
      if (mode === "model") {
        await client.knowledge({
          id: "no-change-query",
          kind: "query",
          question: "Reconnect",
          mode,
        });
        const extraAnswer = await poll("no-change-query");
        noChanges = true;
        const unchanged = await client.knowledge({
          id: "no-change-file",
          kind: "file-answer",
          answerId: extraAnswer.result.id,
        });
        expect(unchanged.status).toBe("no-changes");
        const callsAfterNoChanges = modelCalls;
        expect((await client.resumeKnowledge("no-change-file")).status).toBe(
          "no-changes",
        );
        expect(modelCalls).toBe(callsAfterNoChanges);
        noChanges = false;
        invalidModel = true;
        await client.knowledge({
          id: "model-error",
          kind: "query",
          question: "Reconnect",
          mode,
        });
        expect(await poll("model-error")).toMatchObject({ status: "dead" });
        expect(
          (await client.knowledgeStatus()).find(
            (r: { id: string }) => r.id === "model-error",
          ).error,
        ).toBeTruthy();
      }
      const readonly = await access.issueCredential(f.editor, {
        actions: ["knowledge.read"],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const denied = await openClient({
        directory: join(root, "readonly-state"),
        sourceRoot: root,
        url,
        token: readonly.secret,
      });
      try {
        await expect(
          denied.registerSource({ ...selection, id: "denied-source" }),
        ).rejects.toThrow("FORBIDDEN");
      } finally {
        await denied.close();
      }
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='editor'",
        [f.workspaceId, reg.source_id],
      );
      await expect(client.pollKnowledge("query-new")).rejects.toThrow();
      await expect(client.resumeKnowledge("new-source")).rejects.toThrow();
      expect(modelCalls).toBe(mode === "model" ? 6 : 0);
      await access.revokeCredential(f.editor, credential.id);
      await expect(client.pollKnowledge("query-new")).rejects.toThrow(
        "UNAUTHENTICATED",
      );
    } finally {
      await client.close();
      await jobs.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
      await f.pool.end();
      userinfo.closeAllConnections();
      await new Promise<void>((r) => userinfo.close(() => r()));
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      vi.unstubAllEnvs();
    }
  },
);
