import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diagnose } from "./doctor.mjs";

test("diagnostics reject unsupported runtimes at the supported boundaries", () => {
  for (const [version, supported] of [
    ["20.20.0", false], ["22.11.0", false], ["22.12.0", true],
    ["22.22.0", true], ["24.0.0", true], ["25.7.0", false], ["26.0.0", false],
  ]) {
    const result = diagnose({ nodeVersion: version, dependenciesInstalled: true });
    assert.equal(result.ok, supported, version);
    if (!supported) assert.match(result.messages.join("\n"), /Node.*22\.12.*24/);
  }
});

test("missing dependencies provide an actionable reproducible install command", () => {
  const result = diagnose({ nodeVersion: "24.0.0", dependenciesInstalled: false });
  assert.equal(result.ok, false);
  assert.match(result.messages.join("\n"), /npm ci/);
});

test("diagnostic CLI fails without dependencies without reading secrets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "knowledge-doctor-"));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./doctor.mjs", import.meta.url))], {
      cwd, encoding: "utf8", env: { ...process.env, AGENT_KNOWLEDGE_HUB_LLM_API_KEY: "must-not-print-this" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /npm ci/);
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-print-this/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
