import React from "react";
import { createRoot } from "react-dom/client";
import { PublicationSchedule } from "/src/operational/scheduled-publication.tsx";
import "/src/ui/tokens.css";
import "/src/styles.css";
import "/src/operational/styles.css";
let rows = [];
const dueAt = new Date(Date.now() + 300000).toISOString(),
  expiry = new Date(Date.now() + 1200000).toISOString();
const api = {
  get: async () => ({ items: rows }),
  post: async (path, input) => {
    if (path.endsWith("/preview"))
      return {
        previewHash: "a".repeat(64),
        dueAt: input.dueAt,
        authorizationExpiresAt: expiry,
        versions: { topic: 2, "concept-retry": 1 },
      };
    if (path.endsWith("/cancel")) {
      rows = rows.map((s) => ({ ...s, status: "cancelled" }));
      return rows[0];
    }
    rows = [
      {
        id: "synthetic-schedule",
        status: "scheduled",
        dueAt: input.dueAt,
        authorizationExpiresAt: expiry,
        errorCode: null,
      },
    ];
    return rows[0];
  },
};
createRoot(document.getElementById("root")).render(
  <main
    className="operational-app"
    style={{ maxWidth: 1000, margin: "32px auto", padding: 24 }}
  >
    <h1>변경 집합 검토</h1>
    <p>합성 자료 · 실제 React 예약 컴포넌트 · 화면 증거 전용 API</p>
    <article className="op-panel">
      <h2>재시도 조건 갱신</h2>
      <p>승인됨 · 변경 2개 · 원본 실행 자료 1개</p>
      <p>일시 오류만 재시도하고 영구 오류를 제외합니다.</p>
      <PublicationSchedule
        api={api}
        batchId="synthetic-batch"
        hash={"b".repeat(64)}
        canSchedule
      />
    </article>
  </main>,
);
