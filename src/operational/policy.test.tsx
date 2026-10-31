import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PolicyManager, policyFailure } from "./policy";
test("policy UI never renders privileged controls for a reader", () => {
  const html = renderToStaticMarkup(
    <PolicyManager
      api={async <T,>() => ({}) as T}
      capabilities={["knowledge.read"]}
      sourceOptions={[]}
      onChanged={() => {}}
      onExpired={() => {}}
    />,
  );
  expect(html).toContain("인간 관리자");
  expect(html).not.toContain("<button");
});
test("policy UI bounds options and preserves explicit error/conflict/expired states", () => {
  const html = renderToStaticMarkup(
    <PolicyManager
      api={async <T,>() => ({}) as T}
      capabilities={["space.admin"]}
      sourceOptions={Array.from({ length: 201 }, (_, i) => ({
        id: String(i),
        title: String(i),
      }))}
      onChanged={() => {}}
      onExpired={() => {}}
    />,
  );
  expect(html).toContain("200건 이하");
  expect(html).not.toContain("<select");
  expect(policyFailure(Error("UNAUTHENTICATED"))).toBe("expired");
  expect(policyFailure(Error("STALE_VERSION"))).toBe("conflict");
  expect(policyFailure(Error("network"))).toBe("error");
});
