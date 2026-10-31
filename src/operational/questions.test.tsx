import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionsWorkbench, questionRequest } from "./questions";
import { OperationalApi } from "./api";
test("Korean questions UI distinguishes extracts, historical versions, pending work and unverified claims", () => {
  const html = renderToStaticMarkup(
    <QuestionsWorkbench
      api={new OperationalApi()}
      identityKey="space:reader"
    />,
  );
  expect(html).toContain("질문과 후속 대화");
  expect(html).toContain("발췌");
  expect(html).toContain("과거 버전");
  expect(html).toContain("현재 권고가 아닙니다");
  expect(html).toContain("독립 실행 증거");
  expect(html).toContain("담당자");
  expect(html).not.toContain("localStorage");
});
test("accepted turn retry preserves nonce and original CAS even after thread refresh", () => {
  const request = questionRequest(
    null,
    "thread",
    0,
    "question",
    "model",
    () => "nonce",
  );
  expect(
    questionRequest(request, "thread", 1, "question", "model", () => "other"),
  ).toEqual(request);
  expect(
    questionRequest(request, "thread", 1, "edited", "model", () => "other"),
  ).toMatchObject({ expectedRevision: 1, nonce: "other" });
});
