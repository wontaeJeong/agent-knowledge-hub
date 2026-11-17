import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "./knowledge";
import { discoveryReport } from "../discovery";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
test.each(["offline", "model"] as const)(
  "new %s answers use canonical persistence clock despite host ahead; scope time and oversized-envelope failure remain",
  async (mode) => {
    const f = await fixture();
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await adoptFixture(f.pool, f.workspaceId);
      if (mode === "model") {
        server = createServer(async (req, res) => {
          for await (const _ of req) {
            /* consume real provider request */
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      content: "기존 내용",
                      insufficient: false,
                      citations: [
                        {
                          pageId: "topic",
                          version: 1,
                          title: "주제",
                          quote: "기존 내용",
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          );
        }).listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
        vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", base);
        vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "c8-synthetic-clock");
        vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
        vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "c8-clock-local");
        await approveLocalTransmissionFixture(
          f.pool,
          f.workspaceId,
          base + "/chat/completions",
          ["query"],
          "c8-clock-local",
        );
      }
      const before = (await f.pool.query("SELECT clock_timestamp() AS t"))
        .rows[0].t as Date;
      vi.useFakeTimers({ toFake: ["Date"] });
      const hostAt = new Date(before.getTime() + 300000);
      vi.setSystemTime(hostAt);
      const runtime = new RuntimeService(f.pool),
        answer = await runtime.query(
          mode === "model"
            ? {
                ...f.editor,
                authorization: {
                  revalidate: async () => {},
                  assertSession: async () => {},
                },
              }
            : f.editor,
          "기존",
          mode,
        );
      const observed = (
        await f.pool.query(
          "SELECT clock_timestamp() AS now,data FROM runtime_answers WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, answer.id],
        )
      ).rows[0];
      expect(answer.at).toBe(observed.data.at);
      expect(Date.parse(answer.at)).toBeGreaterThanOrEqual(before.getTime());
      expect(Date.parse(answer.at)).toBeLessThanOrEqual(observed.now.getTime());
      expect((answer as any).asOf).toBe(hostAt.toISOString()); // Query selection time is a separate contract.
      expect(
        (await discoveryReport(f.pool, runtime, f.editor, 7)).mostCited.map(
          (p) => [p.id, p.citations],
        ),
      ).toEqual([["topic", 1]]);
      await f.pool.query(
        "UPDATE runtime_answers SET data=jsonb_set(data,'{inputEnvelope,pageIds}',$3) WHERE workspace_id=$1 AND id=$2",
        [
          f.workspaceId,
          answer.id,
          JSON.stringify(Array.from({ length: 501 }, (_, i) => "p" + i)),
        ],
      );
      await expect(
        discoveryReport(f.pool, runtime, f.editor, 7),
      ).rejects.toThrow("DISCOVERY_CAPACITY");
    } finally {
      vi.useRealTimers();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((r) => server!.close(() => r()));
      }
      await f.pool.end();
    }
  },
);
