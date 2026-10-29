import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { State, Page, Version } from "../src/domain/types";
import { current } from "../src/domain/wiki";
import { readers } from "./repository";
import type { Context } from "./service";

export interface Provenance {
  pageIds: string[];
  sourceIds: string[];
}
export interface InputEnvelope extends Provenance {
  pages: Record<string, string>;
  sources: Record<string, string>;
  acl: Record<string, string[]>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const versionProvenance = (version: Version): Provenance =>
  (version as Version & { provenance?: Provenance }).provenance ?? {
    pageIds: [],
    sourceIds: [],
  };
export const inheritedProvenance = (page: Page): Provenance => ({
  pageIds: [
    ...new Set(page.versions.flatMap((v) => versionProvenance(v).pageIds)),
  ],
  sourceIds: [
    ...new Set(
      page.versions.flatMap((v) => [
        ...v.sourceIds,
        ...versionProvenance(v).sourceIds,
      ]),
    ),
  ],
});
export async function visiblePageIds(
  db: PoolClient,
  ctx: Context,
  state: State,
): Promise<Set<string>> {
  const allowed = async (kind: string, id: string) =>
    (await readers(db, ctx.workspaceId, kind, id)).includes(ctx.principalId);
  const known = new Set(state.pages.map((p) => p.id));
  let visible = new Set<string>();
  for (const p of state.pages) {
    const provenance = inheritedProvenance(p);
    if (!(await allowed("page", p.id))) continue;
    let ok = true;
    for (const id of new Set([
      ...current(p).sourceIds,
      ...provenance.sourceIds,
    ]))
      if (!(await allowed("source", id))) ok = false;
    if (ok) visible.add(p.id);
  }
  for (;;) {
    const next = new Set(visible);
    for (const p of state.pages) {
      if (!visible.has(p.id)) continue;
      const provenance = inheritedProvenance(p);
      if (
        provenance.pageIds.some((id) => !visible.has(id)) ||
        (p.links ?? []).some((id) => known.has(id) && !visible.has(id))
      )
        next.delete(p.id);
    }
    if (next.size === visible.size) return next;
    visible = next;
  }
}
/** Capture all influencing context, including transitive pages and independently mutable ACLs. Never send to clients. */
export async function captureEnvelope(
  db: PoolClient,
  ctx: Context,
  state: State,
  pageIds: string[],
  sourceIds: string[] = [],
): Promise<InputEnvelope> {
  const visible = await visiblePageIds(db, ctx, state);
  const pages = new Set<string>();
  const sources = new Set(sourceIds);
  const pending = [...pageIds];
  while (pending.length) {
    const id = pending.pop()!;
    if (pages.has(id)) continue;
    const p = state.pages.find((p) => p.id === id);
    if (!p || !visible.has(id)) throw Error("STALE_VERSION");
    pages.add(id);
    const inherited = inheritedProvenance(p);
    for (const id of [...current(p).sourceIds, ...inherited.sourceIds])
      sources.add(id);
    pending.push(
      ...inherited.pageIds,
      ...(p.links ?? []).filter((id) => state.pages.some((p) => p.id === id)),
    );
  }
  const envelope: InputEnvelope = {
    pageIds: [...pages].sort(),
    sourceIds: [...sources].sort(),
    pages: {},
    sources: {},
    acl: {},
  };
  for (const id of envelope.pageIds) {
    envelope.pages[id] = fingerprint(state.pages.find((p) => p.id === id)!);
    envelope.acl["page:" + id] = (
      await readers(db, ctx.workspaceId, "page", id)
    ).sort();
  }
  for (const id of envelope.sourceIds) {
    const source = state.sources.find((s) => s.id === id);
    const acl = (await readers(db, ctx.workspaceId, "source", id)).sort();
    if (!source || !acl.includes(ctx.principalId)) throw Error("STALE_VERSION");
    envelope.sources[id] = fingerprint(source);
    envelope.acl["source:" + id] = acl;
  }
  return envelope;
}
export async function assertEnvelope(
  db: PoolClient,
  ctx: Context,
  state: State,
  envelope: InputEnvelope,
) {
  const fresh = await captureEnvelope(
    db,
    ctx,
    state,
    envelope.pageIds,
    envelope.sourceIds,
  );
  if (fingerprint(fresh) !== fingerprint(envelope))
    throw Error("STALE_VERSION");
}
