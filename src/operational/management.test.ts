import { expect, test } from "vitest";
import { createManagement, changeManagement } from "./management";
import { featureCoverage } from "./coverage";

test("mock invitations do not activate users or silently grant space roles", () => {
  const s = changeManagement(createManagement(), {
    type: "invite",
    name: "새 구성원",
    email: "new@example.test",
  });
  expect(s.people.at(-1)).toMatchObject({
    status: "초대 대기",
    role: "Read",
    path: "수락 전 권한 없음",
  });
  expect(() =>
    changeManagement(s, { type: "invite", name: "", email: "bad" }),
  ).toThrow();
  expect(() =>
    changeManagement(s, {
      type: "invite",
      name: "중복",
      email: "new@example.test",
    }),
  ).toThrow();
});
test("mock cannot disable last Owner or promote an inactive invite", () => {
  const s = createManagement();
  expect(() =>
    changeManagement(s, { type: "person", id: "owner", status: "중지" }),
  ).toThrow();
  const pending = changeManagement(s, {
    type: "invite",
    name: "대기자",
    email: "pending@example.test",
  });
  expect(() =>
    changeManagement(pending, {
      type: "role",
      id: pending.people.at(-1)!.id,
      role: "Admin",
    }),
  ).toThrow();
  expect(s.people[0].status).toBe("활성");
});

test("cancelled invitations cannot be laundered through suspension into activation", () => {
  const invited = changeManagement(createManagement(), {
    type: "invite",
    name: "미수락",
    email: "unaccepted@example.test",
  });
  const id = invited.people.at(-1)!.id;
  const cancelled = changeManagement(invited, {
    type: "person",
    id,
    status: "초대 취소",
  });
  expect(() =>
    changeManagement(cancelled, { type: "person", id, status: "중지" }),
  ).toThrow();
  expect(() =>
    changeManagement(cancelled, { type: "person", id, status: "활성" }),
  ).toThrow();
});
test("mock agent credentials exclude approval and require accountable expiry", () => {
  const s = createManagement();
  expect(() =>
    changeManagement(s, {
      type: "credential",
      name: "bad",
      owner: "",
      operations: ["batch.publish"],
      days: 30,
    }),
  ).toThrow();
  const next = changeManagement(s, {
    type: "credential",
    name: "reader",
    owner: "플랫폼팀",
    operations: ["knowledge.read"],
    days: 7,
  });
  expect(next.credentials.at(-1)).toMatchObject({
    status: "활성",
    operations: ["knowledge.read"],
    days: 7,
  });
  expect(JSON.stringify(next)).not.toContain("Bearer ");
});
test("mock personal space visibility and restricted export cannot be widened", () => {
  const s = createManagement();
  expect(() =>
    changeManagement(s, {
      type: "visibility",
      id: "personal",
      visibility: "Company",
    }),
  ).toThrow();
  expect(() =>
    changeManagement(s, { type: "export", id: "restricted" }),
  ).toThrow();
  const next = changeManagement(s, {
    type: "person",
    id: "writer",
    status: "중지",
  });
  expect(next.people.find((p) => p.id === "writer")?.status).toBe("중지");
  expect(next.events[0].detail).toContain("세션");
});
test("all baseline requirements have one navigable surface without claiming acceptance", () => {
  expect(featureCoverage).toHaveLength(251);
  expect(new Set(featureCoverage.map((r) => r.id)).size).toBe(251);
  for (const r of featureCoverage) {
    expect(r.surface).toBeTruthy();
    expect(r.acceptance).toBeTruthy();
    expect(r.status).toBe("미검증");
  }
  expect(featureCoverage.find((r) => r.id === "IAM-005")?.surface).toBe(
    "users",
  );
  expect(featureCoverage.find((r) => r.id === "CORE-012")?.surface).toBe(
    "evaluation",
  );
});
