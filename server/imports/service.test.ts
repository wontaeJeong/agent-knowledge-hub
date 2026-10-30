import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import type { ModelCall } from "../runtime/model";
import { defaultSelection } from "../../src/domain/imports";
import { hash } from "./parser";
import { PART_SIZE } from "./service";

const pools: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  delete process.env.IMPORT_DISCLOSURE_REVIEWERS;
  await Promise.all(pools.splice(0).map((f) => f.pool.end()));
});
const model: ModelCall = async (op, raw) => {
  if (op !== "organize") throw Error("UNEXPECTED_MODEL_OPERATION");
  const input = raw as {
    records: { id: string; text: string }[];
    recordIds?: string[];
    candidates?: unknown[];
    pages: { id: string; content: string }[];
  };
  const rs = input.records;
  return {
    topics: [
      {
        key: "ttl",
        title: "TTL 운영 조건",
        summary: "제안과 운영 상태 구별",
        content: "# TTL\n기존 내용\n운영 60초 유지. 300초는 제안입니다.",
        targetPageId: input.pages.find((p) => p.id === "topic")?.id || null,
        relatedPageIds: [],
        statements: rs.map((r) => ({
          kind: "statement",
          text: r.text,
          context: "원문 진술 · 실행 증거 미첨부",
          recordId: r.id,
          quote: r.text,
        })),
      },
    ],
    excluded: [],
  };
};
async function setup(call: ModelCall = model) {
  const f = await fixture();
  pools.push(f);
  return { ...f, runtime: new RuntimeService(f.pool, call) };
}
async function upload(
  f: Awaited<ReturnType<typeof setup>>,
  content = "[2026-10-19 09:00] A: 운영은 60초입니다\n[2026-10-21 10:00] B: 300초로 변경할까요?",
) {
  const bytes = Buffer.from(content),
    input = {
      title: "1주일 대화",
      files: [
        {
          id: "text",
          name: "chat.txt",
          size: bytes.length,
          sha256: hash(bytes),
        },
      ],
    };
  const created = await f.runtime.imports.create(f.editor, input, randomUUID());
  for (
    let offset = 0, part = 0;
    offset < bytes.length;
    offset += PART_SIZE, part++
  ) {
    const data = bytes.subarray(offset, offset + PART_SIZE);
    await f.runtime.imports.uploadPart(f.editor, created.id, "text", part, {
      data: data.toString("base64"),
      sha256: hash(data),
    });
  }
  const run = await f.runtime.imports.finalize(
    f.editor,
    created.id,
    randomUUID(),
  );
  return { id: created.id, preflight: run.id, input, bytes };
}
async function organized(f: Awaited<ReturnType<typeof setup>>) {
  const item = await upload(f);
  await f.runtime.imports.tick();
  let view = await f.runtime.imports.view(f.editor, item.id);
  expect(view.parsed?.records).toHaveLength(2);
  await f.runtime.imports.select(f.editor, item.id, view.revision, {
    ...view.selection,
    acknowledgeWarnings: true,
  });
  const run = await f.runtime.imports.start(
    f.editor,
    item.id,
    { revision: view.revision, mode: "model" },
    randomUUID(),
  );
  await f.runtime.imports.tick();
  view = await f.runtime.imports.view(f.editor, item.id);
  expect(view.runs.find((r) => r.id === run.id)?.status).toBe("review_ready");
  return { ...item, runId: run.id, view };
}
test("raw upload is durable, bounded, idempotent and isolated even from workspace reviewers", async () => {
  const f = await setup(),
    item = await upload(f);
  await expect(f.runtime.imports.view(f.ctx, item.id)).rejects.toThrow(
    "NOT_FOUND",
  );
  expect(await f.runtime.imports.list(f.ctx)).toEqual([]);
  const next = new RuntimeService(f.pool, model);
  await next.imports.tick();
  const view = await next.imports.view(f.editor, item.id);
  expect(view.parsed?.counts.selected).toBe(2);
  expect(view.runs[0].status).toBe("parsed");
  const raw = await f.pool.query(
    "SELECT data FROM import_parts WHERE workspace_id=$1 AND import_id=$2",
    [f.workspaceId, item.id],
  );
  expect(Buffer.concat(raw.rows.map((r) => r.data)).equals(item.bytes)).toBe(
    true,
  );
  const key = randomUUID(),
    first = await next.imports.create(f.editor, item.input, key);
  expect(await next.imports.create(f.editor, item.input, key)).toEqual(first);
  await expect(
    next.imports.create(f.editor, { ...item.input, title: "other" }, key),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
test("incomplete files/checksum changes/oversized parts never finalize or silently overwrite", async () => {
  const f = await setup(),
    data = Buffer.from("hello"),
    created = await f.runtime.imports.create(
      f.editor,
      {
        title: "file",
        files: [{ id: "f", name: "x.txt", size: 5, sha256: hash(data) }],
      },
      randomUUID(),
    );
  await expect(
    f.runtime.imports.finalize(f.editor, created.id, randomUUID()),
  ).rejects.toThrow("UPLOAD_INCOMPLETE");
  await expect(
    f.runtime.imports.uploadPart(f.editor, created.id, "f", 0, {
      data: data.toString("base64"),
      sha256: "0".repeat(64),
    }),
  ).rejects.toThrow("CHECKSUM_MISMATCH");
  await f.runtime.imports.uploadPart(f.editor, created.id, "f", 0, {
    data: data.toString("base64"),
    sha256: hash(data),
  });
  await expect(
    f.runtime.imports.uploadPart(f.editor, created.id, "f", 0, {
      data: Buffer.from("world").toString("base64"),
      sha256: hash("world"),
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
test("model organization creates private proposals only; explicit source disclosure and independent publication are separate", async () => {
  const f = await setup(),
    item = await organized(f);
  expect(await f.runtime.changesets(f.editor)).toHaveLength(0);
  expect(await f.runtime.imports.disclosureList(f.ctx)).toEqual([]);
  await expect(
    f.runtime.imports.requestDisclosure(f.editor, item.runId, {
      reviewerId: "reviewer",
      readers: ["editor", "reviewer"],
      sourceAuthorization: "request_authorized_source_review",
    }),
  ).rejects.toThrow("FORBIDDEN");
  process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
  const request = await f.runtime.imports.requestDisclosure(
    f.editor,
    item.runId,
    {
      reviewerId: "reviewer",
      readers: ["editor", "reviewer", "reader"],
      sourceAuthorization: "request_authorized_source_review",
    },
  );
  const queue = await f.runtime.imports.disclosureList(f.ctx);
  expect(queue).toHaveLength(1);
  expect(queue[0].records).toHaveLength(2);
  const batch = await f.runtime.imports.approveDisclosure(
    f.ctx,
    item.runId,
    request.hash,
  );
  expect(
    await f.runtime.imports.approveDisclosure(f.ctx, item.runId, request.hash),
  ).toEqual(batch);
  expect((await f.runtime.pages(f.reader))[0].content).toBe("기존 내용");
  await f.runtime.core.approve(f.ctx, batch.id, batch.hash);
  await f.runtime.core.publish(f.ctx, batch.id, batch.hash, "publish-import");
  expect((await f.runtime.pages(f.reader))[0].content).toContain(
    "운영 60초 유지",
  );
  expect(
    (await f.runtime.imports.view(f.editor, item.id)).runs.find(
      (r) => r.id === item.runId,
    )?.changeSet,
  ).toEqual(batch);
});
test("hidden context prevents widening source audience and stale context invalidates disclosure", async () => {
  const f = await setup(),
    item = await organized(f);
  process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    f.runtime.imports.requestDisclosure(f.editor, item.runId, {
      reviewerId: "reviewer",
      readers: ["editor", "reviewer", "reader"],
      sourceAuthorization: "request_authorized_source_review",
    }),
  ).rejects.toThrow("STALE_VERSION");
  expect(await f.runtime.imports.disclosureList(f.ctx)).toEqual([]);
});
test("revocation during model call prevents result commits and requires fresh authorization", async () => {
  let release: () => void = () => {},
    entered: () => void = () => {};
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const f = await setup(async (op, data) => {
    entered();
    await gate;
    return model(op, data);
  });
  const item = await upload(f);
  await f.runtime.imports.tick();
  const view = await f.runtime.imports.view(f.editor, item.id);
  await f.runtime.imports.select(f.editor, item.id, view.revision, {
    ...view.selection,
    acknowledgeWarnings: true,
  });
  const run = await f.runtime.imports.start(
    f.editor,
    item.id,
    { revision: view.revision, mode: "model" },
    randomUUID(),
  );
  const execution = f.runtime.imports.tick();
  await ready;
  await f.pool.query(
    "UPDATE memberships SET role='reader' WHERE workspace_id=$1 AND principal_id='editor'",
    [f.workspaceId],
  );
  release();
  await execution;
  const stored = await f.pool.query(
    "SELECT status,result FROM import_runs WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, run.id],
  );
  expect(stored.rows[0]).toEqual({
    status: "authorization_required",
    result: null,
  });
});
test("cancel races and expired leases cannot commit late model results", async () => {
  let release: () => void = () => {},
    entered: () => void = () => {};
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const f = await setup(async (op, data) => {
    entered();
    await gate;
    return model(op, data);
  });
  const item = await upload(f);
  await f.runtime.imports.tick();
  const view = await f.runtime.imports.view(f.editor, item.id);
  await f.runtime.imports.select(f.editor, item.id, view.revision, {
    ...view.selection,
    acknowledgeWarnings: true,
  });
  const run = await f.runtime.imports.start(
    f.editor,
    item.id,
    { revision: view.revision, mode: "model" },
    randomUUID(),
  );
  const execution = f.runtime.imports.tick();
  await ready;
  await f.runtime.imports.cancel(f.editor, run.id);
  release();
  await execution;
  expect((await f.runtime.imports.runViewFor(f.editor, run.id)).status).toBe(
    "cancelled",
  );
  expect(
    (await f.runtime.imports.runViewFor(f.editor, run.id)).result,
  ).toBeNull();
});
test("revision changes invalidate stale runs and acknowledgements do not discard parsed input", async () => {
  const f = await setup(),
    item = await upload(f);
  await f.runtime.imports.tick();
  const view = await f.runtime.imports.view(f.editor, item.id);
  const ack = await f.runtime.imports.select(f.editor, item.id, view.revision, {
    ...view.selection,
    acknowledgeWarnings: true,
  });
  expect(ack.revision).toBe(view.revision);
  expect(
    (await f.runtime.imports.view(f.editor, item.id)).parsed,
  ).not.toBeNull();
  const next = await f.runtime.imports.select(
    f.editor,
    item.id,
    view.revision,
    { ...defaultSelection, project: "changed" },
  );
  expect(next.revision).toBe(view.revision + 1);
  await expect(
    f.runtime.imports.start(
      f.editor,
      item.id,
      { revision: view.revision, mode: "model" },
      randomUUID(),
    ),
  ).rejects.toThrow("INPUT_CHANGED");
});
test("restart reclaims an expired running preflight without a process-local queue", async () => {
  const f = await setup(),
    item = await upload(f);
  await f.pool.query(
    "UPDATE import_runs SET status='running',lease_token=7,lease_until=now()-interval '1 minute',attempt=1 WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, item.preflight],
  );
  const restarted = new RuntimeService(f.pool, model);
  expect(await restarted.imports.tick()).toBe(true);
  const run = await restarted.imports.runViewFor(f.editor, item.preflight);
  expect(run.status).toBe("parsed");
  expect(run.attempt).toBe(2);
});

test("a recovered lease fences out a late worker without replacing the winner's result", async () => {
  let release: () => void = () => {},
    entered: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  const f = await setup(async (op, input) => {
    entered();
    await gate;
    return model(op, input);
  });
  const item = await upload(f);
  await f.runtime.imports.tick();
  const preview = await f.runtime.imports.view(f.editor, item.id);
  await f.runtime.imports.select(f.editor, item.id, preview.revision, {
    ...preview.selection,
    acknowledgeWarnings: true,
  });
  const run = await f.runtime.imports.start(
    f.editor,
    item.id,
    { revision: preview.revision, mode: "model" },
    randomUUID(),
  );
  const stale = f.runtime.imports.tick();
  await ready;
  await f.pool.query(
    "UPDATE import_runs SET lease_until=now()-interval '1 second' WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, run.id],
  );
  const recovered = new RuntimeService(f.pool, model);
  await recovered.imports.tick();
  release();
  await stale;
  const result = await recovered.imports.runViewFor(f.editor, run.id);
  expect(result.status).toBe("review_ready");
  expect(result.attempt).toBe(2);
  expect(result.result?.calls).toBe(2);
});

test("previously synthesized private results cannot be reread after a hidden input ACL is revoked", async () => {
  const f = await setup(),
    item = await organized(f);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
    [f.workspaceId],
  );
  const view = await f.runtime.imports.view(f.editor, item.id),
    run = view.runs.find((r) => r.id === item.runId)!;
  expect(run.result).toBeNull();
  expect(run.status).toBe("authorization_required");
});

test("owner withdrawal erases raw input and revokes published derivatives and approval replays", async () => {
  const f = await setup(),
    item = await organized(f);
  process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
  const request = await f.runtime.imports.requestDisclosure(
    f.editor,
    item.runId,
    {
      reviewerId: "reviewer",
      readers: ["editor", "reviewer", "reader"],
      sourceAuthorization: "request_authorized_source_review",
    },
  );
  const batch = await f.runtime.imports.approveDisclosure(
    f.ctx,
    item.runId,
    request.hash,
  );
  await f.runtime.core.approve(f.ctx, batch.id, batch.hash);
  await f.runtime.core.publish(f.ctx, batch.id, batch.hash, "withdraw-test");
  const removed = await f.runtime.imports.remove(f.editor, item.id);
  expect(removed.withdrawnSources).toBeGreaterThan(0);
  await expect(f.runtime.imports.view(f.editor, item.id)).rejects.toThrow(
    "NOT_FOUND",
  );
  expect(
    (
      await f.pool.query(
        "SELECT part FROM import_parts WHERE workspace_id=$1 AND import_id=$2",
        [f.workspaceId, item.id],
      )
    ).rows,
  ).toEqual([]);
  expect(await f.runtime.pages(f.reader)).toEqual([]);
  await expect(
    f.runtime.core.publish(f.ctx, batch.id, batch.hash, "withdraw-test"),
  ).rejects.toThrow();
});
