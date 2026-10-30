import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { productionFailures, splitRelease } from "./release.mjs";

const expectedNamespace = (environment) => {
  if (!["stg", "prod"].includes(environment))
    throw Error("STG_OR_PROD_REQUIRED");
  return "agent-knowledge-hub-" + environment;
};
const decode = (secret, key) => {
  const encoded = secret?.data?.[key];
  if (typeof encoded !== "string" || !encoded.length) return null;
  return Buffer.from(encoded, "base64").toString("utf8");
};

/** Never emit secret content or a URL with credentials in errors. */
export function liveSecretFailures(secrets, expectedTLS) {
  const errors = [];
  const app = secrets?.app;
  const db = secrets?.db;
  const tls = secrets?.tls;
  const dbPassword = decode(db, "password");
  if (!dbPassword || dbPassword.length < 16)
    errors.push("database password Secret is missing or too short");
  const clientSecret = decode(app, "OIDC_CLIENT_SECRET");
  if (!clientSecret || clientSecret === "local-test-only" || clientSecret.length < 12)
    errors.push("production OIDC client secret missing");
  const connection = decode(app, "DATABASE_URL");
  try {
    if (!connection) throw Error("MISSING");
    const url = new URL(connection);
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      url.username !== "knowledge" ||
      url.hostname !== "knowledge-db" ||
      (url.port && url.port !== "5432") ||
      url.pathname !== "/knowledge" ||
      decodeURIComponent(url.password) !== dbPassword ||
      url.searchParams.size > 0 || url.hash)
      errors.push("application DATABASE_URL does not match the namespace database");
  } catch {
    errors.push("application DATABASE_URL is absent or invalid");
  }
  if (tls?.type !== "kubernetes.io/tls" ||
    !decode(tls, "tls.crt") || !decode(tls, "tls.key") ||
    !expectedTLS)
    errors.push("TLS Secret is missing or invalid");
  if (app?.type !== "Opaque" || db?.type !== "Opaque")
    errors.push("application/database Secret types invalid");
  return errors;
}

export function migrationJob(app, suffix) {
  const pod = structuredClone(app.spec.template.spec);
  const container = pod.containers.find((c) => c.name === "app");
  if (!container) throw Error("APP_CONTAINER_MISSING");
  delete container.readinessProbe;
  delete container.livenessProbe;
  delete container.startupProbe;
  delete container.ports;
  container.command = ["npm", "run", "db:migrate"];
  delete container.args;
  pod.restartPolicy = "Never";
  // Shared app label permits the existing app-to-db NetworkPolicy, not ingress.
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: "knowledge-migrate-" + suffix,
      namespace: app.metadata.namespace,
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 86400,
      template: { metadata: { labels: { app: "knowledge-app" } }, spec: pod },
    },
  };
}

export function rolloutPlan(resources) {
  const failures = productionFailures(resources);
  if (failures.length) throw Error("PRODUCTION_PREFLIGHT_FAILED: " + failures.join("; "));
  const split = splitRelease(resources);
  if (split.application.length !== 1) throw Error("SINGLE_APP_REQUIRED");
  return {
    namespace: split.application[0].metadata.namespace,
    image: split.application[0].spec.template.spec.containers
      .find((c) => c.name === "app").image,
    ...split,
  };
}

/** Explicit context + apply flag; no implicit current-context production release. */
export function deploySite({ context, environment, site, apply = false, approveProd = false },
  executor = execFileSync) {
  const namespace = expectedNamespace(environment);
  if (!context || /\s/.test(context) || context.startsWith("-"))
    throw Error("EXPLICIT_CONTEXT_REQUIRED");
  const run = (args, input) => executor("kubectl", args, {
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const render = run(["kustomize", site]);
  const resources = parseAllDocuments(render).map((doc) => {
    if (doc.errors.length) throw Error("INVALID_KUSTOMIZE_YAML");
    return doc.toJSON();
  }).filter(Boolean);
  const plan = rolloutPlan(resources);
  if (plan.namespace !== namespace) throw Error("ENVIRONMENT_NAMESPACE_MISMATCH");
  if (!apply) return { status: "validated", namespace, image: plan.image };
  if (environment === "prod" && !approveProd)
    throw Error("EXPLICIT_PRODUCTION_APPROVAL_REQUIRED");

  const kube = (args, input) =>
    run(["--context", context, "-n", namespace, ...args], input);
  // Preflight all secrets before applying infrastructure, without logging contents.
  kube(["get", "namespace", namespace, "-o", "name"]);
  const ingress = resources.find((r) =>
    r.kind === "Ingress" && r.metadata.name === "knowledge-app");
  const tlsName = ingress.spec.tls[0].secretName;
  const readSecret = (name) =>
    JSON.parse(kube(["get", "secret", name, "-o", "json"]));
  const failures = liveSecretFailures({
    app: readSecret("knowledge-secrets"),
    db: readSecret("knowledge-db-secret"),
    tls: readSecret(tlsName),
  }, tlsName);
  if (failures.length) throw Error("LIVE_SECRETS_INVALID: " + failures.join("; "));

  if (environment === "prod") {
    const stage = JSON.parse(run(["--context", context, "-n",
      "agent-knowledge-hub-stg", "get", "deployment", "knowledge-app",
      "-o", "json"]));
    const promoted = stage.spec?.template?.spec?.containers?.find((c) =>
      c.name === "app")?.image;
    if (promoted !== plan.image)
      throw Error("APP_IMAGE_NOT_PROMOTED_FROM_STG");
  }

  kube(["apply", "-f", "-"], JSON.stringify({
    apiVersion: "v1", kind: "List", items: plan.infrastructure,
  }));
  kube(["rollout", "status", "statefulset/knowledge-db", "--timeout=240s"]);
  const job = migrationJob(plan.application[0],
    Date.now() + "-" + randomBytes(3).toString("hex"));
  kube(["create", "-f", "-"], JSON.stringify(job));
  kube(["wait", "--for=condition=complete",
    "job/" + job.metadata.name, "--timeout=240s"]);
  kube(["apply", "-f", "-"], JSON.stringify({
    apiVersion: "v1", kind: "List", items: plan.application,
  }));
  kube(["rollout", "status", "deployment/knowledge-app", "--timeout=240s"]);
  return { status: "deployed", namespace, image: plan.image,
    migrationJob: job.metadata.name };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [context, environment, site, ...flags] = process.argv.slice(2);
  try {
    if (!site || flags.some((f) => !["--apply", "--approve-prod"].includes(f)))
      throw Error("Usage: node scripts/k8s/deploy-site.mjs CONTEXT stg|prod SITE_DIR [--apply] [--approve-prod]");
    const result = deploySite({
      context, environment, site,
      apply: flags.includes("--apply"),
      approveProd: flags.includes("--approve-prod"),
    });
    console.log(JSON.stringify(result));
    console.log("Static checks do not verify CNI enforcement, SSO login, backup restoration or load acceptance.");
  } catch (error) {
    // kubectl failures can contain credentials from stdin; never print thrown
    // child-process output/command or a DATABASE_URL.
    const safe = error instanceof Error && !("status" in error) ?
      error.message : "KUBERNETES_COMMAND_FAILED";
    console.error(safe);
    process.exitCode = 1;
  }
}
