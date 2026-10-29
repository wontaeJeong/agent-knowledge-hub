import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

for (const env of ['local', 'stg', 'prod']) {
  test(`${env} renders persistent isolated workloads with restricted application`, () => {
    const yaml = execFileSync('kubectl', ['kustomize', `deploy/overlays/${env}`], { encoding: 'utf8' });
    assert.match(yaml, new RegExp(`namespace: agent-knowledge-hub-${env}`));
    assert.match(yaml, /kind: StatefulSet/);
    assert.match(yaml, /kind: PersistentVolumeClaim/);
    assert.match(yaml, /runAsNonRoot: true/);
    assert.match(yaml, /readOnlyRootFilesystem: true/);
    assert.match(yaml, /path: \/healthz/);
    assert.match(yaml, /path: \/readyz/);
    assert.doesNotMatch(yaml, /kind: Secret/);
    if (env !== 'local') {
      assert.match(yaml, /kind: NetworkPolicy/);
      assert.match(yaml, /kind: Ingress/);
      assert.match(yaml, /tls:/);
      assert.doesNotMatch(yaml, /start-dev|local-test-only|18081|:latest/);
    }
  });
}
test('kind cluster is named and does not expose local ports on all interfaces', () => {
  const yaml = readFileSync('deploy/kind.yaml', 'utf8');
  assert.match(yaml, /name: knowledge-hub-dev/);
  assert.match(yaml, /listenAddress: "127.0.0.1"/);
  assert.doesNotMatch(yaml, /0\.0\.0\.0/);
});
