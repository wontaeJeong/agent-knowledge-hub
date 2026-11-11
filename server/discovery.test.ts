import { expect, test } from "vitest";
import { fixture, page } from "./test-support";
import { RuntimeService } from "./runtime/knowledge";
import { discoveryReport } from "./discovery";

test("citation rankings respect self versus aggregate permission, deduplication and current ACL", async () => {
  const f = await fixture();
  try {
    const runtime = new RuntimeService(f.pool);
    await runtime.query(f.editor, "기존", "offline");
    await runtime.query(f.reader, "기존", "offline");
    const personal = await discoveryReport(f.pool, runtime, f.editor, 7);
    expect(personal.scope).toBe("self");
    expect(personal.mostCited.map((p) => [p.id, p.citations])).toEqual([
      ["topic", 1],
    ]);
    const aggregate = await discoveryReport(f.pool, runtime, f.ctx, 7);
    expect(aggregate.scope).toBe("workspace");
    expect(aggregate.mostCited.map((p) => [p.id, p.citations])).toEqual([
      ["topic", 2],
    ]);
    expect(JSON.stringify(aggregate)).not.toContain("기존 내용");
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    const revoked = await discoveryReport(f.pool, runtime, f.ctx, 7);
    expect(revoked.pages).toBe(0);
    expect(revoked.mostCited).toEqual([]);
  } finally {
    await f.pool.end();
  }
});

test("links from hidden pages never contribute to visible rankings", async () => {
  const f = await fixture();
  try {
    const sourcePage = {
      ...page,
      id: "restricted",
      title: "제한된 문서",
      links: ["topic"],
    };
    await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
      f.workspaceId,
      sourcePage.id,
    ]);
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page',$2,'editor')",
      [f.workspaceId, sourcePage.id],
    );
    const { versions, ...metadata } = sourcePage;
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
      [f.workspaceId, sourcePage.id, metadata],
    );
    await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
      f.workspaceId,
      sourcePage.id,
      versions[0],
    ]);
    const runtime = new RuntimeService(f.pool);
    const reader = await discoveryReport(f.pool, runtime, f.reader, 90);
    expect(reader.links).toBe(0);
    expect(JSON.stringify(reader)).not.toContain("restricted");
    const editor = await discoveryReport(f.pool, runtime, f.editor, 90);
    expect(editor.mostLinked.map((p) => [p.id, p.links])).toEqual([
      ["topic", 1],
    ]);
  } finally {
    await f.pool.end();
  }
});

test("exclude non-current recommendations and answers affected by restricted inputs", async () => {
  const f = await fixture();
  try {
    const privateSource = {
      id: "secret-source",
      title: "restricted",
      tool: "fixture",
      project: "test",
      content: "기존 내용",
      scope: "team",
      verification: "미검증",
      createdAt: new Date().toISOString(),
      processed: false,
      targetPageId: "secret-page",
    };
    const privatePage = {
      ...page,
      id: "secret-page",
      title: "restricted",
      summary: "기존",
      links: [],
      versions: [
        { ...page.versions[0], id: "secret-v1", sourceIds: ["secret-source"] },
      ],
    };
    for (const [kind, id] of [
      ["source", "secret-source"],
      ["page", "secret-page"],
    ]) {
      await f.pool.query("INSERT INTO resources VALUES($1,$2,$3)", [
        f.workspaceId,
        kind,
        id,
      ]);
      await f.pool.query(
        "INSERT INTO resource_readers VALUES($1,$2,$3,'editor')",
        [f.workspaceId, kind, id],
      );
    }
    await f.pool.query(
      "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
      [f.workspaceId, privateSource.id, privateSource],
    );
    const { versions, ...metadata } = privatePage;
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
      [f.workspaceId, privatePage.id, metadata],
    );
    await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
      f.workspaceId,
      privatePage.id,
      versions[0],
    ]);
    const runtime = new RuntimeService(f.pool);
    const answer = await runtime.query(f.editor, "기존", "offline");
    expect(answer.citations.map((c) => c.pageId).sort()).toEqual([
      "secret-page",
      "topic",
    ]);
    const other = await discoveryReport(f.pool, runtime, f.ctx, 7);
    expect(other.pages).toBe(1);
    expect(other.citations).toBe(0);
    expect(JSON.stringify(other)).not.toContain("secret-page");
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",
      [f.workspaceId, { effectiveFrom: "2099-01-01T00:00:00.000Z" }],
    );
    const future = await discoveryReport(f.pool, runtime, f.ctx, 7);
    expect(future.pages).toBe(0);
    expect(future.mostCited).toEqual([]);
  } finally {
    await f.pool.end();
  }
});

test("managed spaces grant workspace citations only to the aggregate usage capability", async () => {
  const f = await fixture();
  try {
    const { bootstrapAccess } = await import("./access/index");
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Fixture" },
          owners: [{ principalId: "editor" }],
          grants: [
            { principalId: "reader", role: "read" },
            { principalId: "reviewer", role: "maintain" },
          ],
          reviewers: ["reviewer"],
        },
      ],
    });
    const runtime = new RuntimeService(f.pool);
    await runtime.query(f.editor, "기존", "offline");
    const second = await runtime.query(f.reader, "기존", "offline");
    expect(await discoveryReport(f.pool, runtime, f.editor, 7)).toMatchObject({
      scope: "workspace",
      citations: 2,
    });
    expect(await discoveryReport(f.pool, runtime, f.reader, 7)).toMatchObject({
      scope: "self",
      citations: 1,
    });
    expect(await discoveryReport(f.pool, runtime, f.ctx, 7)).toMatchObject({
      scope: "self",
      citations: 0,
    });
    await f.pool.query(
      "UPDATE runtime_answers SET data=jsonb_set(data,'{requestAuthorizationPending}','true'::jsonb) WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, second.id],
    );
    expect(await discoveryReport(f.pool, runtime, f.editor, 7)).toMatchObject({
      scope: "workspace",
      citations: 1,
    });
    await expect(
      discoveryReport(
        f.pool,
        runtime,
        { ...f.reader, principalId: "outsider" },
        7,
      ),
    ).rejects.toThrow("NOT_FOUND");
  } finally {
    await f.pool.end();
  }
});

test("fails explicitly rather than returning a silently truncated ranking", async () => {
  const f = await fixture();
  try {
    await f.pool.query(
      `INSERT INTO runtime_answers(workspace_id,id,principal_id,data)
      SELECT $1, 'bounded-' || n, 'editor', jsonb_build_object('at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'citations','[]'::jsonb)
      FROM generate_series(1,2001) n`,
      [f.workspaceId],
    );
    await expect(
      discoveryReport(f.pool, new RuntimeService(f.pool), f.editor, 7),
    ).rejects.toThrow("DISCOVERY_CAPACITY");
  } finally {
    await f.pool.end();
  }
});
