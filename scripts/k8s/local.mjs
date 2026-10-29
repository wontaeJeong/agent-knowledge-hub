import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
const cluster = 'knowledge-hub-dev';
const context = `kind-${cluster}`;
const namespace = 'agent-knowledge-hub-local';
const run = (bin, args, input) => execFileSync(bin, args, { ...(input ? { input } : {}), encoding: 'utf8', stdio: input ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
const k = (args, input) => run('kubectl', ['--context', context, '-n', namespace, ...args], input);
const apply = (obj) => k(['apply', '-f', '-'], JSON.stringify(obj));
const command = process.argv[2] || 'status';
try {
  if (command === 'up') {
    const names = run('kind', ['get', 'clusters']).trim().split('\n');
    if (!names.includes(cluster)) console.log(run('kind', ['create', 'cluster', '--config', 'deploy/kind.yaml', '--image', 'kindest/node:v1.34.0', '--wait', '120s']));
    k(['apply', '-f', 'deploy/overlays/local/namespace.yaml']);
    let password;
    try { password = Buffer.from(JSON.parse(k(['get', 'secret', 'knowledge-db-secret', '-o', 'json'])).data.password, 'base64').toString(); }
    catch { password = randomBytes(32).toString('hex'); }
    apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'knowledge-db-secret' }, type: 'Opaque', stringData: { password } });
    const env = { DATABASE_URL: `postgres://knowledge:${password}@knowledge-db:5432/knowledge`, OIDC_CLIENT_SECRET: 'local-test-only' };
    const modelFile = process.argv.indexOf('--model-env');
    if (modelFile >= 0) {
      if (!process.argv[modelFile + 1]) throw Error('MODEL_ENV_PATH_REQUIRED');
      const parsed = parseEnv(readFileSync(process.argv[modelFile + 1], 'utf8'));
      for (const [target, source] of [
        ['AGENT_KNOWLEDGE_HUB_LLM_BASE_URL', 'AGENT_OPT_MODEL_BASE_URL'],
        ['AGENT_KNOWLEDGE_HUB_LLM_MODEL', 'AGENT_OPT_MODEL_ID'],
        ['AGENT_KNOWLEDGE_HUB_LLM_API_KEY', 'AGENT_OPT_MODEL_API_KEY'],
      ]) { if (parsed[target] || parsed[source]) env[target] = parsed[target] || parsed[source]; }
      if (!env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL || !env.AGENT_KNOWLEDGE_HUB_LLM_MODEL) throw Error('MODEL_SETTINGS_INCOMPLETE');
    } else {
      // Keep configured keys across image redeploys without printing/serializing them to disk.
      try { const old = JSON.parse(k(['get', 'secret', 'knowledge-secrets', '-o', 'json'])); for (const [key, value] of Object.entries(old.data)) if (key.startsWith('AGENT_KNOWLEDGE_HUB_LLM_')) env[key] = Buffer.from(value, 'base64').toString(); } catch { /* first install: explicitly unconfigured */ }
    }
    apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'knowledge-secrets' }, type: 'Opaque', stringData: env });
    console.log('로컬 비밀 설정을 Kubernetes Secret에 주입했습니다. 값은 출력하지 않습니다.');
    console.log(run('docker', ['build', '-f', 'Dockerfile.server', '-t', 'knowledge-hub:dev', '.']));
    console.log(run('kind', ['load', 'docker-image', 'knowledge-hub:dev', '--name', cluster]));
    console.log(k(['apply', '-k', 'deploy/overlays/local']));
    console.log(k(['rollout', 'status', 'statefulset/knowledge-db', '--timeout=180s']));
    const jobName = `knowledge-migrate-${Date.now()}`;
    apply({ apiVersion:'batch/v1', kind:'Job', metadata:{name:jobName}, spec:{backoffLimit:0,ttlSecondsAfterFinished:3600,template:{metadata:{labels:{app:'knowledge-app'}},spec:{restartPolicy:'Never',automountServiceAccountToken:false,securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'migrate',image:'knowledge-hub:dev',imagePullPolicy:'IfNotPresent',command:['npm','run','db:migrate'],envFrom:[{secretRef:{name:'knowledge-secrets'}}],securityContext:{allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}},resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{cpu:'1',memory:'256Mi'}}}]}}}});
    console.log(k(['wait', `job/${jobName}`, '--for=condition=complete', '--timeout=120s']));
    console.log(k(['rollout', 'restart', 'deployment/knowledge-app']));
    console.log(k(['rollout', 'status', 'deployment/knowledge-app', '--timeout=240s']));
    console.log(k(['rollout', 'status', 'deployment/knowledge-keycloak', '--timeout=240s']));
    console.log('앱 http://localhost:28080 · Keycloak http://localhost:28081 · 합성 계정 reviewer/writer/reader, 비밀번호 local-test-only');
    console.log('로컬 클러스터는 NetworkPolicy 강제/사내 TLS·SSO·운영 백업 검증을 대신하지 않습니다.');
  } else if (command === 'status') console.log(k(['get', 'pods,pvc,jobs']));
  else if (command === 'logs') console.log(k(['logs', 'deployment/knowledge-app', '--tail=100']));
  else throw Error('Use: node scripts/k8s/local.mjs up [--model-env /absolute/path] | status | logs');
} catch (error) {
  // A child process may have received secrets via stdin. Never echo its command,
  // request body or environment on an error path.
  console.error(`로컬 환경 작업 실패 (${command}). 단계별 리소스 상태와 비밀을 제외한 로그를 확인하세요.`);
  if (error?.status) console.error(`하위 명령 종료 코드: ${error.status}`);
  process.exitCode = 1;
}
