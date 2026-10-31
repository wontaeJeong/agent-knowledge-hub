import { afterEach, expect, test } from "vitest";
import { createServer } from "node:http";
import { fixture, adoptFixture, source } from "../test-support";
import { transaction } from "../database";
import {
  assertModelTransmission,
  prepareTransmission,
  registerTrustedDestinations,
  setSourcePolicy,
  sourcePolicyHash,
  type TransmissionInput,
} from "./model";
import {
  assertFeature,
  featureForRoute,
  featureForMcpOperation,
  featureForJobOperation,
  setFeature,
} from "./features";
import { handlePolicyRequest } from "./http";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function setup() {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  await adoptFixture(f.pool, f.workspaceId);
  const auth = { revalidate: async () => {}, assertSession: async () => {} };
  const ctx = { ...f.ctx, principalId: "fixture-owner", authorization: auth };
  // Explicit local fixture authorization. Raw readability does not grant model transmission.
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source',$2,'fixture-owner')",
    [f.workspaceId, source.id],
  );
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'page','topic','fixture-owner')",
    [f.workspaceId],
  );
  const server = createServer((_req, res) => {
    received++;
    res.end("{}");
  });
  let received = 0;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(
    () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  );
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/model`;
  await registerTrustedDestinations(f.pool, [
    {
      id: "local-fixture",
      url: endpoint,
      purposes: ["query", "ingest", "execution-verification"],
      classifications: ["fixture-public"],
      active: true,
    },
  ]);
  const input = {
    destinationId: "local-fixture",
    purpose: "query" as const,
    pageIds: ["topic"],
    sourceIds: [],
  };
  const tx = <T>(op: Parameters<typeof transaction<T>>[2]) =>
    transaction(f.pool, f.workspaceId, op);
  const grant = async (
    classification = "fixture-public",
    expectedRevision = 0,
  ) => {
    const d = (
      await f.pool.query(
        "SELECT fingerprint FROM model_destinations WHERE id='local-fixture'",
      )
    ).rows[0];
    return tx((db) =>
      setSourcePolicy(db, ctx, {
        sourceId: source.id,
        classification,
        expectedRevision,
        grants: [
          {
            destinationId: input.destinationId,
            purpose: input.purpose,
            fingerprint: d.fingerprint,
          },
        ],
        impactAcknowledged: true,
      }),
    );
  };
  const producer = async (requested: TransmissionInput = input) => {
    const recheck = await prepareTransmission(f.pool, ctx, requested, endpoint);
    await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ quote: source.content }),
    });
    await tx((db) => recheck(db));
  };
  return {
    ...f,
    ctx,
    tx,
    grant,
    input,
    producer,
    endpoint,
    received: () => received,
    server,
  };
}
test("actual producer sends zero HTTP requests for absent explicit source authorization; then one after local authorization", async () => {
  const f = await setup();
  await expect(f.producer()).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  expect(f.received()).toBe(0);
  await f.grant();
  await f.producer();
  expect(f.received()).toBe(1);
});
test("classification unsupported by trusted destination is not grantable by space admin", async () => {
  const f = await setup();
  await expect(f.grant("unknown")).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  await expect(f.producer()).rejects.toThrow();
  expect(f.received()).toBe(0);
});
test("provider address change and change-back invalidate exact policy bindings", async () => {
  const f = await setup();
  await f.grant();
  for (const url of [f.endpoint + "-changed", f.endpoint])
    await registerTrustedDestinations(f.pool, [
      {
        id: "local-fixture",
        url,
        purposes: ["query", "ingest", "execution-verification"],
        classifications: ["fixture-public"],
        active: true,
      },
    ]);
  await expect(f.producer()).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  expect(f.received()).toBe(0);
});
test("URL supplied outside destination registry cannot receive requests", async () => {
  const f = await setup();
  await f.grant();
  await expect(
    prepareTransmission(f.pool, f.ctx, f.input, f.endpoint + "-other"),
  ).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  expect(f.received()).toBe(0);
});
test("full historical ancestry cannot be laundered through a new page or changed citations", async () => {
  const f = await setup();
  await f.grant();
  await f.pool.query("INSERT INTO resources VALUES($1,'source','forbidden')", [
    f.workspaceId,
  ]);
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','forbidden','fixture-owner')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,'forbidden',$2)",
    [f.workspaceId, { ...source, id: "forbidden" }],
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{provenance}',$2::jsonb) WHERE workspace_id=$1",
    [f.workspaceId, JSON.stringify({ sourceIds: ["forbidden"], pageIds: [] })],
  );
  await expect(f.producer()).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  expect(f.received()).toBe(0);
});
test("disabled feature blocks exact REST MCP and scheduled producer call sites; admin can re-enable", async () => {
  const f = await setup();
  await f.grant();
  await f.tx((db) => setFeature(db, f.ctx, "query", false, 0));
  for (const feature of [
    featureForRoute("POST", "/api/v1/query"),
    featureForMcpOperation("knowledge_query"),
    featureForJobOperation("query"),
  ]) {
    expect(feature).toBe("query");
    await expect(
      f.tx((db) => assertFeature(db, f.ctx, feature!)).then(() => f.producer()),
    ).rejects.toThrow("FEATURE_DISABLED");
  }
  expect(f.received()).toBe(0);
  await f.tx((db) => setFeature(db, f.ctx, "query", true, 1));
  await f.producer();
  expect(f.received()).toBe(1);
});
test("mandatory authorizer, current source ACL, stale CAS, unknown features and token administration fail closed", async () => {
  const f = await setup();
  await f.grant();
  await expect(
    f.tx((db) =>
      assertModelTransmission(
        db,
        { workspaceId: f.workspaceId, principalId: f.ctx.principalId },
        f.input,
      ),
    ),
  ).rejects.toThrow("UNAUTHENTICATED");
  await expect(f.grant("fixture-public", 0)).rejects.toThrow("STALE_VERSION");
  await expect(
    f.tx((db) => assertFeature(db, f.ctx, "invented")),
  ).rejects.toThrow("FEATURE_DISABLED");
  await expect(
    f.tx((db) =>
      setFeature(
        db,
        { ...f.ctx, credentialId: "untrusted" },
        "query",
        false,
        0,
      ),
    ),
  ).rejects.toThrow("FORBIDDEN");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id=$3",
    [f.workspaceId, source.id, f.ctx.principalId],
  );
  await expect(f.producer()).rejects.toThrow();
  expect(f.received()).toBe(0);
});
test("before-write recheck rejects changed policies and queue epoch includes source grants", async () => {
  const f = await setup();
  await f.grant();
  const epoch = await f.tx((db) => sourcePolicyHash(db, f.ctx, f.input));
  const recheck = await prepareTransmission(f.pool, f.ctx, f.input, f.endpoint);
  await f.tx((db) =>
    setSourcePolicy(db, f.ctx, {
      sourceId: source.id,
      classification: "fixture-public",
      expectedRevision: 1,
      grants: [],
      impactAcknowledged: true,
    }),
  );
  expect(await f.tx((db) => sourcePolicyHash(db, f.ctx, f.input))).not.toBe(
    epoch,
  );
  await expect(f.tx((db) => recheck(db))).rejects.toThrow(
    "MODEL_TRANSMISSION_DENIED",
  );
});
test("more than 200 inputs reject instead of truncating", async () => {
  const f = await setup();
  await f.grant();
  await expect(
    f.tx((db) =>
      assertModelTransmission(db, f.ctx, {
        ...f.input,
        pageIds: Array(200).fill("topic"),
        sourceIds: [source.id],
      }),
    ),
  ).rejects.toThrow("POLICY_RESOURCE_LIMIT");
  expect(f.received()).toBe(0);
});
test("actual HTTP adapter updates policy by CAS and guards the real request producer", async () => {
  const f = await setup();
  await f.grant();
  const handler = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk;
      const result = await handlePolicyRequest(
        f.pool,
        f.ctx,
        req.method!,
        req.url!,
        text ? JSON.parse(text) : {},
      );
      if (result) {
        res.writeHead(result.status);
        res.end(JSON.stringify(result.body));
        return;
      }
      if (req.url === "/api/v1/query") {
        await f.tx((db) =>
          assertFeature(db, f.ctx, featureForRoute(req.method!, req.url!)!),
        );
        await f.producer();
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end();
    } catch {
      res.writeHead(403);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => handler.listen(0, "127.0.0.1", r));
  cleanup.push(
    () => new Promise<void>((r, j) => handler.close((e) => (e ? j(e) : r()))),
  );
  const base = `http://127.0.0.1:${(handler.address() as { port: number }).port}`;
  const put = (path: string, value: unknown) =>
    fetch(base + path, { method: "PUT", body: JSON.stringify(value) });
  expect(
    (
      await put("/api/v1/policy/features/query", {
        enabled: false,
        expectedRevision: 0,
      })
    ).status,
  ).toBe(200);
  expect((await fetch(base + "/api/v1/query", { method: "POST" })).status).toBe(
    403,
  );
  expect(f.received()).toBe(0);
  expect(
    (
      await put("/api/v1/policy/features/query", {
        enabled: true,
        expectedRevision: 0,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await put("/api/v1/policy/sources/source-a", {
        expectedRevision: 1,
        classification: "fixture-public",
        grants: [],
        impactAcknowledged: true,
        principalId: "fixture-owner",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await put("/api/v1/policy/features/query", {
        enabled: true,
        expectedRevision: 1,
      })
    ).status,
  ).toBe(200);
  expect((await fetch(base + "/api/v1/query", { method: "POST" })).status).toBe(
    200,
  );
  expect(f.received()).toBe(1);
});
test("site disable overrides resource grants and malformed site config fails closed", async () => {
  const f = await setup();
  await f.grant();
  const previous = process.env.AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS;
  try {
    process.env.AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS = '{"models":false}';
    await expect(f.producer()).rejects.toThrow("FEATURE_DISABLED");
    await expect(
      f.tx((db) => setFeature(db, f.ctx, "models", true, 0)),
    ).rejects.toThrow("FEATURE_DISABLED");
    process.env.AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS = '{"unknown":true}';
    await expect(f.producer()).rejects.toThrow("POLICY_CONFIGURATION");
    process.env.AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS = '{"company":true}';
    await expect(f.producer()).rejects.toThrow("POLICY_CONFIGURATION");
    expect(f.received()).toBe(0);
  } finally {
    if (previous === undefined)
      delete process.env.AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS;
    else process.env.AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS = previous;
  }
});
test("purpose-specific approval cannot authorize conversion embedding or execution verification", async () => {
  const f = await setup();
  await f.grant();
  for (const purpose of [
    "embedding",
    "conversion",
    "execution-verification",
  ] as const)
    await expect(f.producer({ ...f.input, purpose })).rejects.toThrow(
      "MODEL_TRANSMISSION_DENIED",
    );
  expect(f.received()).toBe(0);
});
test("depth limit rejects rather than silently dropping distant forbidden lineage", async () => {
  const f = await setup();
  await f.grant();
  for (let n = 0; n < 34; n++) {
    const id = "depth-" + n;
    await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
      f.workspaceId,
      id,
    ]);
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page',$2,'fixture-owner')",
      [f.workspaceId, id],
    );
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
      [f.workspaceId, id, { id, links: [] }],
    );
    await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
      f.workspaceId,
      id,
      {
        sourceIds: [source.id],
        provenance: {
          pageIds: n < 33 ? ["depth-" + (n + 1)] : [],
          sourceIds: [],
        },
      },
    ]);
  }
  await expect(
    f.tx((db) =>
      assertModelTransmission(db, f.ctx, { ...f.input, pageIds: ["depth-0"] }),
    ),
  ).rejects.toThrow("POLICY_RESOURCE_LIMIT");
  expect(f.received()).toBe(0);
});
test("policy mutation events are immutable, revisioned and transactionally rolled back with the policy", async () => {
  const f = await setup();
  await f.grant();
  const before = (
    await f.pool.query(
      "SELECT count(*) AS n FROM policy_events WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows[0].n;
  await expect(
    f.tx(async (db) => {
      await setFeature(db, f.ctx, "query", false, 0);
      throw Error("fixture rollback");
    }),
  ).rejects.toThrow("fixture rollback");
  expect(
    (
      await f.pool.query(
        "SELECT count(*) AS n FROM policy_events WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(before);
  expect(
    (
      await f.pool.query(
        "SELECT * FROM feature_policies WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    f.pool.query("UPDATE policy_events SET data='{}' WHERE workspace_id=$1", [
      f.workspaceId,
    ]),
  ).rejects.toThrow("immutable");
  await f.producer();
  expect(f.received()).toBe(1);
});
