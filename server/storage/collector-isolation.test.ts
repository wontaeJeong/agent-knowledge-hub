import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { storageRoutes } from "./routes";
import { collectorSupport } from "./collectors";
import type { StorageService } from "./service";
import type { Context } from "../service";

it("rejects an assistant artifact with a caller-spoofed session before source ingestion", async () => {
  const artifact = JSON.parse(
    await readFile(
      new URL("./fixtures/opencode-2.2.2-assistant.json", import.meta.url),
      "utf8",
    ),
  );
  const ingestText = vi.fn();
  const send = vi.fn();
  const route = storageRoutes({ ingestText } as unknown as StorageService);
  await expect(
    route({
      method: "POST",
      path: "/api/v1/storage/collect-artifact",
      ctx: {} as Context,
      send,
      body: {
        artifact,
        tool: "opencode",
        version: "2.2.2",
        format: "api.assistant-message",
        sessionId: "ses_other",
        selectedIds: [artifact.data.id],
        selectedToolIds: ["call_redacted1"],
        excludedSessionIds: ["ses_redactedFixture"],
        title: "fixture",
        project: "fixture",
      },
    }),
  ).rejects.toThrow("ARTIFACT_SESSION_UNVERIFIED");
  expect(ingestText).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("advertises assistant collection as unavailable and preserves synthetic collection", async () => {
  expect(
    collectorSupport.find((item) => item.format === "api.assistant-message")
      ?.available,
  ).toBe(false);
  const artifact = JSON.parse(
    await readFile(
      new URL("./fixtures/opencode-2.2.2-synthetic.json", import.meta.url),
      "utf8",
    ),
  );
  const ingestText = vi.fn().mockResolvedValue({ id: "source-fixture" });
  const send = vi.fn();
  const route = storageRoutes({ ingestText } as unknown as StorageService);
  await route({
    method: "POST",
    path: "/api/v1/storage/collect-artifact",
    ctx: {} as Context,
    send,
    body: {
      artifact,
      tool: "opencode",
      version: "2.2.2",
      format: "api.synthetic-message",
      selectedIds: [artifact.data.id],
      excludedSessionIds: [],
      title: "fixture",
      project: "fixture",
    },
  });
  expect(ingestText).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(201, { id: "source-fixture" });
});
