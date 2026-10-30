import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Create a non-secret, reproducible STG/PROD Kustomize site overlay.
 * The checked-in overlays intentionally cannot be deployed unconfigured.
 */
const topKeys = new Set([
  "environment", "appHost", "ingressClass", "tlsSecretName",
  "oidcIssuer", "oidcClientId", "appImage", "postgresImage",
  "ingressController", "oidcEgressCidrs", "modelEgressCidrs",
  "quota", "dbStorageClass",
]);

function requireField(condition, message) {
  if (!condition) throw Error(message);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function name(value) {
  return typeof value === "string" &&
    value.length <= 253 &&
    /^(?!-)[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value);
}
function hostname(value) {
  return name(value) && value.includes(".") &&
    !value.endsWith(".invalid") && !value.endsWith(".local") &&
    !value.includes("..") && !value.includes("localhost");
}
function imageDigest(value) {
  const match = typeof value === "string" &&
    value.match(/^([^\s@]+)@sha256:([a-f0-9]{64})$/);
  requireField(match && !match[1].includes("CHANGE-ME"), "IMAGE_DIGEST_REQUIRED");
  return { name: match[1], digest: "sha256:" + match[2] };
}
function cidr(value) {
  if (typeof value !== "string") return false;
  const [address, prefix, ...extra] = value.split("/");
  const version = isIP(address);
  if (!version || extra.length || !/^\d+$/.test(prefix || "")) return false;
  const size = Number(prefix);
  return size > 0 && size <= (version === 4 ? 32 : 128);
}
function cidrs(value, required) {
  requireField(Array.isArray(value) && (!required || value.length > 0) &&
    value.every(cidr) && new Set(value).size === value.length, "EGRESS_CIDR_INVALID");
}
function labels(value) {
  return object(value) && Object.keys(value).length > 0 &&
    Object.entries(value).every(([key, val]) =>
      /^[a-z0-9A-Z./_-]{1,253}$/.test(key) &&
      typeof val === "string" && /^[a-z0-9A-Z._-]{1,63}$/.test(val)
    );
}
function quantity(value) {
  return typeof value === "string" && /^[1-9]\d*(m|Ki|Mi|Gi|Ti)?$/.test(value);
}

export function validateSiteConfig(config) {
  requireField(object(config) &&
    Object.keys(config).every((key) => topKeys.has(key)), "SITE_FIELDS_INVALID");
  requireField(["stg", "prod"].includes(config.environment), "ENVIRONMENT_INVALID");
  requireField(hostname(config.appHost), "APP_HOST_INVALID");
  requireField(name(config.ingressClass) && !config.ingressClass.includes("CHANGE-ME"),
    "INGRESS_CLASS_INVALID");
  requireField(name(config.tlsSecretName), "TLS_SECRET_NAME_INVALID");
  let issuer;
  try { issuer = new URL(config.oidcIssuer); } catch { /* validate below */ }
  requireField(issuer && issuer.protocol === "https:" &&
    hostname(issuer.hostname) && !issuer.username && !issuer.password &&
    !issuer.search && !issuer.hash, "OIDC_ISSUER_INVALID");
  requireField(typeof config.oidcClientId === "string" &&
    config.oidcClientId.length > 0 && config.oidcClientId.length <= 128 &&
    !/CHANGE-ME|local-test-only/.test(config.oidcClientId), "OIDC_CLIENT_ID_INVALID");
  imageDigest(config.appImage);
  imageDigest(config.postgresImage);
  requireField(object(config.ingressController) &&
    name(config.ingressController.namespace) &&
    labels(config.ingressController.podLabels), "INGRESS_CONTROLLER_SELECTOR_REQUIRED");
  cidrs(config.oidcEgressCidrs, true);
  cidrs(config.modelEgressCidrs ?? [], false);
  const quota = config.quota;
  requireField(object(quota) &&
    Object.keys(quota).sort().join(",") ===
      "limitsCpu,limitsMemory,requestsCpu,requestsMemory,storage" &&
    Object.values(quota).every(quantity), "RESOURCE_QUOTA_INVALID");
  if (config.dbStorageClass !== undefined)
    requireField(name(config.dbStorageClass), "STORAGE_CLASS_INVALID");
  return config;
}
function json(value) { return JSON.stringify(value, null, 2) + "\n"; }
function policy(name, namespace, selector, direction, rules) {
  return {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
    metadata: { name, namespace },
    spec: { podSelector: { matchLabels: { app: "knowledge-app" } },
      policyTypes: [direction], [direction.toLowerCase()]: rules },
  };
}

export function siteFiles(input) {
  const config = validateSiteConfig(input);
  const namespace = "agent-knowledge-hub-" + config.environment;
  const appImage = imageDigest(config.appImage);
  const postgresImage = imageDigest(config.postgresImage);
  const kustomization = [
    "apiVersion: kustomize.config.k8s.io/v1beta1",
    "kind: Kustomization",
    "namespace: " + namespace,
    "resources:",
    "  - ../../overlays/" + config.environment,
    "  - ingress-access.json",
    "  - external-egress.json",
    "  - quota.json",
    "patches:",
    "  - path: ingress-patch.json",
    ...(config.dbStorageClass ? [
      "  - path: db-storage-patch.json",
      "    target:",
      "      kind: StatefulSet",
      "      name: knowledge-db",
    ] : []),
    "configMapGenerator:",
    "  - name: knowledge-config",
    "    behavior: merge",
    "    literals:",
    "      - " + JSON.stringify("APP_ORIGIN=https://" + config.appHost),
    "      - " + JSON.stringify("OIDC_ISSUER=" + config.oidcIssuer),
    "      - " + JSON.stringify("OIDC_CLIENT_ID=" + config.oidcClientId),
    "images:",
    "  - name: knowledge-hub",
    "    newName: " + JSON.stringify(appImage.name),
    "    digest: " + appImage.digest,
    "  - name: postgres",
    "    newName: " + JSON.stringify(postgresImage.name),
    "    digest: " + postgresImage.digest,
    "",
  ].join("\n");
  const ingress = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name: "knowledge-app" },
    spec: {
      ingressClassName: config.ingressClass,
      tls: [{ hosts: [config.appHost], secretName: config.tlsSecretName }],
      rules: [{
        host: config.appHost,
        http: { paths: [{ path: "/", pathType: "Prefix", backend: {
          service: { name: "knowledge-app", port: { number: 8080 } },
        } }] },
      }],
    },
  };
  const ingressPolicy = policy("trusted-ingress-to-app", namespace, "knowledge-app",
    "Ingress", [{
      from: [{
        namespaceSelector: { matchLabels: {
          "kubernetes.io/metadata.name": config.ingressController.namespace,
        } },
        podSelector: { matchLabels: config.ingressController.podLabels },
      }],
      ports: [{ protocol: "TCP", port: 8080 }],
    }]);
  const outbound = [
    ...config.oidcEgressCidrs.map((block) => ({ to: [{ ipBlock: { cidr: block } }],
      ports: [{ protocol: "TCP", port: 443 }] })),
    ...(config.modelEgressCidrs ?? []).map((block) => ({ to: [{ ipBlock: { cidr: block } }],
      ports: [{ protocol: "TCP", port: 443 }] })),
  ];
  const egressPolicy = policy("reviewed-https-egress", namespace, "knowledge-app",
    "Egress", outbound);
  const quota = {
    apiVersion: "v1", kind: "ResourceQuota",
    metadata: { name: "knowledge-resource-quota", namespace },
    spec: { hard: {
      "requests.cpu": config.quota.requestsCpu,
      "requests.memory": config.quota.requestsMemory,
      "limits.cpu": config.quota.limitsCpu,
      "limits.memory": config.quota.limitsMemory,
      "requests.storage": config.quota.storage,
      "count/persistentvolumeclaims": "4",
      pods: "8",
    } },
  };
  return {
    "kustomization.yaml": kustomization,
    "ingress-patch.json": json(ingress),
    "ingress-access.json": json(ingressPolicy),
    "external-egress.json": json(egressPolicy),
    "quota.json": json(quota),
    ...(config.dbStorageClass ? {
      "db-storage-patch.json": json([{
        op: "add",
        path: "/spec/volumeClaimTemplates/0/spec/storageClassName",
        value: config.dbStorageClass,
      }]),
    } : {}),
  };
}

export function writeSite(config, outputRoot) {
  const validated = validateSiteConfig(config);
  const target = resolve(outputRoot, validated.environment);
  // Refuse to overwrite an existing site (may contain manually reviewed edits).
  mkdirSync(target, { recursive: false });
  const files = siteFiles(validated);
  for (const [name, content] of Object.entries(files))
    writeFileSync(resolve(target, name), content, { flag: "wx", mode: 0o644 });
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [configPath, outputRoot = "deploy/sites"] = process.argv.slice(2);
    if (!configPath) throw Error("Usage: node scripts/k8s/prepare-site.mjs SITE.json [OUTPUT_ROOT]");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const target = writeSite(config, outputRoot);
    console.log("Non-secret overlay created: " + target);
    console.log("Review NetworkPolicy selectors and CIDRs on the target CNI before deployment.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SITE_PREPARATION_FAILED");
    process.exitCode = 1;
  }
}
