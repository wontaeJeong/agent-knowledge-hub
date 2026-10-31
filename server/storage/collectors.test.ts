import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { collectArtifact } from "./collectors";
it("rejects assistant artifacts without a trusted session binding regardless of caller selection", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/opencode-2.2.2-assistant.json", import.meta.url),
      "utf8",
    ),
  );
  const opts = {
    tool: "opencode",
    version: "2.2.2",
    format: "api.assistant-message",
    sessionId: "ses_redactedFixture",
    selectedIds: [fixture.data.id],
    selectedToolIds: ["call_redacted1"],
    excludedSessionIds: [],
  };
  const replacement = structuredClone(fixture);
  replacement.data.id = "msg_replacement";
  const cases: [unknown, Parameters<typeof collectArtifact>[1]][] = [
    [fixture, opts],
    [fixture, { ...opts, excludedSessionIds: [opts.sessionId] }],
    [
      fixture,
      { ...opts, sessionId: "ses_other", excludedSessionIds: [opts.sessionId] },
    ],
    [fixture, { ...opts, sessionId: undefined }],
    [replacement, { ...opts, selectedIds: [replacement.data.id] }],
  ];
  for (const [input, options] of cases) {
    expect(() => collectArtifact(input, options)).toThrow(
      "ARTIFACT_SESSION_UNVERIFIED",
    );
  }
});
it("parses actual 2.2.2 API response fixture without elevating author statements", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/opencode-2.2.2-synthetic.json", import.meta.url),
      "utf8",
    ),
  );
  const opts = {
    tool: "opencode",
    version: "2.2.2",
    format: "api.synthetic-message",
    selectedIds: [fixture.data.id],
    excludedSessionIds: [],
  };
  const result = collectArtifact(fixture, opts);
  expect(result.content).toContain("한글");
  expect(result.verification).toBe("unverified");
  expect(result.kind).toBe("author-statement");
  expect(collectArtifact(fixture, opts).sha256).toBe(result.sha256);
  expect(() => collectArtifact(fixture, { ...opts, version: "2.2.3" })).toThrow(
    "UNSUPPORTED_COLLECTOR_VERSION",
  );
  expect(() =>
    collectArtifact(fixture, {
      ...opts,
      excludedSessionIds: [fixture.data.sessionID],
    }),
  ).toThrow("COLLECTION_EXCLUDED");
  expect(() => collectArtifact(fixture, { ...opts, selectedIds: [] })).toThrow(
    "COLLECTION_EXCLUDED",
  );
  const hidden = structuredClone(fixture);
  hidden.data.payload.reasoning = "private";
  expect(() => collectArtifact(hidden, opts)).toThrow();
});
