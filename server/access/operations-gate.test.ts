import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../test-support";
import { AccessService, bootstrapAccess, recordAccessAudit } from "./index";

test("global access mutations hold the shared recovery gate and audit failure rolls both ledgers back", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Gate" },
          owners: [{ principalId: "editor" }],
          grants: [],
          reviewers: [],
        },
      ],
    });
    expect(
      (
        await f.pool.query(
          "SELECT event->>'operation' AS operation FROM operations_audit_chain WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows.map((r) => r.operation),
    ).toEqual(["access.bootstrap"]);
    const a = new AccessService(f.pool);
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r)),
      hold = new Promise<void>((r) => (release = r));
    const work = a.globalTransaction(f.editor, "test.gate", async () => {
      entered();
      await hold;
      return { ok: true };
    });
    await ready;
    const db = await f.pool.connect();
    try {
      await db.query("BEGIN");
      expect(
        (await db.query("SELECT pg_try_advisory_xact_lock(822025) AS acquired"))
          .rows[0].acquired,
      ).toBe(false);
      await db.query("ROLLBACK");
    } finally {
      db.release();
      release();
    }
    await work;
    const before = (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM operations_audit_chain WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n;
    await expect(
      a.globalTransaction(f.editor, "test.rollback", async (db) => {
        await recordAccessAudit(db, f.editor, "test.atomic", f.workspaceId);
        throw Error("AUDIT_ROLLBACK");
      }),
    ).rejects.toThrow("AUDIT_ROLLBACK");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM operations_audit_chain WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(before);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM access_audit WHERE workspace_id=$1 AND operation='test.atomic'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    release?.();
    await f.pool.end();
  }
});
test("personal creation from an unbound selected space audits the actual created resource without inventing workspace authority", async () => {
  const f = await fixture();
  try {
    await f.pool.query(
      "INSERT INTO access_principals(id) VALUES('editor') ON CONFLICT DO NOTHING",
    );
    const a = new AccessService(f.pool),
      missing = "missing_" + randomUUID();
    const space = await a.createSpace(
      { ...f.editor, workspaceId: missing },
      { slug: randomUUID() },
    );
    expect(space.owner).toBe(true);
    expect(
      (await f.pool.query("SELECT 1 FROM workspaces WHERE id=$1", [missing]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT workspace_id FROM access_audit WHERE target_id=$1 ORDER BY id DESC LIMIT 1",
          [space.id],
        )
      ).rows[0].workspace_id,
    ).toBe(space.id);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM operations_audit_chain WHERE workspace_id=$1",
          [missing],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.pool.end();
  }
});
