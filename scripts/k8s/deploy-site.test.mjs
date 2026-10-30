import { test } from "node:test";
import assert from "node:assert/strict";
import { liveSecretFailures, migrationJob, rolloutPlan } from "./deploy-site.mjs";

const digest = "registry.example.org/app@sha256:" + "a".repeat(64);
const encoded = (value) => Buffer.from(value).toString("base64");
const goodSecrets = () => {
  const password = "not-a-real-secret-for-testing";
  return {
    app: { type: "Opaque", data: {
      DATABASE_URL: encoded("postgres://knowledge:" + password +
        "@knowledge-db:5432/knowledge"),
      OIDC_CLIENT_SECRET: encoded("another-fake-test-secret"),
    } },
    db: { type: "Opaque", data: { password: encoded(password) } },
    tls: { type: "kubernetes.io/tls", data: {
      "tls.crt": encoded("test-certificate"), "tls.key": encoded("test-key"),
    } },
  };
};
test("live secrets agree on DB credentials and required OIDC/TLS keys", () => {
  assert.deepEqual(liveSecretFailures(goodSecrets(), "knowledge-tls"), []);
  const mismatch = goodSecrets();
  mismatch.db.data.password = encoded("different-db-password");
  assert.ok(liveSecretFailures(mismatch, "knowledge-tls")
    .some((e) => e.includes("DATABASE_URL")));
  const override = goodSecrets();
  override.app.data.OIDC_ALLOW_HTTP = encoded("true");
  assert.ok(liveSecretFailures(override, "knowledge-tls")
    .some((e) => e.includes("environment override")));
  const development = goodSecrets();
  development.app.data.OIDC_CLIENT_SECRET = encoded("local-test-only");
  assert.ok(liveSecretFailures(development, "knowledge-tls")
    .some((e) => e.includes("OIDC")));
  const wrong = goodSecrets();
  wrong.app.data.DATABASE_URL = encoded("postgres://knowledge:unsafe@other-db:5432/knowledge");
  assert.ok(liveSecretFailures(wrong, "knowledge-tls").length > 0);
});
test("migration job inherits immutable app image/network boundary but not probes", () => {
  const app = { kind: "Deployment",
    metadata: { name: "knowledge-app", namespace: "agent-knowledge-hub-stg" },
    spec: { template: { spec: {
      serviceAccountName: "knowledge-app",
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true },
      volumes: [{ name: "temporary", emptyDir: {} }],
      containers: [{ name: "app", image: digest,
        readinessProbe: { httpGet: { path: "/readyz" } },
        livenessProbe: { httpGet: { path: "/healthz" } },
        startupProbe: { httpGet: { path: "/healthz" } },
        envFrom: [{ secretRef: { name: "knowledge-secrets" } }],
      }],
    } } } };
  const job = migrationJob(app, "test-001");
  assert.equal(job.metadata.namespace, "agent-knowledge-hub-stg");
  assert.equal(job.spec.template.spec.containers[0].image, digest);
  assert.deepEqual(job.spec.template.spec.containers[0].command,
    ["npm", "run", "db:migrate"]);
  assert.equal(job.spec.template.spec.containers[0].readinessProbe, undefined);
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(app.spec.template.spec.containers[0].readinessProbe.httpGet.path,
    "/readyz", "must not mutate the Deployment");
});
test("rollout rejects incomplete resources before creating any job", () => {
  assert.throws(() => rolloutPlan([]), /PRODUCTION_PREFLIGHT_FAILED/);
});
