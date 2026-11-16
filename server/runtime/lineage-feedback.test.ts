import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { fixture, source, adoptFixture } from "../test-support";
import { RuntimeService } from "./knowledge";
import { callModel, type ModelCall } from "./model";
import {
  approveInProcessModelFixture,
  approveLocalTransmissionFixture,
} from "../policy/test-fixture";
const SENTINEL = "RESTRICTED_LINK_REVIEW_REASON";
const draft = {
  id: "topic",
  title: "주제",
  summary: "summary",
  scope: "team" as const,
  content: "Revised after review",
  links: [],
  facts: [],
  sourceIds: [source.id],
  baseVersion: 1,
};
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const runtime = new RuntimeService(f.pool);
  await runtime.core.registerSource(
    f.editor,
    {
      ...source,
      id: "linked-source",
      content: "linked source observation",
      scope: "team",
      targetPageId: "secret-leaf",
    },
    ["editor", "reviewer", "reader"],
  );
  const leaf = await runtime.core.propose(
    f.editor,
    [
      {
        ...draft,
        id: "secret-leaf",
        title: "leaf",
        scope: "team",
        content: "secret leaf",
        sourceIds: ["linked-source"],
        baseVersion: 0,
      },
    ],
    ["linked-source"],
  );
  await runtime.core.approve(f.ctx, leaf.id, leaf.hash);
  await runtime.core.publish(f.ctx, leaf.id, leaf.hash, "leaf");
  const link = await runtime.core.propose(
    f.editor,
    [
      {
        ...draft,
        id: "secret-linked",
        title: "linked",
        scope: "team",
        content: "secret linked",
        links: ["secret-leaf"],
        sourceIds: ["linked-source"],
        baseVersion: 0,
      },
    ],
    ["linked-source"],
  );
  await runtime.core.approve(f.ctx, link.id, link.hash);
  await runtime.core.publish(f.ctx, link.id, link.hash, "link");
  const rejected = await runtime.core.propose(
    f.editor,
    [{ ...draft, content: SENTINEL, links: ["secret-linked"] }],
    [source.id],
  );
  await runtime.reject(f.ctx, rejected.id, rejected.hash, SENTINEL);
  // Historical linked pages remain readable but are absent from current model context.
  for (const id of ["secret-linked", "secret-leaf"])
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,state,revision,data) VALUES($1,$2,'archived',1,'{}')",
      [f.workspaceId, id],
    );
  const authorization = await approveInProcessModelFixture(
    f.pool,
    f.workspaceId,
    [source.id, "linked-source"],
  );
  const inputs: any[] = [];
  const model: ModelCall = async (op, input) => {
    inputs.push(input);
    return op === "query"
      ? {
          content: "기존 내용",
          insufficient: false,
          citations: [
            { pageId: "topic", title: "주제", version: 1, quote: "기존 내용" },
          ],
        }
      : { updates: [draft] };
  };
  return {
    ...f,
    runtime: new RuntimeService(f.pool, model),
    actor: { ...f.editor, authorization },
    inputs,
    rejected,
  };
}
async function revoke(
  f: Awaited<ReturnType<typeof setup>>,
  kind: "page" | "source",
  id: string,
) {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3 AND principal_id='editor'",
    [f.workspaceId, kind, id],
  );
}
test.each([
  ["page", "secret-linked"],
  ["page", "secret-leaf"],
  ["source", "linked-source"],
] as const)(
  "revoked %s %s suppresses the entire rejected text/reason in ordinary model input",
  async (kind, id) => {
    const f = await setup();
    try {
      await revoke(f, kind, id);
      expect(
        (await f.runtime.changesets(f.actor)).some(
          (b) => b.id === f.rejected.id,
        ),
      ).toBe(false);
      await f.runtime.ingest(f.actor, [source.id], "model");
      expect(JSON.stringify(f.inputs[0])).not.toContain(SENTINEL);
      expect(f.inputs[0].reviewFeedback).toEqual([]);
    } finally {
      await f.pool.end();
    }
  },
);
test("visible offline historical feedback pins all linked pages and transitive source lineage", async () => {
  const f = await setup();
  try {
    const b = await f.runtime.ingest(f.actor, [source.id], "model");
    if ("noChanges" in b) throw Error("proposal");
    expect(f.inputs[0].pages.map((p: any) => p.id)).toEqual(["topic"]);
    expect(JSON.stringify(f.inputs[0].reviewFeedback)).toContain(SENTINEL);
    const stored = (
      await f.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, b.id],
      )
    ).rows[0].data;
    expect(stored.inputEnvelope.pageIds.sort()).toEqual([
      "secret-leaf",
      "secret-linked",
      "topic",
    ]);
    expect(stored.inputEnvelope.sourceIds.sort()).toEqual(
      ["linked-source", source.id].sort(),
    );
    expect(stored.updates[0].sourceIds).toContain("linked-source");
  } finally {
    await f.pool.end();
  }
});
test("readable feedback with a denied linked source policy never reaches the model", async () => {
  const f = await setup();
  try {
    await f.pool.query(
      "DELETE FROM model_source_policies WHERE workspace_id=$1 AND source_id='linked-source'",
      [f.workspaceId],
    );
    await expect(
      f.runtime.ingest(f.actor, [source.id], "model"),
    ).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
    expect(f.inputs).toHaveLength(0);
  } finally {
    await f.pool.end();
  }
});
test("answer reintegration excludes otherwise visible feedback outside the original answer envelope", async () => {
  const f = await setup();
  try {
    const answer = await f.runtime.query(f.actor, "기존", "model");
    const stored = (
      await f.pool.query(
        "SELECT data FROM runtime_answers WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, answer.id],
      )
    ).rows[0].data;
    expect(stored.inputEnvelope.pageIds).toEqual(["topic"]);
    await f.runtime.file(f.actor, answer.id);
    expect(f.inputs[1].reviewFeedback).toEqual([]);
    expect(JSON.stringify(f.inputs[1])).not.toContain(SENTINEL);
  } finally {
    await f.pool.end();
  }
});
test.each(["page", "source"] as const)(
  "revoking a feedback-linked %s after provider response prevents atomic proposal creation",
  async (kind) => {
    const f = await setup();
    try {
      const runtime = new RuntimeService(f.pool, async () => {
        await revoke(
          f,
          kind,
          kind === "page" ? "secret-linked" : "linked-source",
        );
        return { updates: [draft] };
      });
      await expect(
        runtime.ingest(f.actor, [source.id], "model"),
      ).rejects.toThrow();
      const rows = (
        await f.pool.query(
          "SELECT data FROM batches WHERE workspace_id=$1 AND data->>'status'='pending'",
          [f.workspaceId],
        )
      ).rows;
      expect(rows).toHaveLength(0);
    } finally {
      await f.pool.end();
    }
  },
);
test.each(["page", "source", "policy"] as const)(
  "after input sealing, linked %s revocation blocks the actual provider HTTP transmission",
  async (kind) => {
    const f = await setup();
    const received: any[] = [];
    const model = createServer(async (req, res) => {
      let body = "";
      for await (const b of req) body += b;
      received.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ updates: [draft] }) },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
    try {
      vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", base);
      vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "synthetic-loopback");
      vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "feedback-loopback");
      const authorization = await approveLocalTransmissionFixture(
        f.pool,
        f.workspaceId,
        base + "/chat/completions",
        ["ingest"],
        "feedback-loopback",
        [source.id, "linked-source"],
      );
      const runtime = new RuntimeService(f.pool, (op, input, options) =>
        callModel(op, input, {
          ...options,
          beforeCall: async () => {
            if (kind === "policy")
              await f.pool.query(
                "DELETE FROM model_source_policies WHERE workspace_id=$1 AND source_id='linked-source'",
                [f.workspaceId],
              );
            else
              await revoke(
                f,
                kind,
                kind === "page" ? "secret-linked" : "linked-source",
              );
          },
        }),
      );
      await expect(
        runtime.ingest({ ...f.editor, authorization }, [source.id], "model"),
      ).rejects.toThrow();
      expect(received).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => model.close(() => r()));
      await f.pool.end();
    }
  },
);
test.each(["page", "source"] as const)(
  "answer reintegration never transmits rejected prose after a linked %s is revoked",
  async (kind) => {
    const f = await setup();
    try {
      const answer = await f.runtime.query(f.actor, "기존", "model");
      await revoke(
        f,
        kind,
        kind === "page" ? "secret-linked" : "linked-source",
      );
      await f.runtime.file(f.actor, answer.id);
      expect(f.inputs[1].reviewFeedback).toEqual([]);
      expect(JSON.stringify(f.inputs[1])).not.toContain(SENTINEL);
    } finally {
      await f.pool.end();
    }
  },
);
test("proposal-local new links are allowed while all existing dependencies remain pinned", async () => {
  const f = await setup();
  try {
    const p = await f.runtime.core.propose(
      f.editor,
      [
        {
          ...draft,
          content: "Internal linked proposal",
          links: ["new-local-page"],
        },
        {
          ...draft,
          id: "new-local-page",
          title: "new",
          baseVersion: 0,
          links: ["topic"],
          content: "new local interpretation",
        },
      ],
      [source.id],
    );
    await f.runtime.reject(
      f.ctx,
      p.id,
      p.hash,
      "preserve internal proposal reason",
    );
    const b = await f.runtime.ingest(f.actor, [source.id], "model");
    if ("noChanges" in b) throw Error("proposal");
    expect(
      f.inputs[0].reviewFeedback.some((r: any) => r.batchId === p.id),
    ).toBe(true);
    const stored = (
      await f.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, b.id],
      )
    ).rows[0].data;
    expect(stored.inputEnvelope.pageIds).not.toContain("new-local-page");
    expect(stored.inputEnvelope.pageIds).toContain("topic");
  } finally {
    await f.pool.end();
  }
});
test("legacy rejected links that are now cross-scope still pin their readable transmission lineage", async () => {
  const f = await setup();
  try {
    // A historical offline proposal was valid when scopes matched. Simulate a later
    // classification migration without rewriting the rejected proposal snapshot.
    await f.pool.query(
      "UPDATE pages SET data=jsonb_set(data,'{scope}','\"company\"') WHERE workspace_id=$1 AND id=ANY($2::text[])",
      [f.workspaceId, ["secret-linked", "secret-leaf"]],
    );
    await f.pool.query(
      "UPDATE sources SET data=jsonb_set(data,'{scope}','\"company\"') WHERE workspace_id=$1 AND id='linked-source'",
      [f.workspaceId],
    );
    let envelope: any, input: any;
    const runtime = new RuntimeService(f.pool, async (_op, i) => {
      input = i;
      return { updates: [] };
    });
    await expect(
      runtime.ingestForEvaluation(f.actor, [source.id], {
        rules: "synthetic evaluation fixture",
        validate: async (_input, e) => {
          envelope = e;
        },
      }),
    ).rejects.toThrow("NO_CHANGES");
    expect(input.pages.map((p: any) => p.id)).toEqual(["topic"]);
    expect(JSON.stringify(input.reviewFeedback)).toContain(SENTINEL);
    expect(envelope.pageIds).toEqual(
      expect.arrayContaining(["secret-linked", "secret-leaf", "topic"]),
    );
    expect(envelope.sourceIds).toContain("linked-source");
  } finally {
    await f.pool.end();
  }
});
