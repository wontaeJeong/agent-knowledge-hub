import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { collectArtifact } from "./collectors";
it("collects selected actual assistant/tool artifact while excluding hidden reasoning, inputs and unselected outputs", async () => {
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
  const result = collectArtifact(fixture, opts);
  expect(result.content).toContain("한글");
  expect(result.content).not.toContain("redacted reasoning");
  expect(result.content).not.toContain("redacted2");
  expect(result.omitted.reasoning).toBe(1);
  expect(result.omitted.unselectedToolOutputs).toBe(3);
  expect(result.verification).toBe("unverified");
  expect(result.kind).toBe("tool-output");
  const incomplete = structuredClone(fixture);
  delete incomplete.data.time.completed;
  expect(() => collectArtifact(incomplete, opts)).toThrow(
    "ARTIFACT_INCOMPLETE",
  );
  expect(() =>
    collectArtifact(fixture, { ...opts, selectedToolIds: [] }),
  ).toThrow("NO_SELECTED_TEXT");
  const duplicate = structuredClone(fixture);
  duplicate.data.content.push(duplicate.data.content[1]);
  expect(() => collectArtifact(duplicate, opts)).toThrow(
    "DUPLICATE_TOOL_EVENT",
  );
  expect(() =>
    collectArtifact(fixture, { ...opts, selectedToolIds: ["unknown"] }),
  ).toThrow("SELECTED_ARTIFACT_NOT_FOUND");
  const mixed = structuredClone(fixture);
  mixed.data.content.push({
    type: "text",
    text: "한글 작성자 진술: 테스트 통과라고 주장",
  });
  const combined = collectArtifact(mixed, opts);
  expect(combined.kind).toBe("mixed-artifact");
  expect(combined.verification).toBe("unverified");
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
