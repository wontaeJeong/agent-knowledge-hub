import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { sealExport } from "./service";
import { readCurrentPolicy } from "./current-policy";
const issuer = "https://idp.example.com",
  principalId = createHash("sha256")
    .update(issuer + "\0owner")
    .digest("hex"),
  reviewerId = createHash("sha256")
    .update(issuer + "\0reviewer")
    .digest("hex"),
  key = "encryption".repeat(5),
  signing = "independent-signing".repeat(4);
export function currentPolicyFixture() {
  return {
    version: 2,
    collectedAt: new Date().toISOString(),
    maxAgeMs: 900000,
    organization: {
      id: "org",
      active: true,
      members: [principalId, reviewerId],
    },
    source: { database: "fixture", systemIdentifier: "123" },
    target: {
      database: "akh_ops_restore_" + "a".repeat(32),
      systemIdentifier: "123",
    },
    backup: { id: "backup-1", databaseSha256: "b".repeat(64) },
    operators: [principalId],
    principals: [
      {
        principalId,
        issuer,
        subject: "owner",
        active: true,
        kind: "human",
        teamCreate: false,
      },
      {
        principalId: reviewerId,
        issuer,
        subject: "reviewer",
        active: true,
        kind: "human",
        teamCreate: false,
      },
    ],
    teams: [
      {
        id: "team",
        slug: "team",
        name: "Current team",
        members: [
          { principalId, role: "owner", active: true },
          { principalId: reviewerId, role: "member", active: true },
        ],
      },
    ],
    spaces: [
      {
        workspaceId: "space",
        namespaceId: "team",
        kind: "team",
        slug: "knowledge",
        visibility: "private",
        owners: [principalId],
        grants: [{ principalId: reviewerId, role: "maintain" }],
        reviewers: [
          {
            principalId: reviewerId,
            qualified: true,
            qualifiedAt: new Date().toISOString(),
          },
        ],
        minimumApprovals: 1,
        readers: [{ kind: "source", id: "s", principalIds: [principalId] }],
      },
    ],
  };
}
test("current signed authority binds source/target/backup and verified stable identities, not historical reviewer", () => {
  const p = currentPolicyFixture(),
    expected = { source: p.source, target: p.target, backup: p.backup };
  expect(
    readCurrentPolicy(sealExport(p, key, signing), key, signing, expected)
      .spaces[0].owners,
  ).toEqual([principalId]);
  for (const bad of [
    { ...p, collectedAt: "2020-01-01T00:00:00Z" },
    { ...p, backup: { ...p.backup, id: "wrong" } },
    {
      ...p,
      principals: [{ ...p.principals[0], subject: "unknown" }, p.principals[1]],
    },
    { ...p, spaces: [{ ...p.spaces[0], owners: [] }] },
    {
      ...p,
      spaces: [
        { ...p.spaces[0], grants: [{ principalId: "unknown", role: "admin" }] },
      ],
    },
  ])
    expect(() =>
      readCurrentPolicy(sealExport(bad, key, signing), key, signing, expected),
    ).toThrow();
  expect(() =>
    readCurrentPolicy(sealExport(p, key, signing), key, "wrong", expected),
  ).toThrow();
});
