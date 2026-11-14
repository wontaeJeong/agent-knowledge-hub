import { createHash, randomUUID } from "node:crypto";
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const digest = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
/** Host-side only. Explicit reviewer callback and current authenticated sessions are required. */
export function createRuntimeHttpDriver({
  baseUrl,
  editorHeaders,
  reviewerHeaders,
  review,
  usage,
  fetchImpl = fetch,
}) {
  const origin = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    typeof review !== "function"
  )
    throw Error("EVALUATION_CONFIG_INVALID");
  async function request(path, headers, body, key, signal) {
    const res = await fetchImpl(new URL("/api/v1" + path, origin), {
      method: body === undefined ? "GET" : "POST",
      signal,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      let code = "REQUEST_FAILED";
      try {
        const data = await res.json();
        if (typeof data.code === "string" && /^[A-Z_]{1,80}$/.test(data.code))
          code = data.code;
      } catch {}
      throw Error(code);
    }
    if (res.status === 202) throw Error("ASYNC_RUNTIME_UNSUPPORTED");
    return res.json();
  }
  const editor = (path, body, key, signal) =>
      request(path, editorHeaders, body, key, signal),
    reviewer = (path, body, key) => request(path, reviewerHeaders, body, key);
  return {
    async verifyModel(model, provider) {
      const data = await editor("/model");
      if (
        !data.configured ||
        data.model !== model ||
        (provider && data.provider !== provider)
      )
        throw Error("MODEL_MISMATCH");
    },
    async verifyActors() {
      const [a, b] = await Promise.all([editor("/me"), reviewer("/me")]);
      if (
        !a.principalId ||
        !b.principalId ||
        a.principalId === b.principalId ||
        a.workspaceId !== b.workspaceId
      )
        throw Error("EVALUATION_IDENTITIES_INVALID");
      return {
        workspaceId: a.workspaceId,
        editor: a.principalId,
        reviewer: b.principalId,
      };
    },
    async sources() {
      const data = await editor("/sources");
      return data.items.map((s) => ({
        id: s.id,
        version: digest(s),
        content: s.content,
      }));
    },
    async pages() {
      const data = await editor("/pages");
      return data.items
        .filter((p) => p.currentRecommendation)
        .map((p) => ({
          id: p.id,
          version: p.version,
          content: p.content,
          kind: "wiki",
        }));
    },
    ingest: (ids, signal) =>
      editor(
        "/ingest",
        { sourceIds: ids, mode: "model" },
        randomUUID(),
        signal,
      ),
    review,
    approve: (p) =>
      reviewer(`/changesets/${encodeURIComponent(p.id)}/approve`, {
        hash: p.hash,
      }),
    reject: (p) =>
      reviewer(`/changesets/${encodeURIComponent(p.id)}/reject`, {
        hash: p.hash,
      }),
    publish: (p) =>
      reviewer(
        `/changesets/${encodeURIComponent(p.id)}/publish`,
        { hash: p.hash },
        `evaluation-${p.id}`,
      ),
    query: (question, signal) =>
      editor("/query", { question, mode: "model" }, randomUUID(), signal),
    lint: () => editor("/lint", {}, randomUUID()),
    usageMark: () => usage?.mark?.() ?? Promise.resolve(null),
    usageSince: (mark) =>
      usage?.since?.(mark) ?? Promise.resolve({ cost: null }),
  };
}
