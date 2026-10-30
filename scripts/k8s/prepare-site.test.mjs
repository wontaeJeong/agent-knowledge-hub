import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteFiles, validateSiteConfig, writeSite } from "./prepare-site.mjs";

const digest = "sha256:" + "a".repeat(64);
const example = (environment = "stg") => ({
  environment,
  appHost: "wiki-" + environment + ".example.org",
  ingressClass: "internal-nginx",
  tlsSecretName: "knowledge-tls",
  oidcIssuer: "https://login.example.org/realms/work",
  oidcClientId: "knowledge-" + environment,
  appImage: "registry.example.org/knowledge/app@" + digest,
  postgresImage: "docker.io/library/postgres@" + digest,
  ingressController: {
    namespace: "ingress-system",
    podLabels: { "app.kubernetes.io/name": "ingress-controller" },
  },
  oidcEgressCidrs: ["10.23.42.10/32"],
  modelEgressCidrs: ["10.23.42.20/32"],
  quota: {
    requestsCpu: "2",
    requestsMemory: "2Gi",
    limitsCpu: "4",
    limitsMemory: "4Gi",
    storage: "30Gi",
  },
  dbStorageClass: "fast-rwo",
});

test("separate site overlays have immutable images, HTTPS and env-specific namespace", () => {
  for (const environment of ["stg", "prod"]) {
    const files = siteFiles(example(environment));
    const k = files["kustomization.yaml"];
    assert.match(k, new RegExp("namespace: agent-knowledge-hub-" + environment));
    assert.match(k, new RegExp("overlays/" + environment));
    assert.match(k, /behavior: merge/);
    assert.match(k, /APP_ORIGIN=https:\/\//);
    assert.match(k, /digest: sha256:[a-f0-9]{64}/);
    assert.equal(JSON.parse(files["ingress-patch.json"]).spec.tls[0].hosts[0],
      "wiki-" + environment + ".example.org");
    const ingress = JSON.parse(files["ingress-access.json"]);
    assert.deepEqual(ingress.spec.ingress[0].from[0].podSelector.matchLabels,
      { "app.kubernetes.io/name": "ingress-controller" });
    const outbound = JSON.parse(files["external-egress.json"]);
    assert.equal(outbound.spec.egress.length, 2);
    assert.ok(outbound.spec.egress.every((rule) =>
      rule.ports[0].port === 443 && rule.to[0].ipBlock.cidr !== "0.0.0.0/0"));
    assert.equal(JSON.parse(files["quota.json"]).spec.hard.pods, "8");
    assert.ok(Object.keys(files).every((n) => n !== "secrets.yaml"));
  }
});
test("production generation refuses unsafe or incomplete settings", () => {
  const bad = (patch) => assert.throws(() => validateSiteConfig({ ...example(), ...patch }));
  bad({ environment: "local" });
  bad({ appHost: "CHANGE-ME.invalid" });
  bad({ appHost: "localhost" });
  bad({ oidcIssuer: "http://login.example.org" });
  bad({ oidcIssuer: "https://user:password@login.example.org" });
  bad({ appImage: "registry.example.org/knowledge/app:latest" });
  bad({ postgresImage: "postgres:17.6-bookworm" });
  bad({ oidcEgressCidrs: [] });
  bad({ oidcEgressCidrs: ["0.0.0.0/0"] });
  bad({ modelEgressCidrs: ["::/0"] });
  bad({ ingressController: { namespace: "ingress-system", podLabels: {} } });
  bad({ quota: { limitsCpu: "4" } });
  bad({ DATABASE_PASSWORD: "should-not-be-serialized" });
});
test("generator never overwrites a reviewed site", () => {
  const root = mkdtempSync(join(tmpdir(), "akh-site-"));
  try {
    const result = writeSite(example(), root);
    assert.ok(existsSync(join(result, "kustomization.yaml")));
    assert.match(readFileSync(join(result, "kustomization.yaml"), "utf8"),
      /knowledge-config/);
    assert.throws(() => writeSite(example(), root), { code: "EEXIST" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("site without separate model connection allows OIDC only", () => {
  const files = siteFiles({ ...example("prod"), modelEgressCidrs: [] });
  assert.equal(JSON.parse(files["external-egress.json"]).spec.egress.length, 1);
});
