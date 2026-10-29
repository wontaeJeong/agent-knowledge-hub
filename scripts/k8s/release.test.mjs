import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRelease, productionFailures } from "./release.mjs";
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
