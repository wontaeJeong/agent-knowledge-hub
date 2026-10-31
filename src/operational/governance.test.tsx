import { test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GovernanceWorkbench,
  governanceFailure,
  governancePage,
} from "./governance";
test("governance renders truthful loading state and responsibility is not permission", () => {
  const html = renderToStaticMarkup(
    <GovernanceWorkbench
      api={async <T,>() => ({}) as T}
      capabilities={["space.admin"]}
      onExpired={() => {}}
      onChanged={() => {}}
    />,
  );
  expect(html).toContain("불러오는 중");
  expect(html).toContain("업무 담당자 지정은 접근 권한을 부여하지 않습니다");
  expect(html).not.toContain("저장했습니다");
  expect(html).not.toContain("표시할 작업이 없습니다");
});
test("non-administrator does not receive owner or access approval controls", () => {
  const html = renderToStaticMarkup(
    <GovernanceWorkbench
      api={async <T,>() => ({}) as T}
      capabilities={["knowledge.read"]}
      onExpired={() => {}}
      onChanged={() => {}}
    />,
  );
  expect(html).not.toContain("업무 담당자 저장");
  expect(html).not.toMatch(/<button[^>]*>접근 승인<\/button>/);
});
test("paging preserves all original rows and conflicts/expiry are not successes", () => {
  const rows = Array.from({ length: 61 }, (_, i) => i);
  expect(governancePage(rows, 0)).toEqual(rows.slice(0, 25));
  expect(governancePage(rows, 2)).toEqual(rows.slice(50));
  expect(governanceFailure(Error("STALE_VERSION"))).toContain("다시 불러");
  expect(governanceFailure(Error("UNAUTHENTICATED"))).toContain("만료");
  expect(governanceFailure(Error("PROPERTY_REQUIRED"))).toContain("필수 속성");
});
