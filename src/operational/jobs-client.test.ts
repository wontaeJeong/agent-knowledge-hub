import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { OperationalApi } from "./api";
import { resolveJob } from "./jobs-client";
test("accepted work is polled to actual completion and never interpreted as an answer itself", async () => {
  let polls = 0;
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    polls++;
    res.end(
      JSON.stringify(
        polls === 1
          ? { id: "job-one", status: "running" }
          : {
              id: "job-one",
              status: "succeeded",
              result: { content: "완료한 실제 결과" },
            },
      ),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const api = new OperationalApi(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      ),
      states: string[] = [];
    expect(
      await resolveJob(
        api,
        { id: "job-one", status: "queued" },
        { pollMs: 0, onProgress: (j) => states.push(j.status) },
      ),
    ).toEqual({ content: "완료한 실제 결과" });
    expect(polls).toBe(2);
    expect(states).toEqual(["queued", "running", "succeeded"]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("even a previously completed receipt rechecks current authorization before revealing its cached result", async () => {
  const server = createServer((_req, res) => {
    res
      .writeHead(403, { "content-type": "application/json" })
      .end(JSON.stringify({ code: "FORBIDDEN" }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const api = new OperationalApi(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    await expect(
      resolveJob(api, {
        id: "job-one",
        status: "succeeded",
        result: { content: "이전 제한 결과" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("a failed durable model call stays a failure instead of becoming an empty successful answer", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "job-one",
        status: "dead",
        error_code: "MODEL_FAILED",
        result: null,
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const api = new OperationalApi(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    await expect(
      resolveJob(api, { id: "job-one", status: "queued" }),
    ).rejects.toMatchObject({ code: "MODEL_FAILED" });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("a response arriving after the view was abandoned is never returned as a visible result", async () => {
  const abort = new AbortController();
  const server = createServer((_req, res) => {
    abort.abort();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "job-one",
        status: "succeeded",
        result: { content: "이전 화면의 응답" },
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const api = new OperationalApi(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    await expect(
      resolveJob(
        api,
        { id: "job-one", status: "queued" },
        { signal: abort.signal },
      ),
    ).rejects.toThrow("대기");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
