import type { Claim } from "./logic";
/** Anonymous structural test fixture, never loaded by the production service. */
export const claim: Claim = {
  id: "c1",
  pageId: "topic",
  pageVersion: 1,
  key: "retry",
  value: "yes",
  conditions: { os: "linux", version: "1" },
  exceptions: ["네트워크 단절 제외"],
  assertedAt: "2026-02-01T00:00:00Z",
  validFrom: "2026-01-01T00:00:00Z",
  validTo: "2026-06-01T00:00:00Z",
  verifiedAt: null,
  evidenceIds: ["e1"],
  kind: "claim",
  protected: false,
  uncertainty: "단일 사례",
  supersedes: [],
  recordedAt: "2026-02-01T00:00:00Z",
  recordedBy: "editor",
};
