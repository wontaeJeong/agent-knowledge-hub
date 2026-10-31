import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IdentityManager, identityApiAdapter } from "./identity";
const api = async <T,>() => ({}) as T;
test("account controls expose no client principal, approver, credential or proof fields", () => {
  const html = renderToStaticMarkup(
    <IdentityManager
      api={api}
      onExpired={() => {}}
      emergencyEnabled
      directoryEnabled
      pageOptions={[{ id: "topic", title: "사고 대응 문서" }]}
    />,
  );
  expect(html).toContain("내 모든 세션 종료");
  expect(html).toContain("독립 승인 요청");
  expect(html).toContain("최대 30분");
  expect(html).toContain("제품에서 수동 철회");
  expect(html).not.toMatch(
    /name="(?:principal|approver|operator|token|csrf|groups)"|<pre|<table/,
  );
  expect(html).toContain('minLength="10"');
  expect(html).toContain('max="30"');
  expect(html).toContain('disabled=""');
});
test("unconfigured emergency/directory features are not pretended to be available", () => {
  const html = renderToStaticMarkup(
    <IdentityManager api={api} onExpired={() => {}} />,
  );
  expect(html).not.toContain("독립 승인 요청");
  expect(html).not.toContain("연결 승인");
  expect(html).toContain("세션 목록을 확인 중");
  expect(html).not.toContain("활성 세션 0");
});
test("native OperationalApi adapter is stable, strips exactly one API prefix and preserves mutation body", async () => {
  const calls: unknown[] = [];
  const native = {
    request: async <T,>(...args: unknown[]) => {
      calls.push(args);
      return { ok: true } as T;
    },
  };
  const adapter = identityApiAdapter(native);
  expect(identityApiAdapter(native)).toBe(adapter);
  await adapter("/api/v1/identity/sessions?offset=25");
  await adapter("/api/v1/identity/logout-all", { method: "POST", body: {} });
  expect(calls).toEqual([
    ["/identity/sessions?offset=25", "GET", undefined],
    ["/identity/logout-all", "POST", {}],
  ]);
});
