import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationPanel, deliveryStateLabel } from "./notifications";
import { OperationalApi } from "./api";
test("user digests are not operations alerts or evidence verification", () => {
  const html = renderToStaticMarkup(
    <NotificationPanel
      api={new OperationalApi()}
      capabilities={["knowledge.read"]}
    />,
  );
  expect(html).toContain("사용자 알림·요약");
  expect(html).toContain("검토 기한 경과는 거짓 판정이 아닙니다");
  expect(html).toContain("조용한 시간");
  expect(html).not.toContain("SMTP 비밀번호");
});
test("delivery states keep unknown/accepted/retry distinct from delivered", () => {
  expect(deliveryStateLabel("accepted")).toContain("전달 확인 전");
  expect(deliveryStateLabel("needs-reconciliation")).toContain("미확인");
  expect(deliveryStateLabel("unconfigured")).toContain("미설정");
  expect(deliveryStateLabel("delivered")).toBe("전달 확인");
});
