import { afterEach, expect, it } from "vitest";
import { Pool } from "pg";
import { createServer, type Server } from "node:https";
import { testTlsCertificate } from "../test-tls-fixture";
import { once } from "node:events";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import {
  CollaborationService,
  CollaborationWorker,
  resolveGovernanceResponsibility,
} from "./index";
import { createDigestGateway } from "./delivery";
import { afterQuietHours, nextDigest } from "./time";
import type { CollaborationHooks, Preferences } from "./types";
const pools: Pool[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  if (pools[0])
    await pools[0].query(
      "TRUNCATE collaboration_digest_plans,collaboration_digest_outbox,collaboration_delivery_receipts,collaboration_delivery_events,collaboration_review_cadence,collaboration_review_due_work,workflow_preferences,workflow_notifications CASCADE",
    );
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
const defaults: Preferences = {
  mentions: true,
  subscriptions: true,
  dailyDigest: true,
  weeklyDigest: false,
  timezone: "UTC",
  dailyAt: "09:00",
  weeklyAt: "09:00",
  weeklyDay: 1,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};
async function tlsRelay() {
  const { cert, key } = testTlsCertificate();
  let requests = 0,
    emails = 0,
    loseAck = false,
    redirect = false;
  const receipts = new Map<string, any>(),
    payloads: any[] = [];
  const server = createServer({ cert, key }, async (req, res) => {
    requests++;
    if (req.headers.authorization !== "Bearer fixture-relay-token") {
      res.writeHead(401);
      res.end();
      return;
    }
    if (redirect) {
      res.writeHead(302, { Location: "https://unapproved.invalid/" });
      res.end();
      return;
    }
    if (req.method === "GET") {
      const id = decodeURIComponent(req.url!.slice("/deliveries/".length)),
        r = receipts.get(id);
      res.writeHead(r ? 200 : 404);
      res.end(JSON.stringify(r ?? {}));
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const p = JSON.parse(body);
    payloads.push(p);
    let r = receipts.get(p.deliveryId);
    if (!r) {
      emails++;
      r = {
        deliveryId: p.deliveryId,
        receiptId: "receipt-" + emails,
        status: "delivered",
      };
      receipts.set(p.deliveryId, r);
    }
    if (loseAck) {
      loseAck = false;
      req.socket.destroy();
      return;
    }
    res.end(JSON.stringify(r));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `https://127.0.0.1:${(server.address() as { port: number }).port}/deliveries`;
  return {
    gateway: createDigestGateway({
      url,
      allowedOrigins: [new URL(url).origin],
      ca: cert,
      token: "fixture-relay-token",
      timeoutMs: 1000,
    }),
    url,
    cert,
    requests: () => requests,
    emails: () => emails,
    payloads,
    loseAck: () => {
      loseAck = true;
    },
    redirect: () => {
      redirect = true;
    },
  };
}
async function setup(relay = true) {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  let now = new Date("2026-10-30T08:00:00Z"),
    proofCalls = 0,
    disabled = false;
  let beforeProof: (() => Promise<void>) | undefined;
  const tls = relay ? await tlsRelay() : undefined;
  const hooks: CollaborationHooks = {
    authorize: authorizeInTransaction,
    assertDispatcher: async (db) => {
      await db.query("SELECT 1");
    },
    verifyRecipient: async ({ workspaceId, principalId }) => {
      proofCalls++;
      await beforeProof?.();
      if (disabled) throw Error("RECIPIENT_DISABLED");
      return {
        ctx: { workspaceId, principalId },
        address: principalId + "@example.test",
        issuer: "fixture-directory",
        subject: principalId,
        verifiedAt: now.toISOString(),
        validUntil: new Date(+now + 30000).toISOString(),
        assertCurrent: async () => {
          if (disabled) throw Error("RECIPIENT_DISABLED");
        },
      };
    },
    resolveReviewResponsibility: resolveGovernanceResponsibility,
  };
  const service = new CollaborationService(f.pool, hooks, {
    clock: () => now,
    applicationOrigin: "https://knowledge.example.test",
    gateway: tls?.gateway,
    leaseMs: 1000,
    maxAttempts: 3,
  });
  await service.preferences(f.editor, { expectedRevision: 0, ...defaults });
  return {
    ...f,
    service,
    tls,
    hooks,
    advance: (ms: number) => {
      now = new Date(+now + ms);
    },
    disable: () => {
      disabled = true;
    },
    onProof: (fn: () => Promise<void>) => {
      beforeProof = fn;
    },
    proofCalls: () => proofCalls,
    worker: () =>
      new CollaborationWorker(service, { workerId: "fixture-worker" }),
  };
}
async function event(
  f: Awaited<ReturnType<typeof setup>>,
  id = "n1",
  kind = "publication",
) {
  await f.pool.query(
    "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data,created_at) VALUES($1,$2,'editor','topic',1,$3,'{}','2026-10-30T08:30:00Z')",
    [f.workspaceId, id, kind],
  );
}
it("no-change daily window is durable no-delivery and sends zero HTTPS requests", async () => {
  const f = await setup();
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.requests()).toBe(0);
  const status = await f.service.deliveries(f.editor);
  expect(status.items[0].status).toBe("no-delivery");
});
it("actual TLS digest collapses same-page events, preserves IDs and keeps web ack independent", async () => {
  const f = await setup();
  await event(f);
  await event(f, "n2");
  await f.service.ackNotification(f.editor, "n1");
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.emails()).toBe(1);
  expect(f.tls!.payloads[0].items).toHaveLength(1);
  expect(f.tls!.payloads[0].items[0].eventIds.sort()).toEqual(["n1", "n2"]);
  expect(f.tls!.payloads[0].items[0].title).toBe("주제");
  expect(JSON.stringify(f.tls!.payloads[0])).not.toContain("기존 내용");
  expect((await f.service.deliveries(f.editor)).items[0].status).toBe(
    "delivered",
  );
});
it("directory or source revocation at final pre-send gate sends no protected bytes", async () => {
  const f = await setup();
  await event(f);
  f.onProof(async () => {
    if (f.proofCalls() === 2)
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
        [f.workspaceId],
      );
  });
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.requests()).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT status FROM collaboration_digest_outbox WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].status,
  ).toBe("no-delivery");
});
it("lost TLS acknowledgement retries stable delivery ID and relay dedupe emits only one email", async () => {
  const f = await setup();
  await event(f);
  f.tls!.loseAck();
  f.advance(3600000);
  await f.worker().tick();
  expect((await f.service.deliveries(f.editor)).items[0].status).toBe("retry");
  f.advance(1000);
  await f.worker().tick();
  expect(f.tls!.emails()).toBe(1);
  expect(f.tls!.payloads).toHaveLength(2);
  expect(f.tls!.payloads[0].deliveryId).toBe(f.tls!.payloads[1].deliveryId);
  expect((await f.service.deliveries(f.editor)).items[0].status).toBe(
    "delivered",
  );
});
it("unconfigured relay is visible, never delivered or silently successful", async () => {
  const f = await setup(false);
  await event(f);
  f.advance(3600000);
  await f.worker().tick();
  expect((await f.service.deliveries(f.editor)).items[0].status).toBe(
    "unconfigured",
  );
});
it("preference CAS invalidates old previews/outbox and opt-out does not touch instant notifications", async () => {
  const f = await setup();
  await event(f);
  const preview = await f.service.previewDigest(f.editor, "daily");
  await f.service.preferences(f.editor, {
    expectedRevision: 1,
    dailyDigest: false,
    timezone: "Asia/Seoul",
  });
  await expect(
    f.service.confirmPreview(f.editor, preview.previewHash),
  ).rejects.toThrow("STALE_VERSION");
  await expect(
    f.service.preferences(f.editor, {
      expectedRevision: 1,
      weeklyDigest: true,
    }),
  ).rejects.toThrow("STALE_VERSION");
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.requests()).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT read_at FROM workflow_notifications WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].read_at,
  ).toBeNull();
});
it("DST gap/fold and overnight quiet hours use real wall minutes", () => {
  const p = {
    ...defaults,
    timezone: "America/New_York",
    dailyAt: "02:30",
    quietHours: { enabled: true, start: "22:00", end: "02:30" },
  };
  expect(
    afterQuietHours(p, new Date("2026-03-08T06:30:00Z")).toISOString(),
  ).toBe("2026-03-08T07:00:00.000Z");
  expect(
    nextDigest(
      { ...p, quietHours: { ...p.quietHours, enabled: false } },
      "daily",
      new Date("2026-03-08T00:00:00Z"),
    ).toISOString(),
  ).toBe("2026-03-09T06:30:00.000Z");
  expect(
    nextDigest(
      {
        ...p,
        dailyAt: "01:30",
        quietHours: { ...p.quietHours, enabled: false },
      },
      "daily",
      new Date("2026-11-01T05:30:00Z"),
    ).toISOString(),
  ).toBe("2026-11-02T06:30:00.000Z");
});
it("weekly schedule is separate from daily and all message URLs stay on configured app", async () => {
  const f = await setup();
  await f.service.preferences(f.editor, {
    expectedRevision: 1,
    dailyDigest: false,
    weeklyDigest: true,
    weeklyDay: 5,
    weeklyAt: "09:00",
  });
  await event(f);
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.payloads[0].cadence).toBe("weekly");
  expect(new URL(f.tls!.payloads[0].items[0].url).origin).toBe(
    "https://knowledge.example.test",
  );
});
it("gateway requires verified TLS/allowlist and never follows redirects", async () => {
  const f = await setup();
  expect(() =>
    createDigestGateway({ url: f.tls!.url, allowedOrigins: [] }),
  ).toThrow("GATEWAY_NOT_APPROVED");
  await event(f);
  f.tls!.redirect();
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.requests()).toBe(1);
  expect((await f.service.deliveries(f.editor)).items[0].status).not.toBe(
    "delivered",
  );
});
it("overdue review work uses explicit active backup and never marks a claim false", async () => {
  const f = await setup();
  await f.service.configureReviewCadence(f.ctx, {
    documentType: "기술 설계",
    expectedRevision: 0,
    days: 30,
  });
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"lastReviewedAt\":\"2026-01-01T00:00:00Z\"}')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'reader','editor')",
    [f.workspaceId],
  );
  await f.pool.query(
    "UPDATE access_team_members SET active=false WHERE principal_id='reader' AND team_id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
    [f.workspaceId],
  );
  await f.service.scanReviews();
  const rows = await f.service.reviewInbox(f.editor);
  expect(rows.items).toHaveLength(1);
  expect(rows.items[0].status).toBe("needs-review");
  expect(rows.items[0].assignedId).toBe("editor");
  expect(rows.items[0].reason).toBe("OWNER_UNAVAILABLE_BACKUP");
  await f.service.scanReviews();
  expect((await f.service.reviewInbox(f.editor)).items).toHaveLength(1);
});
it("unknown review baseline produces needs-assignment, not fabricated overdue or false evidence", async () => {
  const f = await setup();
  await f.service.configureReviewCadence(f.ctx, {
    documentType: "*",
    expectedRevision: 0,
    days: 30,
  });
  await f.service.scanReviews();
  const inbox = await f.service.reviewInbox(f.ctx, { all: true });
  expect(inbox.items[0].status).toBe("needs-assignment");
  expect(inbox.items[0].dueAt).toBeNull();
  expect(inbox.items[0].reason).toBe("REVIEW_BASELINE_UNKNOWN");
});
it("restart/reclaim fences an expired worker and commits one delivery receipt", async () => {
  const f = await setup();
  await event(f);
  f.advance(3600000);
  await f.service.syncPlans();
  await f.service.planDigests();
  const old = (await f.service.claim("old-process"))!;
  f.advance(1001);
  const current = (await f.service.claim("replacement-process"))!;
  expect(current.id).toBe(old.id);
  expect(current.fence).toBeGreaterThan(old.fence);
  await expect(f.service.heartbeat(old)).rejects.toThrow("LEASE_LOST");
  await f.service.runDigest(old, new AbortController().signal);
  expect(f.tls!.requests()).toBe(0);
  const restarted = new CollaborationService(f.pool, f.hooks, {
    clock: f.service.clock,
    applicationOrigin: "https://knowledge.example.test",
    gateway: f.tls!.gateway,
    leaseMs: 1000,
    maxAttempts: 3,
  });
  await restarted.runDigest(current, new AbortController().signal);
  expect(f.tls!.emails()).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM collaboration_delivery_receipts WHERE delivery_id=$1",
        [old.id],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("fresh directory denial before final send never produces a message or delivered status", async () => {
  const f = await setup();
  await event(f);
  f.onProof(async () => {
    if (f.proofCalls() === 2) f.disable();
  });
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.requests()).toBe(0);
  expect((await f.service.deliveries(f.editor)).items[0].status).toBe("retry");
});
it("quiet-hours defer the configured cycle and opt-outs exclude subscription notifications", async () => {
  const f = await setup();
  await f.service.preferences(f.editor, {
    expectedRevision: 1,
    quietHours: { enabled: true, start: "08:00", end: "10:00" },
  });
  await event(f);
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.requests()).toBe(0);
  f.advance(3600000);
  await f.worker().tick();
  expect(f.tls!.emails()).toBe(1);
  const f2 = await setup();
  await f2.service.preferences(f2.editor, {
    expectedRevision: 1,
    subscriptions: false,
  });
  await event(f2);
  f2.advance(3600000);
  await f2.worker().tick();
  expect(f2.tls!.requests()).toBe(0);
});
it("digest generation cannot send to a caller-supplied address or act without dispatcher authority", async () => {
  const f = await setup();
  await expect(
    f.service.preferences(f.editor, {
      expectedRevision: 1,
      address: "external@evil.invalid",
    }),
  ).rejects.toThrow();
  const denied = new CollaborationService(
    f.pool,
    {
      ...f.hooks,
      assertDispatcher: async () => {
        throw Error("DISPATCHER_NOT_AUTHORIZED");
      },
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  await expect(denied.syncPlans()).rejects.toThrow("DISPATCHER_NOT_AUTHORIZED");
  expect(f.tls!.requests()).toBe(0);
});
it("revoked historical source ancestry is not revealed in preview or review inbox metadata", async () => {
  const f = await setup();
  await event(f);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  const preview = await f.service.previewDigest(f.editor, "daily");
  expect(preview.items).toEqual([]);
  expect(JSON.stringify(preview)).not.toContain("주제");
  expect((await f.service.notifications(f.editor)).items).toEqual([]);
});
it("future-effective pages do not become current overdue recommendation work", async () => {
  const f = await setup();
  await f.service.configureReviewCadence(f.ctx, {
    documentType: "*",
    expectedRevision: 0,
    days: 1,
  });
  await f.pool.query(
    'INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,\'topic\',\'{"effectiveFrom":"2099-01-01T00:00:00Z","reviewDue":"2020-01-01T00:00:00Z"}\')',
    [f.workspaceId],
  );
  await f.service.scanReviews();
  expect((await f.service.reviewInbox(f.ctx, { all: true })).items).toEqual([]);
});
it("review responsibility is not namespace ownership and acknowledging work creates no verification", async () => {
  const f = await setup();
  await f.service.configureReviewCadence(f.ctx, {
    documentType: "*",
    expectedRevision: 0,
    days: 1,
  });
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"reviewDue\":\"2020-01-01T00:00:00Z\"}')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO governance_business_owners VALUES($1,'topic',1,'editor','reader',clock_timestamp())",
    [f.workspaceId],
  );
  await f.service.scanReviews();
  const work = (await f.service.reviewInbox(f.editor)).items[0];
  expect(
    (await f.service.acknowledgeReview(f.editor, work.id, work.revision))
      .verificationCreated,
  ).toBe(false);
  await expect(
    f.service.acknowledgeReview(f.editor, work.id, work.revision),
  ).rejects.toThrow("STALE_VERSION");
  expect(
    (
      await f.pool.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2",
        [f.workspaceId, "topic"],
      )
    ).rows[0].data.verifiedAt,
  ).toBeUndefined();
});
