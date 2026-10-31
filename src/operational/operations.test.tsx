import { test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationalApi } from "./api";
import { OperationsPanel, erasureRequest, retentionBody, erasureAllowed } from "./operations";
test("unsupported or unknown credential data blocks erasure", () => {
  expect(erasureAllowed({legalHold:false,agentDataUnsupported:true})).toBe(false);
  expect(erasureAllowed({legalHold:false})).toBe(false);
  expect(erasureAllowed({legalHold:true,agentDataUnsupported:false})).toBe(false);
  expect(erasureAllowed({legalHold:false,agentDataUnsupported:false})).toBe(false);
  expect(erasureAllowed({legalHold:false,agentDataUnsupported:false,questionDataUnsupported:true})).toBe(false);
  expect(erasureAllowed({legalHold:false,agentDataUnsupported:false,questionDataUnsupported:false})).toBe(true);
});
test("operations panel stays Korean, scope explicit and browser never accepts backup paths/keys/SQL", () => {
  const html = renderToStaticMarkup(
    <OperationsPanel api={new OperationalApi()} canAdmin canOwner />,
  );
  expect(html).toContain("운영 및 복구");
  expect(html).toContain("25");
  expect(html).toContain("미확인");
  expect(html).not.toContain('type="password"');
  expect(erasureRequest("resource", "source", "s")).toEqual({
    scope: "resource",
    resource: { kind: "source", id: "s" },
  });
  expect(() => erasureRequest("workspace", "page", "p", false)).toThrow();
  expect(erasureRequest("workspace", "page", "", true)).toEqual({
    scope: "workspace",
  });
  expect(retentionBody(3, 365, 30, 14)).toEqual({
    expectedRevision: 3,
    auditDays: 365,
    telemetryDays: 30,
    backupDays: 14,
  });
  const denied = renderToStaticMarkup(
    <OperationsPanel api={new OperationalApi()} />,
  );
  expect(denied).toContain("관리자 권한");
  expect(denied).not.toContain("영구 삭제 실행");
});
