export function splitRelease(resources) {
  const isApp = (r) =>
    r.kind === "Deployment" && r.metadata?.name === "knowledge-app";
  return {
    infrastructure: resources.filter((r) => !isApp(r)),
    application: resources.filter(isApp),
  };
}
export function productionFailures(resources) {
  const failures = [];
  if (!resources.length) failures.push("empty resource set");
  const app = resources.find(
    (r) => r.kind === "Deployment" && r.metadata?.name === "knowledge-app",
  );
  if (!app) failures.push("application deployment missing");
  for (const r of resources) {
    if (r.kind === "Secret") failures.push("plaintext Secret in manifest");
    const spec =
      r.spec?.jobTemplate?.spec?.template?.spec ??
      r.spec?.template?.spec ??
      (r.kind === "Pod" ? r.spec : null);
    for (const c of [
      ...(spec?.containers ?? []),
      ...(spec?.initContainers ?? []),
    ])
      if (
        typeof c.image !== "string" ||
        !/^\S+@sha256:[0-9a-f]{64}$/.test(c.image)
      )
        failures.push(`immutable image required: ${c.image ?? "missing"}`);
    if (/CHANGE-ME|\.invalid|start-dev|local-test-only/.test(JSON.stringify(r)))
      failures.push(
        `unconfigured/development resource: ${r.kind}/${r.metadata?.name ?? ""}`,
      );
  }
  const ingress = resources.filter((r) => r.kind === "Ingress");
  if (
    !ingress.length ||
    ingress.some(
      (r) =>
        !r.spec?.tls?.length ||
        r.spec.tls.some((t) => !t.secretName || !t.hosts?.length),
    )
  )
    failures.push("TLS ingress missing");
  if (
    !resources.some(
      (r) => r.kind === "NetworkPolicy" && r.metadata?.name === "default-deny",
    )
  )
    failures.push("default deny network policy missing");
  for (const r of resources.filter(
    (r) =>
      r.kind === "ConfigMap" &&
      r.metadata?.name?.startsWith("knowledge-config"),
  )) {
    if (
      r.data?.NODE_ENV !== "production" ||
      !r.data?.APP_ORIGIN?.startsWith("https://") ||
      !r.data?.OIDC_ISSUER?.startsWith("https://") ||
      r.data?.OIDC_ALLOW_HTTP === "true" ||
      r.data?.OIDC_INTERNAL_URL
    )
      failures.push("production HTTPS authentication config required");
  }
  return [...new Set(failures)];
}
