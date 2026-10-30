export function splitRelease(resources) {
  const isApp = (r) =>
    r.kind === "Deployment" && r.metadata?.name === "knowledge-app";
  return {
    infrastructure: resources.filter((r) => !isApp(r)),
    application: resources.filter(isApp),
  };
}

const sameKind = (resources, kind, name) =>
  resources.filter((r) => r.kind === kind && r.metadata?.name === name);
const selectedApp = (policy) =>
  policy?.spec?.podSelector?.matchLabels?.app === "knowledge-app";
const selectedDB = (policy) =>
  policy?.spec?.podSelector?.matchLabels?.app === "knowledge-db";
const immutable = (image) =>
  typeof image === "string" && /^\S+@sha256:[0-9a-f]{64}$/.test(image);
const isOpenCidr = (value) => ["0.0.0.0/0", "::/0"].includes(value);
const isHttps = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.hostname.endsWith(".invalid") && !url.hash;
  } catch { return false; }
};

/** Static first-release guard, deliberately not a substitute for cluster acceptance. */
export function productionFailures(resources) {
  const failures = [];
  if (!Array.isArray(resources) || !resources.length)
    return ["empty resource set"];
  const app = sameKind(resources, "Deployment", "knowledge-app")[0];
  const db = sameKind(resources, "StatefulSet", "knowledge-db")[0];
  const namespace = app?.metadata?.namespace;
  if (!app || namespace === undefined)
    failures.push("application deployment or namespace missing");
  if (!["agent-knowledge-hub-stg", "agent-knowledge-hub-prod"].includes(namespace))
    failures.push("expected STG/PROD namespace required");
  if (app?.spec?.replicas !== 1 || app?.spec?.strategy?.type !== "Recreate")
    failures.push("initial release requires one app and explicit Recreate strategy");
  if (db?.spec?.replicas !== 1 ||
      !db.spec?.volumeClaimTemplates?.some((v) => v.metadata?.name === "data"))
    failures.push("one persistent PostgreSQL instance required");
  const namespaceResource = sameKind(resources, "Namespace", namespace);
  if (namespaceResource.length !== 1) failures.push("namespace resource missing");

  const namespacedKinds = new Set([
    "ConfigMap", "Service", "ServiceAccount", "Deployment", "StatefulSet",
    "PersistentVolumeClaim", "Ingress", "NetworkPolicy", "ResourceQuota",
    "Job", "CronJob", "Pod",
  ]);
  for (const r of resources) {
    if (r.kind === "Secret") failures.push("plaintext Secret in manifest");
    if (namespacedKinds.has(r.kind) && r.metadata?.namespace !== namespace)
      failures.push("cross-namespace or missing namespace: " + r.kind);
    const spec = r.spec?.jobTemplate?.spec?.template?.spec ??
      r.spec?.template?.spec ??
      (r.kind === "Pod" ? r.spec : null);
    for (const c of [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])])
      if (!immutable(c.image))
        failures.push("immutable image required: " + (c.image ?? "missing"));
    if (/CHANGE-ME|\.invalid|start-dev|local-test-only/.test(JSON.stringify(r)))
      failures.push("unconfigured/development resource: " +
        r.kind + "/" + (r.metadata?.name ?? ""));
  }
  for (const service of ["knowledge-db", "knowledge-app"])
    if (sameKind(resources, "Service", service).length !== 1)
      failures.push("required Service missing: " + service);

  if (app) {
    const pod = app.spec?.template?.spec;
    const container = pod?.containers?.find((c) => c.name === "app");
    if (!pod || pod.automountServiceAccountToken !== false ||
      !pod.securityContext?.runAsNonRoot || !container?.readinessProbe ||
      !container?.livenessProbe || !container?.startupProbe ||
      container?.securityContext?.readOnlyRootFilesystem !== true)
      failures.push("hardened application and health probes required");
    if (!container?.envFrom?.some((e) => e.secretRef?.name === "knowledge-secrets"))
      failures.push("external application Secret reference required");
  }
  if (db) {
    const postgres = db.spec?.template?.spec?.containers?.find((c) =>
      c.name === "postgres");
    if (!postgres?.env?.some((e) =>
      e.name === "POSTGRES_PASSWORD" &&
      e.valueFrom?.secretKeyRef?.name === "knowledge-db-secret"))
      failures.push("external database password Secret reference required");
  }

  const maps = resources.filter((r) => r.kind === "ConfigMap" &&
    r.metadata?.name?.startsWith("knowledge-config"));
  if (maps.length !== 1) failures.push("one runtime ConfigMap required");
  const config = maps[0]?.data;
  const origin = config?.APP_ORIGIN;
  try {
    const roles = JSON.parse(config?.OIDC_GROUP_ROLES ?? "null");
    if (!roles || !Object.keys(roles).length ||
      Object.values(roles).some((role) =>
        !["reader", "editor", "reviewer"].includes(role)))
      failures.push("OIDC group roles invalid");
  } catch { failures.push("OIDC group roles invalid"); }
  if (!config || config.NODE_ENV !== "production" ||
    !isHttps(origin) || !isHttps(config.OIDC_ISSUER) ||
    !config.OIDC_CLIENT_ID || !config.OIDC_GROUP_ROLES ||
    config.OIDC_ALLOW_HTTP === "true" ||
    config.OIDC_INTERNAL_URL)
    failures.push("production HTTPS authentication config required");
  let host;
  try {
    const url = new URL(origin);
    if (url.pathname !== "/" || url.search || url.hash)
      failures.push("APP_ORIGIN must not include a path or query");
    host = url.host;
  } catch { /* already rejected above */ }

  const ingresses = sameKind(resources, "Ingress", "knowledge-app");
  if (ingresses.length !== 1 || !ingresses[0].spec?.ingressClassName ||
    ingresses[0].spec?.tls?.length !== 1 ||
    !ingresses[0].spec.tls[0].secretName ||
    !ingresses[0].spec.tls[0].hosts?.includes(host) ||
    !ingresses[0].spec.rules?.some((r) => r.host === host &&
      r.http?.paths?.some((p) =>
        p.backend?.service?.name === "knowledge-app" &&
        p.backend?.service?.port?.number === 8080)))
    failures.push("TLS ingress and APP_ORIGIN host mismatch");

  const policies = resources.filter((r) => r.kind === "NetworkPolicy");
  const deny = policies.find((p) => p.metadata?.name === "default-deny");
  if (!deny || Object.keys(deny.spec?.podSelector ?? {}).length !== 0 ||
    !["Ingress", "Egress"].every((type) =>
      deny.spec?.policyTypes?.includes(type)) ||
    (deny.spec?.ingress?.length ?? 0) > 0 ||
    (deny.spec?.egress?.length ?? 0) > 0)
    failures.push("Ingress/Egress default deny network policy required");
  if (!policies.some((p) => selectedDB(p) &&
    p.spec?.ingress?.some((rule) =>
      rule.from?.some((x) => x.podSelector?.matchLabels?.app === "knowledge-app") &&
      rule.ports?.some((port) => port.port === 5432))))
    failures.push("application-to-database ingress permission missing");
  const ingressPolicy = policies.find((p) =>
    p.metadata?.name === "trusted-ingress-to-app" && selectedApp(p));
  if (!ingressPolicy?.spec?.ingress?.some((rule) =>
    rule.ports?.some((port) => port.port === 8080) &&
    rule.from?.some((from) => from.namespaceSelector?.matchLabels &&
      Object.keys(from.podSelector?.matchLabels ?? {}).length > 0)))
    failures.push("reviewed ingress-controller NetworkPolicy missing");
  const outbound = policies.find((p) =>
    p.metadata?.name === "reviewed-https-egress" && selectedApp(p));
  if (!outbound?.spec?.egress?.length ||
    !outbound.spec.egress.every((rule) =>
      rule.to?.length && rule.to.every((to) =>
        to.ipBlock?.cidr && !isOpenCidr(to.ipBlock.cidr)) &&
      rule.ports?.some((port) => port.protocol === "TCP" &&
        Number.isInteger(port.port) && port.port > 0 && port.port <= 65535)) ||
    !outbound.spec.egress.some((rule) =>
      rule.ports?.some((port) => port.protocol === "TCP" && port.port === 443)))
    failures.push("reviewed OIDC HTTPS egress NetworkPolicy missing");

  if (sameKind(resources, "ResourceQuota", "knowledge-resource-quota").length !== 1)
    failures.push("namespace ResourceQuota required");
  return [...new Set(failures)];
}
