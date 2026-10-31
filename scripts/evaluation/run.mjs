import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runEvaluation } from "./runner.mjs";
import { createEvaluationAgent } from "./provider.mjs";
import { renderReport } from "./report.mjs";

// Explicit fixture mode never substitutes for a failed actual model call.
const fixture = process.argv.includes("--fixture");
const outputArg = process.argv.find((a) => a.startsWith("--output="));
const output = resolve(outputArg?.slice(9) ?? "artifacts/evaluation");
const dataset = JSON.parse(
  await readFile(
    new URL("./fixtures/knowledge-evolution.v1.json", import.meta.url),
    "utf8",
  ),
);
const expected = JSON.parse(
  await readFile(
    new URL("./fixtures/expected.v1.json", import.meta.url),
    "utf8",
  ),
);
const env = process.env;
const config = {
  model: fixture
    ? "structural-abstention-fixture"
    : env.AGENT_KNOWLEDGE_HUB_LLM_MODEL,
  provider: fixture ? "fixture" : "host-openai-compatible",
  seed: Number(env.EVALUATION_SEED ?? 7),
  repeats: Number(env.EVALUATION_REPEATS ?? 1),
  budget: {
    calls: Number(env.EVALUATION_MAX_CALLS ?? 3),
    maxTokens: Number(env.EVALUATION_MAX_TOKENS ?? 6000),
    timeoutMs: Number(env.EVALUATION_TIMEOUT_MS ?? 60000),
  },
  tools: ["raw_lookup"],
  appCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  rulesVersion: "agent-knowledge-hub/2",
  promptVersion: "eval/1",
  wikiVersion: dataset.version,
  kind: fixture ? "structural-fixture" : "actual-model",
  maintenanceCost: null,
};
try {
  const agent = fixture
    ? async () => ({
        answer: "보류",
        abstained: true,
        citations: [],
        usage: { cost: null, tokens: null },
      })
    : createEvaluationAgent({
        baseUrl: env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL,
        model: config.model,
        apiKey: env.AGENT_KNOWLEDGE_HUB_LLM_API_KEY,
        allowTransmission:
          env.AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION === "true",
        thinking: env.AGENT_KNOWLEDGE_HUB_LLM_THINKING,
      });
  const report = await runEvaluation({ dataset, expected, config, agent });
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, `${report.id}.json`),
    JSON.stringify(report, null, 2),
  );
  await writeFile(resolve(output, `${report.id}.html`), renderReport(report));
  console.log(
    JSON.stringify({
      id: report.id,
      kind: report.kind,
      status: report.status,
      assigned: report.assigned,
      completed: report.completed,
      succeeded: report.succeeded,
      benefit: report.benefit,
      output,
    }),
  );
  if (report.status !== "completed" || report.safetyFailures)
    process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      code:
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "EVALUATION_FAILED",
    }),
  );
  process.exitCode = 1;
}
