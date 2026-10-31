/** Explicit UI preview only. Never selected as a fallback after a server error. */
import { OperationalApi, ApiError } from "./api";
import { seed } from "../domain/seed";
import type { Source, State } from "../domain/types";
import type { UsageSummary } from "../domain/usage";
import {
  answerOffline,
  compileOffline,
  createBatch,
  current,
  decideBatch,
  enqueueBatch,
  fileAnswer,
  lintWiki,
  memory,
  saveAnswer,
} from "../domain/wiki";

export class PreviewApi extends OperationalApi {
  private state: State = structuredClone(seed);
  constructor() {
    super();
    this.state = enqueueBatch(
      this.state,
      createBatch(
        this.state,
        compileOffline(this.state, ["src-ca"]),
        ["src-ca"],
        "offline",
        "예시: 컨테이너 신뢰 저장소 지식 갱신",
      ),
    );
  }
  override async me() {
    return {
      principalId: "preview-human",
      workspaceId: "preview-space",
      role: "reviewer" as const,
      csrfToken: "preview-not-a-credential",
    };
  }
  override async logout() {
    throw Error("목업에는 로그인 세션이 없습니다.");
  }
  override async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const b = (body ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (method === "GET") {
      if (path === "/pages")
        result = {
          items: this.state.pages.map((p) => ({
            id: p.id,
            title: p.title,
            summary: p.summary,
            scope: p.scope,
            version: current(p).number,
            content: current(p).content,
          })),
        };
      else if (path === "/sources") result = { items: this.state.sources };
      else if (path === "/changesets")
        result = {
          items: memory(this.state).batches.map((x) => ({ ...x, hash: x.id })),
        };
      else if (path === "/members")
        result = {
          items: [
            { principalId: "preview-human", role: "reviewer" },
            { principalId: "preview-editor", role: "editor" },
          ],
        };
      else if (path === "/model") result = { configured: false, model: null };
      else if (path === "/jobs")
        result = {
          items: [
            {
              id: "preview-attempt-01",
              status: "failed",
              operation: "ingest",
              error_code: "MODEL_UNAVAILABLE",
              created_at: "2026-10-30T01:00:00Z",
              finished_at: "2026-10-30T01:00:02Z",
            },
            {
              id: "preview-attempt-02",
              status: "succeeded",
              operation: "ingest.offline",
              created_at: "2026-10-30T01:03:00Z",
              finished_at: "2026-10-30T01:03:01Z",
            },
          ],
        };
      else if (/^\/usage\?days=(7|30)$/.test(path))
        result = previewUsage(Number(path.split("=")[1]));
      else {
        const match = /^\/pages\/([^/]+)\/versions\/(\d+)$/.exec(path);
        const page =
          match &&
          this.state.pages.find((p) => p.id === decodeURIComponent(match[1]));
        const version =
          page && page.versions.find((v) => v.number === Number(match![2]));
        if (!page || !version)
          throw new ApiError("목업에 없는 버전입니다.", 404);
        result = { title: page.title, version };
      }
    } else if (method === "POST") {
      if (path === "/sources") {
        const source = b.source as Source;
        if (!source?.id || !source.title?.trim() || !source.content?.trim())
          throw Error("제목과 본문이 필요합니다.");
        if (this.state.sources.some((s) => s.id === source.id))
          throw Error("중복 원본입니다.");
        // Existing UI uses a server target; preview maps only to its synthetic topic.
        this.state.sources.unshift({
          ...source,
          scope: "company",
          targetPageId: "container-ca",
        });
        result = { ok: true };
      } else if (path === "/ingest") {
        if (b.mode !== "offline")
          throw Error(
            "목업은 모델을 호출하지 않습니다. 구조 검사·발췌를 선택하세요.",
          );
        const ids = b.sourceIds as string[];
        const batch = createBatch(
          this.state,
          compileOffline(this.state, ids),
          ids,
          "offline",
        );
        this.state = enqueueBatch(this.state, batch);
        result = { id: batch.id };
      } else if (path === "/query") {
        if (b.mode !== "offline")
          throw Error("목업은 모델을 호출하지 않습니다.");
        const answer = answerOffline(this.state, String(b.question));
        this.state = saveAnswer(this.state, answer);
        result = answer;
      } else if (path === "/lint") result = { issues: lintWiki(this.state) };
      else {
        const decision =
          /^\/changesets\/([^/]+)\/(approve|publish|reject)$/.exec(path);
        const file = /^\/answers\/([^/]+)\/file$/.exec(path);
        if (decision) {
          if (b.hash !== decision[1]) throw Error("목업 기준 해시가 다릅니다.");
          this.state = decideBatch(
            this.state,
            decision[1],
            decision[2] as "approve" | "publish" | "reject",
          );
          result = { ok: true };
        } else if (file) {
          this.state = fileAnswer(this.state, file[1]);
          result = { ok: true };
        } else
          throw new ApiError(
            "지원하지 않는 목업 동작입니다. 서버에는 요청하지 않았습니다.",
            400,
          );
      }
    } else throw new ApiError("지원하지 않는 목업 요청입니다.", 400);
    return structuredClone(result) as T;
  }
}

function previewUsage(days: number): UsageSummary {
  const daily = Array.from({ length: days }, (_, i) => ({
    day: new Date(Date.UTC(2026, 9, 31 - days + i)).toISOString().slice(0, 10),
    succeeded: [24, 31, 18, 42, 35, 46, 38][i % 7],
    failed: [1, 0, 2, 1, 3, 1, 2][i % 7],
  }));
  const succeeded = daily.reduce((n, d) => n + d.succeeded, 0),
    failed = daily.reduce((n, d) => n + d.failed, 0);
  const total = succeeded + failed;
  return {
    scope: "workspace",
    from: `${daily[0].day}T00:00:00Z`,
    to: "2026-10-30T23:59:59Z",
    timezone: "UTC",
    total,
    succeeded,
    failed,
    activeUsers: 4,
    publications: 3,
    daily,
    operations: [
      {
        operation: "page.read",
        total: total - 10,
        failed,
        averageDurationMs: 42.6,
      },
      {
        operation: "batch.publish",
        total: 4,
        failed: 0,
        averageDurationMs: 84,
      },
      {
        operation: "source.register",
        total: 6,
        failed: 0,
        averageDurationMs: 35,
      },
    ],
    model: { inputTokens: null, outputTokens: null, cost: null },
  };
}
