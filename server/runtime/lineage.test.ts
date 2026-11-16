import { expect, test } from "vitest";
import { fixture, source, adoptFixture } from "../test-support";
import { approveInProcessModelFixture } from "../policy/test-fixture";
import { RuntimeService } from "./knowledge";
import { WorkflowService } from "../workflows/service";
import { authorizeInTransaction } from "../access/index";
import { RefinementService } from "../refinement/service";
const candidate = {
  pageId: "topic",
  key: "retry",
  value: "conditional retry",
  kind: "inference",
  conditions: { os: "linux" },
  exceptions: ["permanent failure"],
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  uncertainty: "single unverified source",
  sourceId: source.id,
  quote: "실패 시 재시도한다.",
};
const update = {
  id: "topic",
  title: "주제",
  summary: "시험 주제",
  scope: "team",
  content: "기존 내용\n조건부 재시도",
  links: [],
  facts: [],
  sourceIds: [source.id],
  baseVersion: 1,
};
async function setup() {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const authorization = await approveInProcessModelFixture(
    f.pool,
    f.workspaceId,
    [source.id],
  );
  const inputs: any[] = [];
  const runtime = new RuntimeService(f.pool, async (_op, input) => {
    inputs.push(input);
    return { updates: [update], candidates: [candidate], reason: "조건 보완" };
  });
  return {
    ...f,
    runtime,
    inputs,
    actor: { ...f.editor, authorization },
    refinement: new RefinementService(f.pool, authorizeInTransaction),
  };
}
test("ordinary ingest publishes exact claim lineage atomically, without execution verification", async () => {
  const f = await setup();
  try {
    const b = await f.runtime.ingest(f.actor, [source.id], "model");
    if ("noChanges" in b) throw Error("proposal required");
    const pending = (await f.runtime.changesets(f.ctx)).find(
      (x) => x.id === b.id,
    )!;
    expect(pending.candidates).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM refinement_claims WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("0");
    await f.runtime.core.approve(f.ctx, b.id, b.hash);
    await f.runtime.core.publish(f.ctx, b.id, b.hash, "lineage");
    await f.runtime.core.publish(f.ctx, b.id, b.hash, "lineage");
    const claims = (
      await f.refinement.context(f.ctx, { environment: { os: "linux" } })
    ).items;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      pageVersion: 2,
      conditions: { os: "linux" },
      exceptions: ["permanent failure"],
      verifiedAt: null,
    });
    const evidence = (
      await f.pool.query(
        "SELECT data FROM refinement_evidence WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].data;
    expect(evidence.location.quote).toBe(candidate.quote);
    expect(
      source.content.slice(evidence.location.start, evidence.location.end),
    ).toBe(candidate.quote);
    expect(evidence.verifiedAt).toBeNull();
    expect(evidence.kind).toBe("claim");
  } finally {
    await f.pool.end();
  }
});
test("a review rejection reason reaches the next ingest and blocks the unchanged rejected proposal", async () => {
  const f = await setup();
  try {
    const b = await f.runtime.ingest(f.actor, [source.id], "model");
    if ("noChanges" in b) throw Error("proposal required");
    await f.runtime.reject(
      f.ctx,
      b.id,
      b.hash,
      "환경별 예외를 먼저 보완하세요",
    );
    await expect(
      f.runtime.ingest(f.actor, [source.id], "model"),
    ).rejects.toThrow("REJECTED_PROPOSAL_UNCHANGED");
    expect(f.inputs[1].reviewFeedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "환경별 예외를 먼저 보완하세요",
          batchId: b.id,
        }),
      ]),
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("1");
  } finally {
    await f.pool.end();
  }
});
test("source correction queues affected published claims and versions without overwriting or verifying them", async () => {
  const f = await setup();
  try {
    const b = await f.runtime.ingest(f.actor, [source.id], "model");
    if ("noChanges" in b) throw Error("proposal required");
    await f.runtime.core.approve(f.ctx, b.id, b.hash);
    await f.runtime.core.publish(f.ctx, b.id, b.hash, "correction");
    const workflows = new WorkflowService(
      f.pool,
      f.runtime,
      authorizeInTransaction,
    );
    await workflows.correctSource(f.editor, source.id, {
      id: "corrected-source",
      content: "영구 오류에는 재시도하지 않는다.",
      reason: "영구 오류 예외",
    });
    const requests = (await f.refinement.requests(f.ctx)).items;
    const impact = requests.find((x) => x.reason === "source-correction")!;
    expect(impact).toMatchObject({
      status: "pending-review",
      claimIds: expect.any(Array),
      usedVersions: expect.arrayContaining([{ page_id: "topic", version: 2 }]),
    });
    expect(impact.claimIds).toHaveLength(1);
    expect((await f.runtime.core.readPage(f.ctx, "topic")).version.number).toBe(
      2,
    );
    expect(
      (
        await f.pool.query(
          "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, source.id],
        )
      ).rows[0].data.content,
    ).toBe(source.content);
  } finally {
    await f.pool.end();
  }
});
test("fabricated ingest quotes create neither candidates nor proposals", async () => {
  const f = await setup();
  try {
    const invalid = new RuntimeService(f.pool, async () => ({
      updates: [update],
      candidates: [{ ...candidate, quote: "invented quote" }],
    }));
    await expect(invalid.ingest(f.actor, [source.id], "model")).rejects.toThrow(
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
test("source access revoked during ordinary model ingest cannot create a proposal", async () => {
  const f = await setup();
  try {
    const racing = new RuntimeService(f.pool, async () => {
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='editor'",
        [f.workspaceId, source.id],
      );
      return { updates: [update], candidates: [candidate] };
    });
    await expect(
      racing.ingest(f.actor, [source.id], "model"),
    ).rejects.toThrow();
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
test("correction invalidates pending approval, preserves feedback and supplies both immutable source versions", async () => {
  const f = await setup();
  try {
    const b = await f.runtime.ingest(f.actor, [source.id], "model");
    if ("noChanges" in b) throw Error("proposal required");
    await f.runtime.core.approve(f.ctx, b.id, b.hash);
    const workflows = new WorkflowService(
      f.pool,
      f.runtime,
      authorizeInTransaction,
    );
    await workflows.correctSource(f.editor, source.id, {
      id: "corrected-source",
      content: "영구 오류에는 재시도하지 않는다.",
      reason: "영구 오류 예외",
    });
    await expect(
      f.runtime.core.publish(f.ctx, b.id, b.hash, "stale-correction"),
    ).rejects.toThrow();
    const revised = new RuntimeService(f.pool, async (_op, input) => {
      const c = (input as any).sourceCorrections[0];
      expect(c.original.content).toBe(source.content);
      expect(c.replacement.content).toBe("영구 오류에는 재시도하지 않는다.");
      expect(c.reason).toBe("영구 오류 예외");
      return {
        updates: [{ ...update, sourceIds: ["corrected-source"] }],
        candidates: [
          {
            ...candidate,
            sourceId: "corrected-source",
            quote: "영구 오류에는 재시도하지 않는다.",
          },
        ],
      };
    });
    // Allow the newly registered source to be sent through the same explicit test policy.
    const authorization = await approveInProcessModelFixture(
      f.pool,
      f.workspaceId,
      [source.id, "corrected-source"],
    );
    const next = await revised.ingest(
      { ...f.editor, authorization },
      ["corrected-source"],
      "model",
    );
    if ("noChanges" in next) throw Error("proposal required");
    const stored = (
      await f.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, next.id],
      )
    ).rows[0].data;
    expect(stored.inputEnvelope.sourceIds.sort()).toEqual(
      [source.id, "corrected-source"].sort(),
    );
    expect(stored.updates[0].sourceIds).toEqual(
      expect.arrayContaining([source.id, "corrected-source"]),
    );
  } finally {
    await f.pool.end();
  }
});
test("rejected feedback is immutable on replay and hidden when any influencing source loses access", async () => {
  const f = await setup();
  try {
    const b = await f.runtime.ingest(f.actor, [source.id], "model");
    if ("noChanges" in b) throw Error("proposal required");
    await f.runtime.reject(f.ctx, b.id, b.hash, "보호된 수정 사유");
    await f.runtime.reject(f.ctx, b.id, b.hash, "보호된 수정 사유");
    await expect(
      f.runtime.reject(f.ctx, b.id, b.hash, "이유 덮어쓰기"),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='editor'",
      [f.workspaceId, source.id],
    );
    expect(await f.runtime.changesets(f.editor)).toHaveLength(0);
    const { rejectedFeedback } = await import("./ingest-lineage");
    const { transaction } = await import("../database");
    const snapshot = await f.runtime.snapshot(f.editor);
    expect(
      await transaction(f.pool, f.workspaceId, (db) =>
        rejectedFeedback(db, f.editor, snapshot.state, ["topic"], [source.id]),
      ),
    ).toHaveLength(0);
  } finally {
    await f.pool.end();
  }
});
test("published human edit reasons and current protection reasons reach ordinary ingest", async () => {
  const f = await setup();
  try {
    const workflows = new WorkflowService(
      f.pool,
      f.runtime,
      authorizeInTransaction,
    );
    const edit = await workflows.proposeEdit(f.editor, "topic", {
      baseVersion: 1,
      content: "사람이 보존한 Linux 예외",
      reason: "영구 오류 예외 유지",
    });
    await f.runtime.core.approve(f.ctx, edit.id, edit.hash);
    await f.runtime.core.publish(f.ctx, edit.id, edit.hash, "human-edit");
    let input: any;
    const runtime = new RuntimeService(f.pool, async (_op, i) => {
      input = i;
      return {
        updates: [
          {
            ...update,
            baseVersion: 2,
            content: "사람이 보존한 Linux 예외\n보완",
          },
        ],
      };
    });
    await runtime.ingest(f.actor, [source.id], "model");
    expect(input.humanDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageId: "topic",
          reason: "영구 오류 예외 유지",
          kind: "published-edit",
        }),
      ]),
    );
  } finally {
    await f.pool.end();
  }
});
test("ordinary model ingest cannot propose an automatic replacement of protected human content", async () => {
  const f = await setup();
  try {
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,state,revision,data) VALUES($1,'topic','active',1,$2)",
      [f.workspaceId, { protected: true, reason: "사람이 정한 예외 유지" }],
    );
    let input: any;
    const runtime = new RuntimeService(f.pool, async (_op, i) => {
      input = i;
      return { updates: [update], candidates: [candidate] };
    });
    await expect(runtime.ingest(f.actor, [source.id], "model")).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(input.humanDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageId: "topic",
          reason: "사람이 정한 예외 유지",
          kind: "protection",
        }),
      ]),
    );
  } finally {
    await f.pool.end();
  }
});
test("a new human protection decision made during model execution invalidates the proposal", async () => {
  const f = await setup();
  try {
    const runtime = new RuntimeService(f.pool, async () => {
      await f.pool.query(
        "INSERT INTO workflow_document_state(workspace_id,page_id,state,revision,data) VALUES($1,'topic','active',1,$2)",
        [f.workspaceId, { protected: true, reason: "새 보호 결정" }],
      );
      return { updates: [update], candidates: [candidate] };
    });
    await expect(
      runtime.ingest(f.actor, [source.id], "model"),
    ).rejects.toThrow();
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
test("source correction impact disappears when the replacement's current ACL is revoked", async () => {
  const f = await setup();
  try {
    const workflows = new WorkflowService(
      f.pool,
      f.runtime,
      authorizeInTransaction,
    );
    await workflows.correctSource(f.editor, source.id, {
      id: "corrected-source",
      content: "정정 원본",
      reason: "정정 이유",
    });
    expect(
      (await f.refinement.requests(f.ctx)).items.some(
        (r) => r.reason === "source-correction",
      ),
    ).toBe(true);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='corrected-source' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    expect(
      (await f.refinement.requests(f.ctx)).items.some(
        (r) => r.reason === "source-correction",
      ),
    ).toBe(false);
  } finally {
    await f.pool.end();
  }
});
