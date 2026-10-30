import { expect, test } from "vitest";
import { fixture } from "../test-support";
import {
  AccessService,
  authorizeAction,
  bootstrapAccess,
  type SpaceRole,
} from "./index";
import { usageSummary } from "../usage";

test("five-role action matrix never bypasses complete source ACLs; Maintain is not aggregate usage Admin", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Matrix" },
          owners: [{ principalId: "editor" }],
          grants: [{ principalId: "reader", role: "read" }],
          reviewers: [],
        },
      ],
    });
    const a = new AccessService(f.pool);
    for (const [role, allowed, denied] of [
      ["read", "knowledge.read", "queue.triage"],
      ["triage", "queue.triage", "source.create"],
      ["write", "source.create", "changeset.approve"],
      ["maintain", "changeset.approve", "space.admin"],
      ["admin", "space.admin", null],
    ] as const) {
      await a.setGrant(f.editor, {
        principalId: "reader",
        role: role as SpaceRole,
        expectedVersion: (await a.effective(f.editor)).space.policyVersion,
      });
      await authorizeAction(f.pool, f.reader, allowed);
      if (denied)
        await expect(authorizeAction(f.pool, f.reader, denied)).rejects.toThrow(
          "FORBIDDEN",
        );
      expect((await usageSummary(f.pool, f.reader, 7)).scope).toBe(
        role === "admin" ? "workspace" : "self",
      );
    }
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
      [f.workspaceId],
    );
    await expect(
      authorizeAction(f.pool, f.reader, "knowledge.read", {
        kind: "page",
        id: "topic",
      }),
    ).rejects.toThrow("NOT_FOUND");
  } finally {
    await f.pool.end();
  }
});
