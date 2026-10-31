import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowPanel, SourceLifecycle, draftInput } from "./workflows";
import { OperationalApi } from "./api";

test("resuming a draft retains its server CAS and original base, never the newer displayed version", () => {
  expect(
    draftInput(
      {
        id: "private-1",
        revision: 4,
        title: "초안",
        content: "내 변경",
        pageId: "topic",
        baseVersion: 2,
      },
      "최신 본문",
      9,
    ),
  ).toEqual({
    id: "private-1",
    expectedRevision: 4,
    title: "초안",
    content: "최신 본문",
    pageId: "topic",
    baseVersion: 2,
  });
});
test("saving a derived draft preserves origin page versions and source restrictions", () => {
  expect(
    draftInput(
      {
        id: "derived",
        revision: 2,
        title: "파생",
        content: "이전 입력",
        pageId: "target",
        baseVersion: 3,
        sourceIds: ["source-private"],
        dependencyVersions: { origin: 7 },
      },
      "다음 입력",
      8,
    ),
  ).toMatchObject({
    expectedRevision: 2,
    baseVersion: 3,
    sourceIds: ["source-private"],
    dependencyVersions: { origin: 7 },
  });
});
test("authoring entry explains private save and reviewed publication, with no publish action", () => {
  const html = renderToStaticMarkup(
    <WorkflowPanel
      api={new OperationalApi()}
      pages={[]}
      capabilities={["draft.write", "changeset.propose"]}
      onChanged={async () => {}}
      onExpired={() => {}}
    />,
  );
  expect(html).toContain("개인 초안");
  expect(html).toContain("승인 전에는 발행본이 바뀌지 않습니다");
  expect(html).not.toContain("즉시 발행");
  expect(html).toContain("문서 선택");
});
test("source correction keeps an explicit separate-original contract and requires management for withdrawal", () => {
  const html = renderToStaticMarkup(
    <SourceLifecycle
      api={new OperationalApi()}
      sourceId="source-a"
      canCorrect={true}
      canWithdraw={false}
      perform={async (fn) => {
        await fn();
      }}
    />,
  );
  expect(html).toContain("별도 원본으로 정정");
  expect(html).not.toContain("원본 철회 확인");
});
