import { expect, test } from "vitest";
import { fixture, source, adoptFixture } from "../test-support";
import { approveInProcessModelFixture } from "../policy/test-fixture";
import { RuntimeService } from "./knowledge";

async function setup(output: unknown) {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const authorization = await approveInProcessModelFixture(
    f.pool,
    f.workspaceId,
    [source.id],
  );
  const ctx = { ...f.editor, authorization };
  let calls = 0;
  const runtime = new RuntimeService(f.pool, async (op) => {
    calls++;
    if (op === "query")
      return {
        content: "환경 A에서는 실패",
        insufficient: false,
        citations: [
          { pageId: "topic", version: 1, title: "주제", quote: "기존 내용" },
        ],
      };
    return output;
  });
  const answer = await runtime.query(ctx, "기존", "model");
  return { ...f, ctx, runtime, answer, calls: () => calls };
}

test("model answer reintegration revises the cited page with its source lineage", async () => {
  const f = await setup({
    updates: [
      {
        id: "topic",
        title: "주제",
        summary: "시험 주제",
        scope: "team",
        content: "기존 내용\n환경 A에서는 실패",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
  });
  try {
    const b = await f.runtime.file(f.ctx, f.answer.id);
    if ("outcome" in b) throw Error("expected proposal");
    const change = (await f.runtime.changesets(f.ctx)).find(
      (x) => x.id === b.id,
    )!;
    expect(f.calls()).toBe(2);
    expect(change.updates[0]).toMatchObject({
      id: "topic",
      baseVersion: 1,
      sourceIds: [source.id],
    });
    expect(
      (
        await f.pool.query(
          "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, b.id],
        )
      ).rows[0].data.answerId,
    ).toBe(f.answer.id);
  } finally {
    await f.pool.end();
  }
});

test("duplicate model answer produces an explicit no-change reason without a proposal", async () => {
  const f = await setup({
    updates: [],
    noChanges: true,
    reason: "동일한 원본에서 파생된 중복 답변",
  });
  try {
    const before = (
      await f.pool.query("SELECT count(*) FROM batches WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rows[0].count;
    const result = await f.runtime.file(f.ctx, f.answer.id);
    expect(result).toMatchObject({
      outcome: "no-changes",
      reason: "동일한 원본에서 파생된 중복 답변",
    });
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe(before);
  } finally {
    await f.pool.end();
  }
});

test("refiling one answer cannot create duplicate pending proposals", async () => {
  const f = await setup({
    updates: [
      {
        id: "topic",
        title: "주제",
        summary: "시험 주제",
        scope: "team",
        content: "기존 내용\n환경 A에서는 실패",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
  });
  try {
    await f.runtime.file(f.ctx, f.answer.id);
    await expect(f.runtime.file(f.ctx, f.answer.id)).rejects.toThrow(
      "ALREADY_PROPOSED",
    );
    const count = await f.pool.query(
      "SELECT count(*) FROM batches WHERE workspace_id=$1 AND data->>'answerId'=$2",
      [f.workspaceId, f.answer.id],
    );
    expect(count.rows[0].count).toBe("1");
  } finally {
    await f.pool.end();
  }
});

test("a model failure leaves no answer proposal", async () => {
  const f = await setup(null);
  try {
    const failing = new RuntimeService(f.pool, async () => {
      throw Error("MODEL_FAILED");
    });
    await expect(failing.file(f.ctx, f.answer.id)).rejects.toThrow(
      "MODEL_FAILED",
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    await f.pool.end();
  }
});

test("revoking source access during synthesis prevents proposal creation", async () => {
  const f = await setup(null);
  try {
    const runtime = new RuntimeService(f.pool, async () => {
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='editor'",
        [f.workspaceId, source.id],
      );
      return {
        updates: [
          {
            id: "topic",
            title: "주제",
            summary: "시험 주제",
            scope: "team",
            content: "기존 내용\n환경 A에서는 실패",
            links: [],
            facts: [],
            sourceIds: [source.id],
            baseVersion: 1,
          },
        ],
      };
    });
    await expect(runtime.file(f.ctx, f.answer.id)).rejects.toThrow();
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    await f.pool.end();
  }
});

test("archived cited knowledge is rejected before transmitting an answer for synthesis", async () => {
  const f = await setup({ updates: [], noChanges: true });
  try {
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,state) VALUES($1,'topic','archived')",
      [f.workspaceId],
    );
    await expect(f.runtime.file(f.ctx, f.answer.id)).rejects.toThrow(
      "STALE_VERSION",
    );
    expect(f.calls()).toBe(1);
  } finally {
    await f.pool.end();
  }
});

test("model cannot propose edits to a protected human page", async () => {
  const f = await setup({
    updates: [
      {
        id: "topic",
        title: "주제",
        summary: "시험 주제",
        scope: "team",
        content: "기존 내용\n환경 A에서는 실패",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
  });
  try {
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,'topic','active','{\"protected\":true}')",
      [f.workspaceId],
    );
    await expect(f.runtime.file(f.ctx, f.answer.id)).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    await f.pool.end();
  }
});

test("human edits made during synthesis reject the stale proposed revision", async () => {
  const f = await setup(null);
  try {
    const runtime = new RuntimeService(f.pool, async () => {
      await f.pool.query(
        "UPDATE pages SET data=jsonb_set(data,'{summary}','\"human edit\"') WHERE workspace_id=$1 AND id='topic'",
        [f.workspaceId],
      );
      return {
        updates: [
          {
            id: "topic",
            title: "주제",
            summary: "시험 주제",
            scope: "team",
            content: "기존 내용\n환경 A에서는 실패",
            links: [],
            facts: [],
            sourceIds: [source.id],
            baseVersion: 1,
          },
        ],
      };
    });
    await expect(runtime.file(f.ctx, f.answer.id)).rejects.toThrow(
      "STALE_VERSION",
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    await f.pool.end();
  }
});

test("candidate evidence and conditions are held by the proposal until atomic publication", async () => {
  const f = await setup({
    updates: [
      {
        id: "topic",
        title: "주제",
        summary: "시험 주제",
        scope: "team",
        content: "기존 내용\nLinux에서는 실패",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
    reason: "Linux 조건 보완",
    candidates: [
      {
        pageId: "topic",
        key: "retry",
        value: "실패",
        kind: "inference",
        conditions: { os: "linux" },
        exceptions: [],
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
        uncertainty: "단일 기록",
        sourceId: source.id,
        quote: "실패 시 재시도한다.",
      },
    ],
  });
  try {
    const b = await f.runtime.file(f.ctx, f.answer.id);
    if ("outcome" in b) throw Error("expected proposal");
    const stored = (
      await f.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, b.id],
      )
    ).rows[0].data;
    expect(stored.evolutionReason).toBe("Linux 조건 보완");
    expect(stored.candidates).toHaveLength(1);
    expect(stored.candidates[0]).toMatchObject({
      sourceId: source.id,
      conditions: { os: "linux" },
      verifiedAt: null,
    });
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM refinement_claims WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
    const reviewer = { workspaceId: f.workspaceId, principalId: "reviewer" };
    await f.runtime.core.approve(reviewer, b.id, b.hash);
    await f.runtime.core.publish(reviewer, b.id, b.hash, "publish-candidate");
    await f.runtime.core.publish(reviewer, b.id, b.hash, "publish-candidate");
    const claims = (
      await f.pool.query(
        "SELECT data FROM refinement_claims WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows;
    expect(claims).toHaveLength(1);
    expect(claims[0].data).toMatchObject({
      pageId: "topic",
      pageVersion: 2,
      conditions: { os: "linux" },
      verifiedAt: null,
    });
  } finally {
    await f.pool.end();
  }
});

test.each([
  [{ os: "linux" }, "contradiction"],
  [{ os: "windows" }, "different-environment"],
])(
  "published counterevidence preserves the existing claim and flags %s as %s",
  async (environment, expected) => {
    const f = await setup({
      updates: [
        {
          id: "topic",
          title: "주제",
          summary: "시험 주제",
          scope: "team",
          content: "기존 내용\n새 결과",
          links: [],
          facts: [],
          sourceIds: [source.id],
          baseVersion: 1,
        },
      ],
      candidates: [
        {
          pageId: "topic",
          key: "retry",
          value: "실패",
          kind: "inference",
          conditions: environment,
          exceptions: [],
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: null,
          uncertainty: "단일 기록",
          sourceId: source.id,
          quote: "실패 시 재시도한다.",
        },
      ],
    });
    try {
      const { RefinementService } = await import("../refinement/service");
      const { authorizeInTransaction } = await import("../access/index");
      const refinement = new RefinementService(f.pool, authorizeInTransaction);
      const snap = await refinement.sourceSnapshot(f.ctx, {
        sourceId: source.id,
      });
      const quote = "실패 시 재시도한다.";
      const start = snap.content.indexOf(quote);
      await refinement.addEvidence(f.ctx, {
        id: "old-evidence",
        kind: "claim",
        sourceId: source.id,
        sourceVersion: snap.sourceVersion,
        location: { start, end: start + quote.length, quote },
        parentIds: [],
        assertedAt: "2026-01-01T00:00:00.000Z",
        verifiedAt: null,
        conditions: { os: "linux" },
      });
      await refinement.addClaim(f.ctx, {
        id: "old-claim",
        pageId: "topic",
        pageVersion: 1,
        key: "retry",
        value: "성공",
        kind: "claim",
        conditions: { os: "linux" },
        exceptions: [],
        assertedAt: "2026-01-01T00:00:00.000Z",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
        verifiedAt: null,
        evidenceIds: ["old-evidence"],
        protected: false,
        uncertainty: "기록",
        supersedes: [],
      });
      const b = await f.runtime.file(f.ctx, f.answer.id);
      if ("outcome" in b) throw Error("expected proposal");
      const reviewer = { workspaceId: f.workspaceId, principalId: "reviewer" };
      await f.runtime.core.approve(reviewer, b.id, b.hash);
      await f.runtime.core.publish(
        reviewer,
        b.id,
        b.hash,
        `publish-${expected}`,
      );
      const requests = await refinement.requests(f.ctx);
      expect(
        requests.items.some((r) =>
          (
            r as typeof r & { conflicts?: { claimId: string; kind: string }[] }
          ).conflicts?.some(
            (c) => c.claimId === "old-claim" && c.kind === expected,
          ),
        ),
      ).toBe(true);
      expect(
        (
          await f.pool.query(
            "SELECT data FROM refinement_claims WHERE workspace_id=$1 AND id='old-claim'",
            [f.workspaceId],
          )
        ).rows[0].data.value,
      ).toBe("성공");
    } finally {
      await f.pool.end();
    }
  },
);

test("HTTP and real loopback model synthesize an answer into a reviewable proposal", async () => {
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { vi } = await import("vitest");
  const { approveLocalTransmissionFixture } =
    await import("../policy/test-fixture");
  const { createRuntimeHandler } = await import("./http");
  const { OidcAuth, sessionHash } = await import("./auth");
  const oidc = await import("openid-client");
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const requests: any[] = [];
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const input = JSON.parse(body.messages[1].content);
    const response = input.answer
      ? {
          updates: [
            {
              id: "topic",
              title: "주제",
              summary: "시험 주제",
              scope: "team",
              content: "기존 내용\n환경 A에서는 실패",
              links: [],
              facts: [],
              sourceIds: [source.id],
              baseVersion: 1,
            },
          ],
          candidates: [
            {
              pageId: "topic",
              key: "retry",
              value: "실패",
              kind: "inference",
              conditions: { os: "linux" },
              exceptions: [],
              validFrom: null,
              validTo: null,
              uncertainty: "단일 기록",
              sourceId: source.id,
              quote: "실패 시 재시도한다.",
            },
          ],
        }
      : {
          content: "환경 A에서는 실패",
          insufficient: false,
          citations: [
            { pageId: "topic", version: 1, title: "주제", quote: "기존 내용" },
          ],
        };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        model: "fixture",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(response) },
          },
        ],
      }),
    );
  });
  const idp = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sub: "editor", groups: ["writers"] }));
  });
  await Promise.all([
    new Promise<void>((r) => model.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => idp.listen(0, "127.0.0.1", r)),
  ]);
  const modelBase = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
  const issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", modelBase);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "fixture");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "loopback-evolution");
  await approveLocalTransmissionFixture(
    f.pool,
    f.workspaceId,
    modelBase + "/chat/completions",
    ["query", "ingest"],
    "loopback-evolution",
  );
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const token = randomUUID();
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','csrf','editor','token',now()+interval '1 hour')",
    [sessionHash(token), f.workspaceId],
  );
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth: new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
        writers: "editor",
      }),
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Cookie: `akh_session=${token}`,
    Origin: "http://localhost",
    "X-CSRF-Token": "csrf",
    "Content-Type": "application/json",
  };
  try {
    const query = await fetch(base + "/api/v1/query", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "기존", mode: "model" }),
    });
    expect(query.status).toBe(200);
    const answer = (await query.json()) as { id: string };
    const file = await fetch(base + `/api/v1/answers/${answer.id}/file`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(file.status).toBe(201);
    const b = (await file.json()) as { id: string };
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].messages[1].content).answer.id).toBe(
      answer.id,
    );
    const saved = (
      await f.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, b.id],
      )
    ).rows[0].data;
    expect(saved.candidates[0].conditions).toEqual({ os: "linux" });
    expect(saved.inputEnvelope.sourceIds).toContain(source.id);
  } finally {
    await Promise.all(
      [server, model, idp].map(
        (s) => new Promise<void>((r) => s.close(() => r())),
      ),
    );
    await f.pool.end();
    vi.unstubAllEnvs();
  }
});

test("a fabricated source quote cannot enter a candidate or create a proposal", async () => {
  const f = await setup({
    updates: [
      {
        id: "topic",
        title: "주제",
        summary: "시험 주제",
        scope: "team",
        content: "기존 내용\n새 결과",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
    candidates: [
      {
        pageId: "topic",
        key: "retry",
        value: "실패",
        kind: "claim",
        conditions: {},
        exceptions: [],
        validFrom: null,
        validTo: null,
        uncertainty: "미상",
        sourceId: source.id,
        quote: "없는 원문",
      },
    ],
  });
  try {
    await expect(f.runtime.file(f.ctx, f.answer.id)).rejects.toThrow(
      "MODEL_INVALID",
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM refinement_claims WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    await f.pool.end();
  }
});

test("a withdrawn source after approval blocks publication and leaves no partial claim or version", async () => {
  const f = await setup({
    updates: [
      {
        id: "topic",
        title: "주제",
        summary: "시험 주제",
        scope: "team",
        content: "기존 내용\n새 결과",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
    candidates: [
      {
        pageId: "topic",
        key: "retry",
        value: "실패",
        kind: "claim",
        conditions: {},
        exceptions: [],
        validFrom: null,
        validTo: null,
        uncertainty: "미상",
        sourceId: source.id,
        quote: "실패 시 재시도한다.",
      },
    ],
  });
  try {
    const b = await f.runtime.file(f.ctx, f.answer.id);
    if ("outcome" in b) throw Error("expected proposal");
    const reviewer = { workspaceId: f.workspaceId, principalId: "reviewer" };
    await f.runtime.core.approve(reviewer, b.id, b.hash);
    await f.pool.query(
      "INSERT INTO workflow_source_state(workspace_id,source_id,state) VALUES($1,$2,'withdrawn')",
      [f.workspaceId, source.id],
    );
    await expect(
      f.runtime.core.publish(reviewer, b.id, b.hash, "withdrawn"),
    ).rejects.toThrow();
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM versions WHERE workspace_id=$1 AND page_id='topic'",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("1");
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM refinement_claims WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    await f.pool.end();
  }
});

test("model cannot rewrite an existing page outside its sealed input context", async () => {
  const f = await setup({
    updates: [
      {
        id: "unseen",
        title: "Unseen",
        summary: "",
        scope: "team",
        content: "모델이 보지 못한 변경",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
  });
  try {
    await f.pool.query("INSERT INTO resources VALUES($1,'page','unseen')", [
      f.workspaceId,
    ]);
    for (const who of ["editor", "reviewer", "reader"])
      await f.pool.query(
        "INSERT INTO resource_readers VALUES($1,'page','unseen',$2)",
        [f.workspaceId, who],
      );
    const page = (
      await f.pool.query(
        "SELECT data FROM pages WHERE workspace_id=$1 AND id='topic'",
        [f.workspaceId],
      )
    ).rows[0].data;
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES($1,'unseen',$2)",
      [f.workspaceId, { ...page, id: "unseen", title: "Unseen" }],
    );
    const version = (
      await f.pool.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id='topic' AND number=1",
        [f.workspaceId],
      )
    ).rows[0].data;
    await f.pool.query("INSERT INTO versions VALUES($1,'unseen',1,$2)", [
      f.workspaceId,
      version,
    ]);
    await expect(f.runtime.file(f.ctx, f.answer.id)).rejects.toThrow(
      "MODEL_INVALID",
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    await f.pool.end();
  }
});

test("model cannot change protected human pages even when actor can protect them", async () => {
  const f = await setup({
    updates: [
      {
        id: "topic",
        title: "주제",
        summary: "시험 주제",
        scope: "team",
        content: "기존 내용\n새 결과",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
  });
  try {
    await f.pool.query(
      "UPDATE access_grants SET role='maintain' WHERE workspace_id=$1 AND principal_id='editor'",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,'topic','active','{\"protected\":true}')",
      [f.workspaceId],
    );
    await expect(f.runtime.file(f.ctx, f.answer.id)).rejects.toThrow(
      "FORBIDDEN",
    );
  } finally {
    await f.pool.end();
  }
});

const protectedRaceOutput = {
  updates: [
    {
      id: "topic",
      title: "주제",
      summary: "시험 주제",
      scope: "team",
      content: "기존 내용\n모델 변경",
      links: [],
      facts: [],
      sourceIds: [source.id],
      baseVersion: 1,
    },
  ],
  reason: "새 조건 검토",
  candidates: [
    {
      pageId: "topic",
      key: "retry",
      value: "실패",
      kind: "inference",
      conditions: {},
      exceptions: [],
      validFrom: null,
      validTo: null,
      uncertainty: "미확인",
      sourceId: source.id,
      quote: "실패 시 재시도한다.",
    },
  ],
};
async function assertNoPublishedEvolution(
  f: Awaited<ReturnType<typeof setup>>,
) {
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM versions WHERE workspace_id=$1 AND page_id='topic'",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).toBe("1");
  for (const table of ["refinement_evidence", "refinement_claims"]) {
    expect(
      (
        await f.pool.query(
          `SELECT count(*) FROM ${table} WHERE workspace_id=$1`,
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
  }
}
async function protectTopic(f: Awaited<ReturnType<typeof setup>>) {
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,'topic','active','{\"protected\":true}') ON CONFLICT(workspace_id,page_id) DO UPDATE SET data=excluded.data, revision=workflow_document_state.revision+1",
    [f.workspaceId],
  );
}

test("protection added before pending model proposal release blocks release and rolls back it", async () => {
  const f = await setup(protectedRaceOutput);
  try {
    let sawPending = false;
    const ctx = {
      ...f.ctx,
      authorization: {
        ...f.ctx.authorization,
        revalidate: async () => {
          const pending = await f.pool.query(
            "SELECT 1 FROM batches WHERE workspace_id=$1 AND data->>'requestAuthorizationPending'='true'",
            [f.workspaceId],
          );
          if (pending.rowCount && !sawPending) {
            sawPending = true;
            await protectTopic(f);
          }
        },
      },
    };
    await expect(f.runtime.file(ctx, f.answer.id)).rejects.toThrow("FORBIDDEN");
    expect(sawPending).toBe(true);
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
    await assertNoPublishedEvolution(f);
  } finally {
    await f.pool.end();
  }
});

test("protection added after proposal blocks approval even for protect-capable reviewer", async () => {
  const f = await setup(protectedRaceOutput);
  try {
    const b = await f.runtime.file(f.ctx, f.answer.id);
    if ("outcome" in b) throw Error("expected proposal");
    await protectTopic(f);
    await expect(
      f.runtime.core.approve(
        { workspaceId: f.workspaceId, principalId: "reviewer" },
        b.id,
        b.hash,
      ),
    ).rejects.toThrow("FORBIDDEN");
    await assertNoPublishedEvolution(f);
  } finally {
    await f.pool.end();
  }
});

test("protection added after approval blocks publication and creates no version or claims", async () => {
  const f = await setup(protectedRaceOutput);
  try {
    const b = await f.runtime.file(f.ctx, f.answer.id);
    if ("outcome" in b) throw Error("expected proposal");
    const reviewer = { workspaceId: f.workspaceId, principalId: "reviewer" };
    await f.runtime.core.approve(reviewer, b.id, b.hash);
    await protectTopic(f);
    await expect(
      f.runtime.core.publish(reviewer, b.id, b.hash, "protection-race"),
    ).rejects.toThrow("FORBIDDEN");
    await assertNoPublishedEvolution(f);
  } finally {
    await f.pool.end();
  }
});

test("human-authored proposals keep the existing protected-page review policy", async () => {
  const f = await setup(null);
  try {
    const b = await f.runtime.core.propose(
      f.editor,
      [
        {
          id: "topic",
          title: "주제",
          summary: "시험 주제",
          scope: "team",
          content: "기존 내용\n사람의 명시 수정",
          links: [],
          facts: [],
          sourceIds: [source.id],
          baseVersion: 1,
        },
      ],
      [source.id],
    );
    await protectTopic(f);
    const reviewer = { workspaceId: f.workspaceId, principalId: "reviewer" };
    await f.runtime.core.approve(reviewer, b.id, b.hash);
    const result = await f.runtime.core.publish(
      reviewer,
      b.id,
      b.hash,
      "human-protected",
    );
    expect(result.versions.topic).toBe(2);
  } finally {
    await f.pool.end();
  }
});
