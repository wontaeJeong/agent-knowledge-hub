import { expect, test } from "vitest";
import { fixture } from "../test-support";
import { AccessService, bootstrapAccess, syncIdentity } from "./index";

test("bootstrap cannot turn a service into a human Owner and verified identity binding cannot be replaced or reactivated", async () => {
  const f = await fixture(),
    other = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Identity" },
          owners: [{ principalId: "editor" }],
          grants: [],
          reviewers: [],
        },
      ],
    });
    const a = new AccessService(f.pool),
      s = await a.createServicePrincipal(f.editor, {
        name: "nonhuman",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    await expect(
      bootstrapAccess(f.pool, {
        spaces: [
          {
            workspaceId: other.workspaceId,
            team: { slug: other.workspaceId, name: "Bad" },
            owners: [{ principalId: s.id }],
            grants: [],
            reviewers: [],
          },
        ],
      }),
    ).rejects.toThrow("VALIDATION_FAILED");
    const id = "identity_" + f.workspaceId;
    const subject = "one_" + f.workspaceId;
    await syncIdentity(f.pool, {
      issuer: "https://a.invalid",
      subject,
      principalId: id,
    });
    await expect(
      syncIdentity(f.pool, {
        issuer: "https://b.invalid",
        subject: "two_" + f.workspaceId,
        principalId: id,
      }),
    ).rejects.toThrow("UNAUTHENTICATED");
    await f.pool.query(
      "UPDATE access_principals SET active=false WHERE id=$1",
      [id],
    );
    await expect(
      syncIdentity(f.pool, {
        issuer: "https://a.invalid",
        subject,
        principalId: id,
      }),
    ).rejects.toThrow("UNAUTHENTICATED");
  } finally {
    await f.pool.end();
    await other.pool.end();
  }
});
