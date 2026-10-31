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
      AUDIT_EXPORT_KEY: encoded("e".repeat(32)),
      AUDIT_SIGNING_KEY: encoded("s".repeat(32)),
      AKH_METRICS_TOKEN: encoded("m".repeat(32)),
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
test("migration job inherits immutable app image/network boundary but not probes or credentials", () => {
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
        envFrom: [{ configMapRef: { name: "knowledge-config-synthetic" } },
          { secretRef: { name: "knowledge-secrets" } }],
      }],
    } } } };
  const job = migrationJob(app, "test-001");
  assert.equal(job.metadata.name, "knowledge-migrate-test-001");
  assert.equal(job.metadata.namespace, "agent-knowledge-hub-stg");
  const container = job.spec.template.spec.containers[0];
  assert.equal(container.image, digest);
  assert.deepEqual(container.command, ["npm", "run", "migrate:server"]);
  assert.equal(container.readinessProbe, undefined);
  assert.equal(container.envFrom, undefined);
  assert.deepEqual(container.env.map((e) => e.name), ["DATABASE_URL", "ACCESS_BOOTSTRAP_JSON"]);
  assert.deepEqual(container.env[1].valueFrom.configMapKeyRef,
    { name: "knowledge-config-synthetic", key: "ACCESS_BOOTSTRAP_JSON", optional: true });
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(app.spec.template.spec.containers[0].readinessProbe.httpGet.path,
    "/readyz", "must not mutate the Deployment");
});
test("rollout rejects incomplete resources before creating any job", () => {
  assert.throws(() => rolloutPlan([]), /PRODUCTION_PREFLIGHT_FAILED/);
});
test("operational secrets are strong, independent, allowlisted and redacted", () => {
  for (const key of ["AUDIT_EXPORT_KEY", "AUDIT_SIGNING_KEY", "AKH_METRICS_TOKEN"]) {
    const secrets = goodSecrets();
    secrets.app.data[key] = encoded("too-short-sensitive");
    const failures = liveSecretFailures(secrets, "knowledge-tls");
    assert.ok(failures.length);
    assert.ok(!JSON.stringify(failures).includes("too-short-sensitive"));
  }
  const same = goodSecrets();
  same.app.data.AUDIT_SIGNING_KEY = same.app.data.AUDIT_EXPORT_KEY;
  assert.ok(liveSecretFailures(same, "knowledge-tls").length);
  for (const key of ["NODE_ENV", "APP_ORIGIN", "OIDC_ISSUER", "ACCESS_BOOTSTRAP_JSON",
    "AKH_MODEL_DESTINATIONS_JSON", "AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS"]) {
    const secrets = goodSecrets(); secrets.app.data[key] = encoded("override");
    assert.ok(liveSecretFailures(secrets, "knowledge-tls").some((e) => e.includes("environment override")));
  }
  const backup = goodSecrets();
  backup.app.data.AGENT_KNOWLEDGE_HUB_BACKUP_KEY = encoded("b".repeat(32));
  backup.app.data.BACKUP_KEY_ID = encoded("v1");
  backup.app.data.BACKUP_KEYS_JSON = encoded(JSON.stringify({ v1: "b".repeat(32) }));
  assert.deepEqual(liveSecretFailures(backup, "knowledge-tls"), []);
  backup.app.data.BACKUP_KEYS_JSON = encoded(JSON.stringify({ v1: "c".repeat(32) }));
  assert.ok(liveSecretFailures(backup, "knowledge-tls").length);
});
