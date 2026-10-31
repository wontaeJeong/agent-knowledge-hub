import { test, expect, afterAll } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fixture, adoptFixture, source, page } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import {
  OperationsService,
  openExport,
  verifyAudit,
  sealExport,
} from "./service";
import { operationsAuthorizer } from "./authorization";
import { archiveAudit } from "./archive";
import {
  exportAuditAnchor,
  prepareAuditAnchor,
  commitAuditAnchor,
  decodeAuditAnchor,
  withAuditHeadStoreFence,
} from "./audit-protocol";
const pools: Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const ctx = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    service = new OperationsService(
      f.pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport: true,
      }),
    );
  const root = await mkdtemp(
      join(
        await import("node:fs/promises").then((m) => m.realpath(tmpdir())),
        "akh-audit-head-",
      ),
    ),
    key = "audit-encryption".repeat(5),
    signingKey = "independent-audit-signing".repeat(4),
    objects = new Map<string, string>();
  let failTarget = false;
  const target = {
    put: async (name: string, body: string) => {
      if (failTarget) throw Error("TARGET_DOWN");
      await writeFile(join(root, name), body, { mode: 0o600, flag: "wx" });
      objects.set(name, body);
    },
    get: async (name: string) => readFile(join(root, name), "utf8"),
    list: async () => [...objects.keys()].map((name) => ({ name })),
  };
  const readAnchor = async (_workspaceId: string) => {
      try {
        return await target.get(await readFile(join(root, "HEAD"), "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    anchor = async (
      name: string,
      body: string,
      fence?: <T>(work: () => Promise<T>) => Promise<T>,
    ) => {
      const write = async () => {
        const existing = await readAnchor(f.workspaceId),
          candidate = decodeAuditAnchor(body, key, signingKey, f.workspaceId);
        if (existing) {
          const current = decodeAuditAnchor(
            existing,
            key,
            signingKey,
            f.workspaceId,
          );
          if (
            BigInt(candidate.head.sequence) < BigInt(current.head.sequence) ||
            candidate.previousHead?.sequence !== current.head.sequence ||
            candidate.previousHead?.hash !== current.head.hash
          )
            throw Error("AUDIT_HEAD_CONFLICT");
        }
        await target.put(name, body);
        const tmp = join(root, ".HEAD-" + randomUUID());
        await writeFile(tmp, name, { mode: 0o600, flag: "wx" });
        const h = await open(tmp, "r");
        await h.sync();
        await h.close();
        await rename(tmp, join(root, "HEAD"));
        const d = await open(root, "r");
        await d.sync();
        await d.close();
      };
      return fence
        ? fence(write)
        : withAuditHeadStoreFence(f.pool, f.workspaceId, write);
    };
  return {
    ...f,
    ctx,
    service,
    config: { target, key, signingKey, readAnchor, anchor },
    objects,
    fail: () => {
      failTarget = true;
    },
  };
}
test("full anchor→archive/prune→append→export preserves authenticated checkpoint and prior full commitment", async () => {
  const f = await setup();
  await f.service.appendAudit(f.ctx, { operation: "test.before" });
  const legacy = sealExport(
    await f.service.auditRows(f.ctx),
    f.config.key,
    f.config.signingKey,
  );
  await f.config.anchor("legacy-full.akh-backup", legacy);
  const first = { encrypted: legacy },
    head = decodeAuditAnchor(
      first.encrypted,
      f.config.key,
      f.config.signingKey,
      f.workspaceId,
    ).head;
  await archiveAudit(f.service, f.ctx, {
    ...f.config,
    includeUnexpired: true,
    confirm: "ARCHIVE_ACTIVE_AUDIT",
  });
  await f.service.appendAudit(f.ctx, { operation: "test.after" });
  const next = await exportAuditAnchor(f.service, f.ctx, f.config),
    decoded = decodeAuditAnchor(
      next.encrypted,
      f.config.key,
      f.config.signingKey,
      f.workspaceId,
    );
  expect(decoded.checkpoint).toEqual(head);
  expect(BigInt(decoded.head.sequence)).toBe(BigInt(head.sequence) + 1n);
  expect(decoded.rows?.at(-1)?.event).toMatchObject({
    operation: "test.after",
  });
});
test("validly rewritten DB chain cannot be laundered by archiving; target failure never prunes hot/checkpoints", async () => {
  const f = await setup();
  await f.service.appendAudit(f.ctx, { operation: "test.original" });
  const old = await exportAuditAnchor(f.service, f.ctx, f.config),
    count = (await f.service.auditRows(f.ctx)).length;
  await f.pool.query(
    "DELETE FROM operations_audit_chain WHERE workspace_id=$1",
    [f.workspaceId],
  );
  for (let i = 0; i < count; i++)
    await f.service.appendAudit(f.ctx, { operation: "attacker.rewrite" });
  expect(verifyAudit(await f.service.auditRows(f.ctx))).toBe(true);
  await expect(
    archiveAudit(f.service, f.ctx, {
      ...f.config,
      includeUnexpired: true,
      confirm: "ARCHIVE_ACTIVE_AUDIT",
    }),
  ).rejects.toThrow(/AUDIT_ANCHOR/);
  expect(await f.config.readAnchor(f.workspaceId)).toBe(old.encrypted);
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM operations_audit_archives WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).toBe("0");
  await f.pool.query(
    "DELETE FROM operations_audit_chain WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    archiveAudit(f.service, f.ctx, {
      ...f.config,
      includeUnexpired: true,
      confirm: "ARCHIVE_ACTIVE_AUDIT",
    }),
  ).rejects.toThrow("AUDIT_ANCHOR_TRUNCATION");
  const safe = await setup();
  await safe.service.appendAudit(safe.ctx, { operation: "test.target" });
  const before = (await safe.service.auditRows(safe.ctx)).length;
  safe.fail();
  await expect(
    archiveAudit(safe.service, safe.ctx, {
      ...safe.config,
      includeUnexpired: true,
      confirm: "ARCHIVE_ACTIVE_AUDIT",
    }),
  ).rejects.toThrow("TARGET_DOWN");
  expect((await safe.service.auditRows(safe.ctx)).length).toBe(before);
});
test("newer head commits first; delayed stale candidate cannot roll the independent HEAD backward", async () => {
  const f = await setup();
  await f.service.appendAudit(f.ctx, { operation: "test.old" });
  const stale = await prepareAuditAnchor(f.service, f.ctx, f.config);
  await f.service.appendAudit(f.ctx, { operation: "test.new" });
  const newer = await exportAuditAnchor(f.service, f.ctx, f.config);
  await expect(
    commitAuditAnchor(f.service, f.ctx, stale.encrypted, f.config),
  ).rejects.toThrow("AUDIT_ANCHOR_STALE");
  expect(await f.config.readAnchor(f.workspaceId)).toBe(newer.encrypted);
});
test("raw page reader cannot export event IDs/count after historical source ACL or egress policy is revoked", async () => {
  const f = await setup();
  await f.pool.query("INSERT INTO resources VALUES($1,'source','historical')", [
    f.workspaceId,
  ]);
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, "historical", { ...source, id: "historical" }],
  );
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','historical','fixture-owner')",
    [f.workspaceId],
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{sourceIds}','[\"historical\"]') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,$2,2,$3)", [
    f.workspaceId,
    "topic",
    { ...page.versions[0], id: "v2", number: 2 },
  ]);
  for (const id of ["historical", "source-a"])
    await f.pool.query(
      "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,$2,false,true)",
      [f.workspaceId, id],
    );
  await f.service.appendAudit(f.ctx, {
    operation: "page.event",
    resource: { kind: "page", id: "topic" },
  });
  await exportAuditAnchor(f.service, f.ctx, f.config);
  const head = await f.config.readAnchor(f.workspaceId);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='historical' AND principal_id='fixture-owner'",
    [f.workspaceId],
  );
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='fixture-owner'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(1);
  await expect(exportAuditAnchor(f.service, f.ctx, f.config)).rejects.toThrow();
  await expect(
    archiveAudit(f.service, f.ctx, {
      ...f.config,
      includeUnexpired: true,
      confirm: "ARCHIVE_ACTIVE_AUDIT",
    }),
  ).rejects.toThrow();
  expect(await f.config.readAnchor(f.workspaceId)).toBe(head);
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','historical','fixture-owner')",
    [f.workspaceId],
  );
  await f.pool.query(
    "UPDATE access_source_policy SET export_allowed=false WHERE workspace_id=$1 AND source_id='historical'",
    [f.workspaceId],
  );
  await expect(exportAuditAnchor(f.service, f.ctx, f.config)).rejects.toThrow();
  expect(await f.config.readAnchor(f.workspaceId)).toBe(head);
});
