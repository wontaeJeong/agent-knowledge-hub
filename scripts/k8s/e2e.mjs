import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

// Only synthetic accounts/data. Never point this test at a real company realm.
const origin = "http://localhost:28080";
const issuer = "http://localhost:28081";
class Client {
  cookies = new Map();
  csrf = "";
  async fetch(url, options = {}) {
    const target = new URL(url, origin);
    assert.ok(
      [origin, issuer].includes(target.origin),
      "Unexpected redirect destination",
    );
    const res = await fetch(target, {
      ...options,
      redirect: "manual",
      headers: {
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...options.headers,
      },
      signal: AbortSignal.timeout(90000),
    });
    for (const value of res.headers.getSetCookie()) {
      const pair = value.split(";", 1)[0],
        at = pair.indexOf("=");
      if (/max-age=0(?:;|$)/i.test(value))
        this.cookies.delete(pair.slice(0, at));
      else this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  }
  async login(username) {
    const begin = await this.fetch("/auth/login");
    assert.equal(begin.status, 302, "Login redirect");
    const form = await this.fetch(begin.headers.get("location"));
    assert.equal(form.status, 200, "Keycloak login form");
    const html = await form.text();
    const action = html
      .match(/<form[^>]*action="([^"]+)"/i)?.[1]
      ?.replaceAll("&amp;", "&");
    assert.ok(action, "Keycloak form action");
    const signed = await this.fetch(action, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: issuer,
      },
      body: new URLSearchParams({
        username,
        password: "local-test-only",
        credentialId: "",
      }).toString(),
    });
    assert.equal(signed.status, 302, "Keycloak credential acceptance");
    const callback = await this.fetch(signed.headers.get("location"));
    assert.equal(callback.status, 302, "OIDC callback");
    this.me = await this.api("/me");
    this.csrf = this.me.csrfToken;
    return this;
  }
  async api(path, body, key) {
    const res = await this.fetch(`/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": this.csrf,
              ...(key ? { "Idempotency-Key": key } : {}),
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json();
    if (!res.ok)
      throw Error(
        `${res.status}:${data.code || "HTTP_ERROR"}:${data.requestId || ""}`,
      );
    return data;
  }
}
const result = {
  kind: "synthetic-kind-acceptance",
  at: new Date().toISOString(),
  steps: [],
  load: null,
  model: null,
};
const step = (name) => {
  result.steps.push(name);
  console.log(`PASS ${name}`);
};
try {
  assert.equal(
    (await fetch(`${origin}/api/v1/me`, { redirect: "manual" })).status,
    401,
  );
  step("anonymous denied");
  const reviewer = await new Client().login("reviewer");
  const writer = await new Client().login("writer");
  const reader = await new Client().login("reader");
  assert.equal(reviewer.me.role, "reviewer");
  assert.equal(writer.me.role, "editor");
  assert.equal(reader.me.role, "reader");
  step("real Keycloak OIDC identities");
  const badCsrf = await writer.fetch("/api/v1/lint", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-CSRF-Token": "invalid",
    },
    body: "{}",
  });
  assert.equal(badCsrf.status, 403);
  step("CSRF denied");
  const sourceId = `synthetic-${randomUUID()}`;
  await writer.api("/sources", {
    source: {
      id: sourceId,
      title: "합성 운영 기준",
      content:
        "## 지식: 백업\n매일 독립 저장소에 백업하고 복원 시험을 수행한다.\n사실: backup-period | synthetic | daily\n## 지식: 권한\n발행 직전에 현재 권한을 다시 확인한다.\n사실: publication-check | synthetic | current-permission",
      scope: "team",
      tool: "synthetic-e2e",
      project: "synthetic",
      verification: "미검증",
      targetPageId: "topic-main",
    },
    readers: [writer.me.principalId, reviewer.me.principalId],
  });
  const batch = await writer.api("/ingest", {
    sourceIds: [sourceId],
    mode: "offline",
  });
  const proposals = await reviewer.api("/changesets");
  assert.ok(proposals.items.find((b) => b.id === batch.id).updates.length >= 3);
  assert.equal(
    (await reader.api("/sources")).items.some((s) => s.id === sourceId),
    false,
  );
  step("source ACL and multi-page bootstrap");
  await reviewer.api(`/changesets/${batch.id}/approve`, { hash: batch.hash });
  const key = randomUUID();
  const published = await reviewer.api(
    `/changesets/${batch.id}/publish`,
    { hash: batch.hash },
    key,
  );
  const replay = await reviewer.api(
    `/changesets/${batch.id}/publish`,
    { hash: batch.hash },
    key,
  );
  assert.deepEqual(published, replay);
  step("approval atomic publication and idempotent retry");
  const answer = await writer.api("/query", {
    question: "백업",
    mode: "offline",
  });
  assert.equal(answer.insufficient, false);
  assert.ok(answer.citations.length);
  step("version-pinned query");
  const filed = await writer.api(`/answers/${answer.id}/file`, {});
  assert.ok(filed.id);
  step("answer reingestion proposal");
  const lint = await reviewer.api("/lint", {});
  assert.ok(Array.isArray(lint.issues));
  step("persisted Lint");
  const restrictedPages = await reader.api("/pages");
  assert.ok(
    !restrictedPages.items.some((p) =>
      Object.keys(published.versions).includes(p.id),
    ),
  );
  step("unauthorized pages not disclosed");
  const clients = [reviewer, writer, reader];
  while (clients.length < 10) clients.push(await new Client().login("writer"));
  const latency = [],
    started = performance.now();
  await Promise.all(
    clients.map(async (c) => {
      for (let n = 0; n < 5; n++) {
        const t = performance.now();
        await c.api("/pages");
        latency.push(performance.now() - t);
      }
    }),
  );
  latency.sort((a, b) => a - b);
  result.load = {
    sessions: 10,
    requests: latency.length,
    successful: latency.length,
    elapsedMs: Math.round(performance.now() - started),
    p95Ms: Math.round(latency[Math.ceil(latency.length * 0.95) - 1]),
    scope:
      "10 authenticated synthetic sessions; published-page reads only, not full workload/SLO acceptance",
  };
  step("10 authenticated sessions measured");
  if (process.argv.includes("--model")) {
    const config = await writer.api("/model");
    assert.equal(config.configured, true);
    const modelSourceId = `synthetic-model-${randomUUID()}`;
    await writer.api("/sources", {
      source: {
        id: modelSourceId,
        title: "합성 백업 검증 추가 근거",
        content:
          "## 지식: 백업\n백업 파일 생성만으로는 복구 가능성을 보장하지 않는다. 별도의 폐기용 환경에 복원하고 자료와 버전을 확인해야 한다.\n## 지식: 권한\n복원한 자료에도 현재 접근 권한을 적용하고 철회된 접근을 되살리지 않는다.",
        scope: "team",
        tool: "synthetic-e2e",
        project: "synthetic",
        verification: "미검증",
        targetPageId: "topic-main",
      },
      readers: [writer.me.principalId, reviewer.me.principalId],
    });
    const ingestStarted = performance.now();
    const modelBatch = await writer.api("/ingest", {
      sourceIds: [modelSourceId],
      mode: "model",
    });
    const modelProposal = (await reviewer.api("/changesets")).items.find(
      (b) => b.id === modelBatch.id,
    );
    assert.ok(
      modelProposal.updates.length >= 2,
      "model integrates multiple pages",
    );
    await reviewer.api(`/changesets/${modelBatch.id}/approve`, {
      hash: modelBatch.hash,
    });
    await reviewer.api(
      `/changesets/${modelBatch.id}/publish`,
      { hash: modelBatch.hash },
      randomUUID(),
    );
    const ingestMs = Math.round(performance.now() - ingestStarted);
    step("real model multi-page ingest and checked publication");
    const t = performance.now();
    const modelAnswer = await writer.api("/query", {
      question: "백업은 어떻게 수행해야 하나요?",
      mode: "model",
    });
    assert.equal(modelAnswer.mode, "model");
    assert.equal(modelAnswer.insufficient, false);
    assert.ok(modelAnswer.citations.length);
    result.model = {
      model: config.model,
      ingestMs,
      queryMs: Math.round(performance.now() - t),
      citations: modelAnswer.citations.length,
      scope:
        "synthetic connectivity/citation-validation case, not semantic-quality evaluation",
    };
    step("real model query with checked citations");
  }
  if (process.argv.includes("--output"))
    writeFileSync(
      process.argv[process.argv.indexOf("--output") + 1],
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  if (process.argv.includes("--output"))
    writeFileSync(
      process.argv[process.argv.indexOf("--output") + 1],
      JSON.stringify(
        {
          ...result,
          status: "failed",
          failure: e instanceof Error ? e.message : "unknown",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  console.error(
    "Synthetic kind acceptance FAILED:",
    e instanceof Error ? e.message : "unknown",
  );
  console.error(
    "No cookies, tokens or model keys are printed. Incomplete checks are not passes.",
  );
  process.exitCode = 1;
}
