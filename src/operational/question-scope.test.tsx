// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import {
  QuestionScopeFields,
  type QuestionScopeValue,
  serializeQuestionScope,
} from "./question-scope";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
test("topic and historical publication date range are serialized without current-mode stale dates", async () => {
  const host = document.createElement("div"),
    root = createRoot(host);
  let value: QuestionScopeValue = {
    topic: "기술 설계",
    historical: true,
    from: "2026-10-29",
    to: "2026-11-01",
  };
  await act(async () =>
    root.render(
      <QuestionScopeFields
        value={value}
        topics={["기술 설계"]}
        onChange={(next) => (value = next)}
      />,
    ),
  );
  expect(host.textContent).toContain("발행 기록 기간");
  expect(serializeQuestionScope(value)).toEqual({
    topic: "기술 설계",
    historical: true,
    periodFrom: "2026-10-29T00:00:00.000Z",
    periodTo: "2026-11-01T23:59:59.999Z",
  });
  expect(serializeQuestionScope({ ...value, historical: false })).toEqual({
    topic: "기술 설계",
    historical: false,
  });
  await act(async () => root.unmount());
});
