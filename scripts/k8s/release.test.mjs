import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRelease, productionFailures, migrationJob } from "./release.mjs";
const digest = "sha256:" + "a".repeat(64);
const app = (image) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "knowledge-app", namespace: "agent-knowledge-hub-prod" },
  spec: { template: { spec: { containers: [{ name: "app", image }] } } },
});
test("migration infrastructure never contains the application deployment", () => {
  const infrastructure = {
    kind: "StatefulSet",
    metadata: { name: "knowledge-db" },
  };
  const result = splitRelease([app("knowledge-hub:dev"), infrastructure]);
  assert.deepEqual(result.infrastructure, [infrastructure]);
  assert.equal(result.application[0].metadata.name, "knowledge-app");
});
test("migration uses the exact application image and explicit owner bootstrap config, without model or audit secrets", () => {
  const deployment = app(`registry.example/app@${digest}`);
  deployment.spec.template.spec.containers[0].envFrom = [
    { configMapRef: { name: "knowledge-config-rendered-hash" } },
    { secretRef: { name: "knowledge-secrets" } },
  ];
  const job = migrationJob(deployment, "knowledge-migrate-test");
  const container = job.spec.template.spec.containers[0];
  assert.equal(container.image, `registry.example/app@${digest}`);
  assert.deepEqual(container.command, ["npm", "run", "migrate:server"]);
  assert.equal(container.envFrom, undefined);
  assert.deepEqual(
    container.env.find((e) => e.name === "ACCESS_BOOTSTRAP_JSON").valueFrom
      .configMapKeyRef,
    {
      name: "knowledge-config-rendered-hash",
      key: "ACCESS_BOOTSTRAP_JSON",
      optional: true,
    },
  );
  assert.deepEqual(
    container.env.find((e) => e.name === "DATABASE_URL").valueFrom.secretKeyRef,
    { name: "knowledge-secrets", key: "DATABASE_URL" },
  );
  assert.equal(
    container.env.some((e) => /LLM|BACKUP|AUDIT|PASSWORD/.test(e.name)),
    false,
  );
  assert.equal(job.metadata.namespace, "agent-knowledge-hub-prod");
});
test("a digest on DB does not permit a mutable app image", () => {
  const resources = [
    app("registry.example/app:release"),
    {
      kind: "StatefulSet",
      spec: {
        template: { spec: { containers: [{ image: `postgres@${digest}` }] } },
      },
    },
  ];
  assert.ok(productionFailures(resources).some((e) => e.includes("image")));
});
test("every executable image including init/job images must be immutable", () => {
  const resources = [
    app(`registry.example/app@${digest}`),
    {
      kind: "Job",
      spec: {
        template: {
          spec: {
            initContainers: [{ image: "init:mutable" }],
            containers: [{ image: `migration@${digest}` }],
          },
        },
      },
    },
  ];
  assert.ok(
    productionFailures(resources).some((e) => e.includes("init:mutable")),
  );
});
