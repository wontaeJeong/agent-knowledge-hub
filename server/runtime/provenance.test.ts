import { expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import * as oidc from "openid-client";
import { randomUUID } from "node:crypto";
import { fixture, source } from "../test-support";
import { RuntimeService } from "./knowledge";
import { migrate } from "../database";
test("upgrade recovers retained batch provenance for older published versions", async () => {
  const f = await setup();
  try {
    const b = await f.runtime.core.propose(
      f.editor,
      [draft("legacy-derived", "broad-source")],
      [source.id, "broad-source"],
    );
    await f.runtime.core.approve(f.ctx, b.id, b.hash);
    await f.runtime.core.publish(f.ctx, b.id, b.hash, "legacy");
    await f.pool.query(
      "UPDATE batches SET data=jsonb_set(data,'{contextDependencyIds}','[\"topic\"]') WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, b.id],
    );
    await f.pool.query(
      "UPDATE versions SET data=data-'provenance' WHERE workspace_id=$1 AND page_id='legacy-derived'",
      [f.workspaceId],
    );
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'",
      [f.workspaceId],
    );
    await f.pool.query("DELETE FROM schema_migrations WHERE version=5");
    await migrate(f.pool);
    const version = (
      await f.pool.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id='legacy-derived'",
        [f.workspaceId],
      )
    ).rows[0].data;
    expect(version.sourceIds).toContain(source.id);
    expect(version.provenance.pageIds).toContain("topic");
    expect(
      (await f.runtime.pages(f.reader)).some((p) => p.id === "legacy-derived"),
    ).toBe(false);
  } finally {
    await f.pool.end();
  }
});
import { createRuntimeHandler } from "./http";
import { OidcAuth, sessionHash } from "./auth";
import { draftOf, current, type Draft } from "../../src/domain/wiki";

const draft = (id: string, sourceId: string): Draft => ({
  id,
  title: "shared-token " + id,
  summary: "shared-token",
  content: "shared-token secret " + id,
  scope: "team",
  baseVersion: 0,
  sourceIds: [sourceId],
  links: [],
  facts: [],
});
async function setup() {
  const f = await fixture();
  const runtime = new RuntimeService(f.pool);
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{title}','\"shared-token restricted\"') WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId],
  );
  await runtime.core.registerSource(
    f.editor,
    { ...source, id: "broad-source" },
    ["editor", "reviewer", "reader"],
  );
  const b = await runtime.core.propose(
    f.editor,
    [draft("broad-page", "broad-source")],
    ["broad-source"],
  );
  await runtime.core.approve(f.ctx, b.id, b.hash);
  await runtime.core.publish(f.ctx, b.id, b.hash, "setup");
  return { ...f, runtime };
}
async function http(
  runtime: RuntimeService,
  f: Awaited<ReturnType<typeof fixture>>,
  principal = "editor",
) {
  const provider = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        sub: principal,
        groups: [principal === "reader" ? "readers" : "writers"],
      }),
    );
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const token = randomUUID();
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,$3,'csrf',$3,'token',now()+interval '1 hour')",
    [sessionHash(token), f.workspaceId, principal],
  );
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      auth: new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
        writers: "editor",
        readers: "reader",
      }),
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headers: {
      Cookie: `akh_session=${token}`,
      Origin: "http://localhost",
      "X-CSRF-Token": "csrf",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => provider.close(() => r())),
      ]);
    },
  };
}
test("all selected raw model sources constrain every output despite injected broad attribution", async () => {
  const f = await setup();
  try {
    await f.pool.query("DELETE FROM versions WHERE workspace_id=$1", [
      f.workspaceId,
    ]);
    await f.pool.query("DELETE FROM pages WHERE workspace_id=$1", [
      f.workspaceId,
    ]);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id=$2 AND principal_id='reader'",
      [f.workspaceId, source.id],
    );
    const runtime = new RuntimeService(f.pool, async () => ({
      updates: [draft("injected", "broad-source")],
    }));
    const b = await runtime.ingest(
      f.editor,
      [source.id, "broad-source"],
      "model",
    );
    const proposal = (await runtime.changesets(f.ctx)).find(
      (x) => x.id === b.id,
    )!;
    expect(proposal.updates[0].sourceIds).toContain(source.id);
    await runtime.core.approve(f.ctx, b.id, b.hash);
    await runtime.core.publish(f.ctx, b.id, b.hash, "injected");
    expect(await runtime.pages(f.reader)).toEqual([]);
    await expect(
      runtime.core.readPage(f.reader, "injected", 1),
    ).rejects.toThrow("NOT_FOUND");
    const client = await http(runtime, f, "reader");
    try {
      const res = await fetch(client.base + "/mcp", {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "knowledge_search",
            arguments: { question: "injected" },
          },
        }),
      });
      expect(await res.text()).not.toContain("secret injected");
    } finally {
      await client.close();
    }
  } finally {
    await f.pool.end();
  }
});
for (const transport of ["http", "mcp"] as const)
  for (const result of ["subset", "insufficient"] as const)
    for (const mutation of ["acl", "content"] as const)
      test(`${transport} rejects ${result} answer when uncited input ${mutation} changes during model`, async () => {
        const f = await setup();
        let client: Awaited<ReturnType<typeof http>> | undefined;
        try {
          let entered!: () => void, finish!: (v: unknown) => void;
          const started = new Promise<void>((r) => (entered = r));
          const runtime = new RuntimeService(f.pool, async (_op, context) => {
            expect((context as { pages: unknown[] }).pages).toHaveLength(2);
            entered();
            return new Promise((r) => (finish = r));
          });
          client = await http(runtime, f);
          const pending = fetch(
            client.base + (transport === "http" ? "/api/v1/query" : "/mcp"),
            {
              method: "POST",
              headers: client.headers,
              body: JSON.stringify(
                transport === "http"
                  ? { question: "shared-token", mode: "model" }
                  : {
                      jsonrpc: "2.0",
                      id: 1,
                      method: "tools/call",
                      params: {
                        name: "knowledge_query",
                        arguments: { question: "shared-token", mode: "model" },
                      },
                    },
              ),
            },
          );
          await started;
          if (mutation === "acl")
            await f.pool.query(
              "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='editor'",
              [f.workspaceId],
            );
          else
            await f.pool.query(
              "UPDATE pages SET data=jsonb_set(data,'{title}','\"updated uncited input\"') WHERE workspace_id=$1 AND id='topic'",
              [f.workspaceId],
            );
          finish({
            content: "DO-NOT-RELEASE-SECRET",
            insufficient: result === "insufficient",
            citations:
              result === "insufficient"
                ? []
                : [
                    {
                      pageId: "broad-page",
                      title: "shared-token broad-page",
                      version: 1,
                      quote: "shared-token",
                    },
                  ],
          });
          const response = await pending;
          const raw = await response.text();
          expect(raw).not.toContain("DO-NOT-RELEASE-SECRET");
          if (transport === "http") expect(response.status).toBe(409);
          expect(
            (
              await f.pool.query(
                "SELECT id FROM runtime_answers WHERE workspace_id=$1",
                [f.workspaceId],
              )
            ).rowCount,
          ).toBe(0);
        } finally {
          await client?.close();
          await f.pool.end();
        }
      });
test("filing keeps full uncited query context intersection and dependency envelope", async () => {
  const f = await setup();
  try {
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='reader'",
      [f.workspaceId, source.id],
    );
    const runtime = new RuntimeService(f.pool, async () => ({
      content: "restricted synthesis",
      insufficient: false,
      citations: [
        {
          pageId: "broad-page",
          title: "shared-token broad-page",
          version: 1,
          quote: "shared-token",
        },
      ],
    }));
    const answer = await runtime.query(f.editor, "shared-token", "model");
    const b = await runtime.file(f.editor, answer.id);
    expect(
      (await runtime.changesets(f.ctx)).find((x) => x.id === b.id)!.updates[0]
        .sourceIds,
    ).toContain(source.id);
    const stored = (
      await f.pool.query(
        "SELECT data FROM runtime_answers WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, answer.id],
      )
    ).rows[0].data;
    expect(stored.inputEnvelope.pageIds).toContain("topic");
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'",
      [f.workspaceId],
    );
    await expect(runtime.core.approve(f.ctx, b.id, b.hash)).rejects.toThrow(
      "STALE_VERSION",
    );
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page','topic','reader')",
      [f.workspaceId],
    );
    await runtime.core.approve(f.ctx, b.id, b.hash);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    await expect(
      runtime.core.publish(f.ctx, b.id, b.hash, "file-full-input"),
    ).rejects.toThrow();
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page','topic','reviewer')",
      [f.workspaceId],
    );
    await runtime.core.publish(f.ctx, b.id, b.hash, "file-full-input");
    expect(
      (await runtime.pages(f.reader)).some(
        (p) => p.id === "answer-" + answer.id,
      ),
    ).toBe(false);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='editor'",
      [f.workspaceId],
    );
    await expect(runtime.file(f.editor, answer.id)).rejects.toThrow();
  } finally {
    await f.pool.end();
  }
});
test("omitted model links cannot drop page ACL provenance across publication and subsequent updates", async () => {
  const f = await setup();
  try {
    const runtime = new RuntimeService(f.pool, async () => ({
      updates: [draft("derived", source.id)],
    }));
    const b = await runtime.ingest(f.editor, [source.id], "model");
    await runtime.core.approve(f.ctx, b.id, b.hash);
    await runtime.core.publish(f.ctx, b.id, b.hash, "derived1");
    const p = (await runtime.snapshot(f.editor)).state.pages.find(
      (p) => p.id === "derived",
    )!;
    const change = {
      ...draftOf(p),
      content: current(p).content + " updated",
      links: [],
    };
    const update = await runtime.core.propose(
      f.editor,
      [change],
      change.sourceIds,
    );
    await runtime.core.approve(f.ctx, update.id, update.hash);
    await runtime.core.publish(f.ctx, update.id, update.hash, "derived2");
    expect(
      (await runtime.pages(f.reader)).some((p) => p.id === "derived"),
    ).toBe(true);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'",
      [f.workspaceId],
    );
    expect(
      (await runtime.pages(f.reader)).some((p) => p.id === "derived"),
    ).toBe(false);
    await expect(runtime.core.readPage(f.reader, "derived")).rejects.toThrow(
      "NOT_FOUND",
    );
    await expect(runtime.core.readPage(f.reader, "derived", 1)).rejects.toThrow(
      "NOT_FOUND",
    );
    const client = await http(runtime, f, "reader");
    try {
      const response = await fetch(client.base + "/mcp", {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "knowledge_search",
            arguments: { question: "derived" },
          },
        }),
      });
      expect(await response.text()).not.toContain("secret derived");
    } finally {
      await client.close();
    }
    const consumer = new RuntimeService(f.pool, async (_op, context) => {
      expect(JSON.stringify(context)).not.toContain("derived");
      return { content: "no evidence", insufficient: true, citations: [] };
    });
    await consumer.query(f.reader, "shared-token", "model");
  } finally {
    await f.pool.end();
  }
});
