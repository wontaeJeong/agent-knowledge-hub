import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicationSchedule } from "./scheduled-publication";
import { OperationalApi } from "./api";
test("human scheduling requires a preview before consent and exposes session-bound limits", () => {
  const html = renderToStaticMarkup(
    <PublicationSchedule
      api={new OperationalApi()}
      batchId="b"
      hash={"a".repeat(64)}
      canSchedule
    />,
  );
  expect(html).toContain("발행 예약");
  expect(html).toContain("현재 세션");
  expect(html).toContain("datetime-local");
  expect(html).toContain("예약 미리보기");
  expect(html).not.toContain("예약 확정");
});
test("unapproved or no-longer-qualified users can inspect and cancel accepted schedules without creation form", () => {
  const html = renderToStaticMarkup(
    <PublicationSchedule
      api={new OperationalApi()}
      batchId="b"
      hash={"a".repeat(64)}
      canSchedule={false}
    />,
  );
  expect(html).toContain("발행 예약");
  expect(html).not.toContain("datetime-local");
});
