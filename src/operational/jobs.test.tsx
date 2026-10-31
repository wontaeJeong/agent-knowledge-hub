import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JobsPanel, JobUsage, actualValue, scheduleRequest } from "./jobs";
import { OperationalApi } from "./api";
test("unknown actual usage is not rendered as zero", () => {
  expect(actualValue(null, "토큰")).toBe("미확인");
  expect(actualValue(0, "토큰")).toBe("0 토큰");
  const html = renderToStaticMarkup(
    <JobUsage
      items={[
        {
          call_id: "c1",
          provider: "provider",
          model: "model",
          input_tokens: null,
          output_tokens: 0,
          cost_micros: null,
          error_code: "MODEL_FAILED",
        },
      ]}
    />,
  );
  expect(html).toContain("미확인");
  expect(html).toContain("MODEL_FAILED");
  expect(html).toContain("실제 공급자");
});
test("manager UI keeps review and durable execution distinct and hides controls without capability", () => {
  const html = renderToStaticMarkup(
    <JobsPanel api={new OperationalApi()} capabilities={["jobs.read"]} />,
  );
  expect(html).toContain("작업 수락은 실행·발행 완료가 아닙니다");
  expect(html).toContain("사람의 검토");
  expect(html).not.toContain("일정 저장");
});
test("schedule request pins approved scope and uses a credential identifier, never a session", () => {
  const body = scheduleRequest({
    key: "daily",
    cadence: "daily",
    time: "09:00",
    timezone: "Asia/Seoul",
    weekday: 1,
    pageIds: ["p"],
    sourceIds: ["s"],
    tokens: 100,
    costMicros: 10,
    identity: {
      workspaceId: "w",
      principalId: "service",
      credentialId: "credential",
    },
  });
  expect(body.approvedPageIds).toEqual(["p"]);
  expect(body.identity).toEqual({
    workspaceId: "w",
    principalId: "service",
    credentialId: "credential",
  });
  expect(body.job.kind).toBe("daily");
  expect(JSON.stringify(body)).not.toContain("session");
});
test("manager can configure explicit UTC budget ceilings, not fabricated actual costs", () => {
  const html = renderToStaticMarkup(
    <JobsPanel api={new OperationalApi()} capabilities={["jobs.manage"]} />,
  );
  expect(html).toContain("일일 예산 한도 저장");
  expect(html).toContain("예약·보수적 청구는 실제 사용량과 다릅니다");
});
test("schedule editor preserves explicit holiday/catchup policy and CAS revision", () => {
  const body = scheduleRequest({
    key: "weekly",
    cadence: "weekly",
    time: "09:00",
    timezone: "Asia/Seoul",
    weekday: 1,
    pageIds: [],
    sourceIds: [],
    tokens: 0,
    costMicros: 0,
    identity: { workspaceId: "w", principalId: "service", credentialId: "c" },
    holidays: ["2026-11-02"],
    catchup: "bounded",
    catchupLimit: 2,
    expectedRevision: 4,
  });
  expect(body.holidays).toEqual(["2026-11-02"]);
  expect(body.catchup).toBe("bounded");
  expect(body.expectedRevision).toBe(4);
});
