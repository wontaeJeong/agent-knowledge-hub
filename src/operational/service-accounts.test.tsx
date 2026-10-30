import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ServiceAccountsPanel,
  serviceCredentialInput,
} from "./service-accounts";
import { OperationalApi } from "./api";
test("service automation credentials never acquire publication or administrator actions", () => {
  expect(() =>
    serviceCredentialInput(
      ["knowledge.read", "changeset.publish"],
      "2099-01-01T00:00:00Z",
    ),
  ).toThrow();
  expect(
    serviceCredentialInput(
      ["knowledge.read", "lint.run"],
      "2099-01-01T00:00:00Z",
    ),
  ).toEqual({
    actions: ["knowledge.read", "lint.run"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
});
test("service identity management is absent without server-issued Admin capability", () => {
  expect(
    renderToStaticMarkup(
      <ServiceAccountsPanel
        api={new OperationalApi()}
        allowed={false}
        policyVersion={1}
        onChanged={async () => {}}
      />,
    ),
  ).toBe("");
  const html = renderToStaticMarkup(
    <ServiceAccountsPanel
      api={new OperationalApi()}
      allowed={true}
      policyVersion={1}
      onChanged={async () => {}}
    />,
  );
  expect(html).toContain("서비스 실행 주체");
  expect(html).toContain("책임 사용자");
  expect(html).toContain("승인·발행 권한을 위임하지 않습니다");
});
