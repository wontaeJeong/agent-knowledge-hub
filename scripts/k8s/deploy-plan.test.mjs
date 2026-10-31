import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { deploySite } from "./deploy-site.mjs";

const digest = "sha256:" + "a".repeat(64);
const appImage = "registry.example.org/knowledge/app@" + digest;
const pgImage = "docker.io/library/postgres@" + digest;
const encode = (s) => Buffer.from(s).toString("base64");

function sample(environment) {
  const ns = "agent-knowledge-hub-" + environment;
  const metadata = (name) => ({ name, namespace: ns });
  const app = {
    kind: "Deployment", metadata: metadata("knowledge-app"),
    spec: { replicas: 1, strategy: { type: "Recreate" },
      template: { spec: {
        automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true },
        containers: [{ name: "app", image: appImage,
          securityContext: { readOnlyRootFilesystem: true },
          startupProbe: {}, livenessProbe: {}, readinessProbe: {},
          envFrom: [{ configMapRef: { name: "knowledge-config-synthetic" } },
            { secretRef: { name: "knowledge-secrets" } }],
        }],
      } },
    },
  };
  return [
    { kind: "Namespace", metadata: { name: ns } },
    { kind: "Service", metadata: metadata("knowledge-app") },
    { kind: "Service", metadata: metadata("knowledge-db") },
    { kind: "ConfigMap", metadata: metadata("knowledge-config-synthetic"),
      data: { NODE_ENV: "production",
        APP_ORIGIN: "https://wiki-" + environment + ".company.test",
        OIDC_ISSUER: "https://login.company.test/realms/wiki",
        OIDC_CLIENT_ID: "wiki-" + environment,
        OIDC_GROUP_ROLES: '{"readers":"reader"}',
      },
    },
    app,
    { kind: "StatefulSet", metadata: metadata("knowledge-db"),
      spec: { replicas: 1, volumeClaimTemplates: [{ metadata: { name: "data" } }],
        template: { spec: { containers: [{ name: "postgres", image: pgImage,
          env: [{ name: "POSTGRES_PASSWORD", valueFrom: {
            secretKeyRef: { name: "knowledge-db-secret", key: "password" },
          } }],
        }] } },
      },
    },
    { kind: "Ingress", metadata: metadata("knowledge-app"),
      spec: { ingressClassName: "internal-nginx",
        tls: [{ hosts: ["wiki-" + environment + ".company.test"],
          secretName: "knowledge-tls" }],
        rules: [{ host: "wiki-" + environment + ".company.test",
          http: { paths: [{ backend: { service: { name: "knowledge-app",
            port: { number: 8080 } } } }] } }],
      },
    },
    { kind: "NetworkPolicy", metadata: metadata("default-deny"),
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } },
    { kind: "NetworkPolicy", metadata: metadata("app-to-db"),
      spec: { podSelector: { matchLabels: { app: "knowledge-db" } },
        ingress: [{ from: [{ podSelector: {
          matchLabels: { app: "knowledge-app" },
        } }], ports: [{ port: 5432 }] }],
      },
    },
    { kind: "NetworkPolicy", metadata: metadata("trusted-ingress-to-app"),
      spec: { podSelector: { matchLabels: { app: "knowledge-app" } },
        ingress: [{ from: [{ namespaceSelector: {
          matchLabels: { "kubernetes.io/metadata.name": "ingress-system" },
        }, podSelector: { matchLabels: { app: "ingress" } } }],
          ports: [{ port: 8080 }],
        }],
      },
    },
    { kind: "NetworkPolicy", metadata: metadata("reviewed-https-egress"),
      spec: { podSelector: { matchLabels: { app: "knowledge-app" } },
        egress: [{ to: [{ ipBlock: { cidr: "10.20.30.40/32" } }],
          ports: [{ protocol: "TCP", port: 443 }],
        }],
      },
    },
    { kind: "ResourceQuota", metadata: metadata("knowledge-resource-quota") },
  ];
}
function fakeKubectl(environment, options = {}) {
  const calls = [], jobs = [];
  const resources = sample(environment);
  const render = resources.map((r) => stringify(r)).join("---\n");
  const password = "fake-not-a-real-long-password";
  const secrets = {
    "knowledge-secrets": { type: "Opaque", data: {
      DATABASE_URL: encode("postgres://knowledge:" + password +
        "@knowledge-db:5432/knowledge"),
      OIDC_CLIENT_SECRET: encode("synthetic-client-secret"),
      AUDIT_EXPORT_KEY: encode("e".repeat(32)),
      AUDIT_SIGNING_KEY: encode("s".repeat(32)),
      AKH_METRICS_TOKEN: encode("m".repeat(32)),
    } },
    "knowledge-db-secret": { type: "Opaque", data: {
      password: encode(password),
    } },
    "knowledge-tls": { type: "kubernetes.io/tls", data: {
      "tls.crt": encode("test-only-cert"), "tls.key": encode("test-only-key"),
    } },
  };
  const executor = (_bin, args, settings) => {
    const command = args.join(" ");
    calls.push(command);
    if (command.includes("create -f -")) jobs.push(JSON.parse(settings.input));
    if (args[0] === "kustomize") return render;
    if (command.includes("get namespace")) return "namespace/" +
      "agent-knowledge-hub-" + environment;
    if (command.includes("get secret")) {
      const name = args[args.indexOf("secret") + 1];
      return JSON.stringify(secrets[name]);
    }
    if (command.includes("get deployment knowledge-app")) {
      return JSON.stringify({ spec: { template: { spec: {
        containers: [{ name: "app", image: options.stageImage || appImage }],
      } } } });
    }
    if (options.failMigration && command.includes("wait --for=condition=complete"))
      throw Object.assign(Error("synthetic migration failure"), { status: 1 });
    return "";
  };
  return { executor, calls, jobs };
}
test("validation is read-only even when a valid production site is provided", () => {
  const { executor, calls } = fakeKubectl("stg");
  const result = deploySite({ context: "company-cluster", environment: "stg",
    site: "deploy/sites/stg" }, executor);
  assert.equal(result.status, "validated");
  assert.deepEqual(calls, ["kustomize deploy/sites/stg"]);
});
test("STG deploy waits for successful migration before applying application", () => {
  const { executor, calls, jobs } = fakeKubectl("stg");
  const result = deploySite({ context: "company-cluster", environment: "stg",
    site: "deploy/sites/stg", apply: true }, executor);
  assert.equal(result.status, "deployed");
  const migrate = calls.findIndex((c) => c.includes("create -f -"));
  const wait = calls.findIndex((c) => c.includes("wait --for=condition=complete"));
  const applyIndices = calls.map((c, i) => c.includes("apply -f -") ? i : -1)
    .filter((i) => i >= 0);
  assert.equal(applyIndices.length, 2);
  assert.ok(applyIndices[0] < migrate);
  assert.ok(migrate < wait && wait < applyIndices[1]);
  const container = jobs[0].spec.template.spec.containers[0];
  assert.equal(container.image, appImage);
  assert.deepEqual(container.command, ["npm", "run", "migrate:server"]);
  assert.equal(container.envFrom, undefined);
  assert.equal(container.readinessProbe, undefined);
  assert.deepEqual(container.env.map((e) => e.name), ["DATABASE_URL", "ACCESS_BOOTSTRAP_JSON"]);
});
test("migration error blocks application apply", () => {
  const { executor, calls } = fakeKubectl("stg", { failMigration: true });
  assert.throws(() => deploySite({ context: "company-cluster",
    environment: "stg", site: "deploy/sites/stg", apply: true }, executor));
  assert.equal(calls.filter((c) => c.includes("apply -f -")).length, 1,
    "infrastructure may be applied, but application rollout is blocked");
});
test("PROD requires explicit approval and identical staged app image", () => {
  const context = { context: "company-cluster", environment: "prod",
    site: "deploy/sites/prod", apply: true };
  const unapproved = fakeKubectl("prod");
  assert.throws(() => deploySite(context, unapproved.executor),
    /EXPLICIT_PRODUCTION_APPROVAL_REQUIRED/);
  assert.equal(unapproved.calls.length, 1);
  const mismatched = fakeKubectl("prod", {
    stageImage: "registry.example.org/knowledge/app@sha256:" + "b".repeat(64),
  });
  assert.throws(() => deploySite({ ...context, approveProd: true },
    mismatched.executor), /APP_IMAGE_NOT_PROMOTED_FROM_STG/);
  assert.ok(!mismatched.calls.some((c) => c.includes("apply -f -")));
});
