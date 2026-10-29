import { randomUUID } from "node:crypto";
import { openStore } from "./store.mjs";
import {
  hash,
  readJsonBody,
  requireId,
  revision,
  safeError,
  serial,
  validatePage,
  MAX_BYTES,
} from "./protocol.mjs";

const equalContent = (a, b) =>
  hash({ ...a, version: 0 }) === hash({ ...b, version: 0 });
const key = (p) => `${p.spaceId}/${p.id}`;

export async function openClient({ directory, url, token, intervalMs = 5000 }) {
  const endpoint = new URL(url);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"))
  )
    throw Error("HTTPS_REQUIRED");
  if (typeof token !== "string" || !token || /[\r\n]/.test(token))
    throw Error("TOKEN_REQUIRED");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10)
    throw Error("VALIDATION_FAILED");
  const store = await openStore(directory),
    binding = hash([url, token]);
  let state;
  try {
    state = (await store.read()) ?? {
      schema: 1,
      binding,
      shared: [],
      personal: {},
      error: null,
      lastSync: null,
    };
    if (
      state.schema !== 1 ||
      !Array.isArray(state.shared) ||
      !state.personal ||
      typeof state.personal !== "object" ||
      Array.isArray(state.personal)
    )
      throw Error("CORRUPT_STATE");
    state.shared.forEach(validatePage);
    for (const [id, r] of Object.entries(state.personal)) {
      requireId(id);
      validatePage(r.draft);
      if (r.base) validatePage(r.base);
      if (r.incoming) validatePage(r.incoming);
      if (typeof r.dirty !== "boolean") throw Error("CORRUPT_STATE");
    }
    if (state.binding !== binding) throw Error("WORKSPACE_IDENTITY_MISMATCH");
    await store.write(state);
  } catch (e) {
    await store.close();
    throw e;
  }
  const queue = serial(),
    controller = new AbortController();
  let closed = false,
    timer,
    running = false;
  const persist = () => store.write(state);
  const status = () => ({
    pending: Object.values(state.personal).filter((r) => r.dirty).length,
    conflicts: Object.values(state.personal).filter((r) => r.incoming).length,
    error: state.error,
    lastSync: state.lastSync,
    mode: "connected-only",
    storage: "synthetic-development",
  });
  async function request(action, input = {}) {
    try {
      const body = JSON.stringify({ action, input });
      if (Buffer.byteLength(body) > MAX_BYTES) throw Error("PAYLOAD_TOO_LARGE");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      const result = await readJsonBody(response.body);
      if (!response.ok) throw Error(safeError({ message: result.error }));
      return result;
    } catch (e) {
      throw Error(safeError(e));
    }
  }
  function reconcile(snapshot) {
    if (
      !snapshot ||
      !Array.isArray(snapshot.shared) ||
      !Array.isArray(snapshot.personal)
    )
      throw Error("INVALID_RESPONSE");
    const shared = snapshot.shared.map(validatePage),
      personal = snapshot.personal.map(validatePage);
    if (
      personal.some((p) => p.spaceId !== "personal") ||
      shared.some((p) => p.spaceId === "personal")
    )
      throw Error("INVALID_RESPONSE");
    // Remove revoked content, including draft/conflict/proposal copies.
    for (const [id, r] of Object.entries(state.personal)) {
      if (
        (r.base && !personal.some((p) => p.id === id)) ||
        (r.draft.upstream &&
          !shared.some(
            (p) =>
              p.id === r.draft.upstream.pageId &&
              p.spaceId === r.draft.upstream.spaceId,
          ))
      )
        delete state.personal[id];
    }
    state.shared = shared;
    for (const remote of personal) {
      const r = state.personal[remote.id];
      if (!r || !r.dirty || equalContent(remote, r.draft)) {
        state.personal[remote.id] = {
          base: remote,
          draft: remote,
          dirty: false,
        };
      } else if (remote.version !== (r.base?.version ?? 0)) {
        if (r.incoming?.version !== remote.version) delete r.merge;
        r.incoming = remote;
      }
    }
  }
  async function snapshot() {
    reconcile(await request("snapshot"));
    await persist();
  }
  async function authorize() {
    const access = await request("access");
    if (
      !access ||
      !Array.isArray(access.shared) ||
      !Array.isArray(access.personal)
    )
      throw Error("INVALID_RESPONSE");
    const remoteKeys = new Map(
      [...access.shared, ...access.personal].map((p) => [key(p), p.version]),
    );
    const localPages = [
      ...state.shared,
      ...Object.values(state.personal)
        .filter((r) => r.base)
        .map((r) => r.incoming ?? r.base),
    ];
    if (
      remoteKeys.size !== localPages.length ||
      localPages.some((p) => remoteKeys.get(key(p)) !== p.version)
    )
      await snapshot();
  }
  async function sync() {
    await snapshot();
    for (const r of Object.values(state.personal)) {
      if (!r.dirty || r.incoming) continue;
      try {
        const remote = validatePage(
          await request("push", {
            mutationId: r.mutationId,
            baseVersion: r.base?.version ?? 0,
            page: r.draft,
          }),
        );
        r.base = remote;
        r.draft = remote;
        r.dirty = false;
        delete r.mutationId;
        delete r.priorConflict;
        await persist();
      } catch (e) {
        if (e.message !== "STALE_VERSION") throw e;
        await snapshot();
      }
    }
    state.lastSync = new Date().toISOString();
    state.error = null;
    await persist();
    return status();
  }
  function run(fn) {
    return queue(async () => {
      if (closed) throw Error("CLIENT_CLOSED");
      try {
        const result = await fn();
        return structuredClone(result);
      } catch (e) {
        state.error = safeError(e);
        await persist();
        throw Error(state.error);
      }
    });
  }
  function conflict(id) {
    requireId(id);
    const r = state.personal[id];
    if (!r) throw Error("NOT_FOUND");
    if (!r.incoming) throw Error("NO_CONFLICT");
    return r;
  }
  const client = {
    write(input) {
      return run(async () => {
        const p = validatePage(input),
          r = state.personal[p.id];
        if (
          r &&
          ((p.spaceId !== "personal" &&
            (r.draft.upstream?.spaceId !== p.spaceId ||
              r.draft.upstream?.pageId !== p.id)) ||
            (p.upstream && hash(p.upstream) !== hash(r.draft.upstream)))
        )
          throw Error("PAGE_ID_COLLISION");
        if (r?.incoming) throw Error("CONFLICT_REQUIRES_REVIEW");
        const upstream =
          r?.draft.upstream ??
          (p.spaceId !== "personal"
            ? state.shared.find((x) => x.id === p.id && x.spaceId === p.spaceId)
            : null);
        if (p.spaceId !== "personal" && !upstream) throw Error("NOT_FOUND");
        const draft = {
          ...p,
          spaceId: "personal",
          version: r?.base?.version ?? 0,
        };
        if (upstream)
          draft.upstream = r?.draft.upstream ?? {
            spaceId: upstream.spaceId,
            pageId: upstream.id,
            version: upstream.version,
          };
        state.personal[p.id] = {
          base: r?.base ?? null,
          draft,
          dirty: true,
          mutationId: randomUUID(),
        };
        await persist();
        return status();
      });
    },
    sync() {
      return run(sync);
    },
    read(id, spaceId = "personal") {
      return run(async () => {
        requireId(id);
        requireId(spaceId);
        await authorize();
        const r = spaceId === "personal" ? state.personal[id] : null;
        const page =
          r?.draft ??
          state.shared.find(
            (p) =>
              p.id === id && (spaceId === "personal" || p.spaceId === spaceId),
          );
        if (!page) throw Error("NOT_FOUND");
        return {
          page,
          pending: r?.dirty ?? false,
          conflict: Boolean(r?.incoming),
          kind: page.spaceId === "personal" ? "personal" : "shared",
        };
      });
    },
    search(query) {
      return run(async () => {
        if (typeof query !== "string" || query.length > 1000)
          throw Error("VALIDATION_FAILED");
        await authorize();
        const q = query.toLocaleLowerCase();
        return [
          ...state.shared,
          ...Object.values(state.personal).map((r) => r.draft),
        ]
          .filter((p) =>
            `${p.title}\n${p.content}`.toLocaleLowerCase().includes(q),
          )
          .slice(0, 50)
          .map((p) => ({
            id: p.id,
            spaceId: p.spaceId,
            title: p.title,
            version: p.version,
            kind: p.spaceId === "personal" ? "personal" : "shared",
            pending: p.spaceId === "personal" && state.personal[p.id].dirty,
          }));
      });
    },
    status() {
      return run(async () => status());
    },
    conflicts() {
      return run(async () => {
        await authorize();
        return Object.values(state.personal)
          .filter((r) => r.incoming)
          .map((r) => ({
            base: r.base,
            draft: r.draft,
            incoming: r.incoming,
            merge: r.merge,
          }));
      });
    },
    prepareMerge(id, content) {
      return run(async () => {
        await authorize();
        const r = conflict(id);
        const merged = validatePage({ ...r.draft, content });
        r.merge = {
          content: merged.content,
          hash: hash([id, r.base, r.draft, r.incoming, content]),
          incomingVersion: r.incoming.version,
        };
        await persist();
        return { ...r.merge, pageId: id, confirmation: "human-cli-required" };
      });
    },
    confirmMerge(id, expectedHash) {
      return run(async () => {
        await snapshot();
        const r = conflict(id);
        if (!r.merge || r.merge.hash !== expectedHash)
          throw Error("MERGE_CONFIRMATION_STALE");
        const merged = { ...r.draft, content: r.merge.content };
        r.priorConflict = {
          base: r.base,
          draft: r.draft,
          incoming: r.incoming,
        };
        r.base = r.incoming;
        r.draft = merged;
        r.mutationId = randomUUID();
        delete r.incoming;
        delete r.merge;
        await persist();
        try {
          const result = validatePage(
            await request("push", {
              mutationId: r.mutationId,
              baseVersion: r.base.version,
              page: merged,
            }),
          );
          r.base = result;
          r.draft = result;
          r.dirty = false;
          delete r.priorConflict;
          delete r.mutationId;
          await persist();
          return status();
        } catch (e) {
          if (e.message === "STALE_VERSION") {
            await snapshot();
            throw Error("MERGE_CONFIRMATION_STALE");
          }
          throw e;
        }
      });
    },
    propose(input) {
      return run(async () => {
        const selected = state.personal[input.pageId];
        if (!selected || selected.dirty || selected.incoming)
          throw Error("SYNC_REQUIRED");
        // Capture BEFORE refresh can replace a clean local snapshot.
        const personalVersion = revision(
          input.personalVersion ?? selected.base.version,
        );
        await authorize();
        const r = state.personal[input.pageId];
        if (!r || r.dirty || r.incoming) throw Error("SYNC_REQUIRED");
        if (r.base.version !== personalVersion)
          throw Error("STALE_PERSONAL_VERSION");
        return request("propose", { ...input, personalVersion });
      });
    },
    async start() {
      if (running || closed) return;
      running = true;
      const tick = async () => {
        if (!running) return;
        try {
          await client.sync();
        } catch {
          /* status preserves failure; no fake success */
        }
        if (running) timer = setTimeout(tick, intervalMs);
      };
      await tick();
    },
    async close() {
      if (closed) return;
      running = false;
      clearTimeout(timer);
      controller.abort();
      await queue(async () => {
        if (closed) return;
        closed = true;
        await store.close();
      });
    },
  };
  return client;
}
