import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

test("rendered app stores content in an environment-local PVC rather than the temporary root", () => {
  for (const env of ["local", "stg", "prod"]) {
    const resources = parseAllDocuments(
      execFileSync("kubectl", ["kustomize", `deploy/overlays/${env}`], {
        encoding: "utf8",
      }),
    ).map((d) => d.toJSON());
    const app = resources.find(
      (r) => r.kind === "Deployment" && r.metadata.name === "knowledge-app",
    );
    const pod = app.spec.template.spec,
      container = pod.containers.find((c) => c.name === "app");
    const root = container.env.find((e) => e.name === "AKH_BLOB_ROOT")?.value;
    assert.equal(root, "/data/blobs");
    const mount = container.volumeMounts.find((m) => m.mountPath === root);
    assert.ok(mount, "blob path must have its own mount");
    const volume = pod.volumes.find((v) => v.name === mount.name);
    assert.ok(volume.persistentVolumeClaim, "not emptyDir");
    const pvc = resources.find(
      (r) =>
        r.kind === "PersistentVolumeClaim" &&
        r.metadata.name === volume.persistentVolumeClaim.claimName,
    );
    assert.equal(pvc.metadata.namespace, `agent-knowledge-hub-${env}`);
  }
});
test("only local deployment explicitly adopts verified fixture subjects as owners and grants", () => {
  const local = parseAllDocuments(
    execFileSync("kubectl", ["kustomize", "deploy/overlays/local"], {
      encoding: "utf8",
    }),
  ).map((d) => d.toJSON());
  const config = local.find(
    (r) => r.kind === "ConfigMap" && r.data?.ACCESS_BOOTSTRAP_JSON,
  );
  assert.ok(config);
  const adoption = JSON.parse(config.data.ACCESS_BOOTSTRAP_JSON).spaces[0];
  assert.deepEqual(adoption.owners, [
    {
      issuer: "http://localhost:28081/realms/knowledge",
      subject: "10000000-0000-4000-8000-000000000001",
    },
  ]);
  assert.deepEqual(adoption.grants, [
    {
      principalId:
        "23895760c15244211bbc337b50aff374c96fec003c3fd0b8950c86576d90b5e3",
      role: "write",
    },
    {
      principalId:
        "1bb6ad7a69d82731ee38c412620672516b4d76f730e68dc70c7164a39844171f",
      role: "read",
    },
  ]);
  for (const env of ["stg", "prod"]) {
    const site = parseAllDocuments(
      execFileSync("kubectl", ["kustomize", `deploy/overlays/${env}`], {
        encoding: "utf8",
      }),
    ).map((d) => d.toJSON());
    assert.equal(
      site.some((r) => r.kind === "ConfigMap" && r.data?.ACCESS_BOOTSTRAP_JSON),
      false,
    );
  }
});

for (const env of ["local", "stg", "prod"]) {
  test(`${env} renders persistent isolated workloads with restricted application`, () => {
    const yaml = execFileSync(
      "kubectl",
      ["kustomize", `deploy/overlays/${env}`],
      { encoding: "utf8" },
    );
    assert.match(yaml, new RegExp(`namespace: agent-knowledge-hub-${env}`));
    assert.match(yaml, /kind: StatefulSet/);
    assert.match(yaml, /kind: PersistentVolumeClaim/);
    assert.match(yaml, /runAsNonRoot: true/);
    assert.match(yaml, /readOnlyRootFilesystem: true/);
    assert.match(yaml, /path: \/healthz/);
    assert.match(yaml, /path: \/readyz/);
    assert.doesNotMatch(yaml, /kind: Secret/);
    if (env !== "local") {
      assert.match(yaml, /kind: NetworkPolicy/);
      assert.match(yaml, /kind: Ingress/);
      assert.match(yaml, /tls:/);
      assert.doesNotMatch(yaml, /start-dev|local-test-only|18081|:latest/);
    } else assert.match(yaml, /OIDC_ALLOW_HTTP: "true"/);
  });
}
test("kind cluster is named and does not expose local ports on all interfaces", () => {
  const yaml = readFileSync("deploy/kind.yaml", "utf8");
  assert.match(yaml, /name: knowledge-hub-dev/);
  assert.match(yaml, /listenAddress: "127.0.0.1"/);
  assert.doesNotMatch(yaml, /0\.0\.0\.0/);
});
test("local identity subjects survive fixture restart and IdP readiness is real", () => {
  const realm = JSON.parse(
    readFileSync("deploy/overlays/local/knowledge-realm.json", "utf8"),
  );
  assert.equal(new Set(realm.users.map((u) => u.id)).size, realm.users.length);
  assert.ok(
    realm.users.every((u) => typeof u.id === "string" && u.id.length > 10),
  );
  const yaml = readFileSync("deploy/overlays/local/keycloak.yaml", "utf8");
  assert.match(yaml, /path: \/health\/ready/);
  assert.match(yaml, /type: Recreate/);
});
