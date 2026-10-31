import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Overview } from "./Overview";
import { ConsoleShell } from "./ConsoleShell";

test("dashboard does not invent usage, lint health or agent effectiveness", () => {
  const html = renderToStaticMarkup(
    <Overview
      summary={{
        pages: 0,
        sources: 0,
        pending: 0,
        approved: 0,
        failedJobs: 0,
        runningJobs: 0,
        issues: null,
      }}
      usage={null}
      usageError="연결 실패"
      model={{ configured: false, model: null }}
      navigate={() => {}}
      retry={() => {}}
      preview={false}
    />,
  );
  expect(html).toContain("미점검");
  expect(html).toContain("연결 실패");
  expect(html).toContain("미평가");
  expect(html).not.toContain("100%");
});
test("preview shell cannot be mistaken for a live authenticated session", () => {
  const html = renderToStaticMarkup(
    <ConsoleShell preview tab="overview" navigate={() => {}} account={null}>
      <p>content</p>
    </ConsoleShell>,
  );
  expect(html).toContain("실제 서버에 연결하지 않습니다");
  expect(html).toContain("합성 UI 목업");
  expect(html).toContain('aria-current="page"');
  expect(html).toContain("#op-main");
  expect(html).not.toContain("SSO 로그인");
});
