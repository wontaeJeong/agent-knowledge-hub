import { z } from "zod";
import type { PoolClient } from "pg";
import type {
  StorageService,
  StorageManifest,
  StorageResource,
} from "./service";
import { KnowledgeService, type Context } from "../service";
import { loadState, readers, audit } from "../repository";
import { captureEnvelope, inheritedProvenance } from "../provenance";
import { digest } from "../publication";
import { current, type Draft } from "../../src/domain/wiki";
import { sha256, inspectContent } from "./content";
import { randomUUID } from "node:crypto";
const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
const submit = z
  .object({
    baseVersions: z.record(id, z.number().int().min(0)),
    sourceMap: z.record(id, id).default({}),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
type Submission = z.infer<typeof submit>;
const rewriteReference = (text: string, from: string, to: string) =>
  text.replace(
    new RegExp(
      from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-zA-Z0-9_-])",
      "g",
    ),
    to,
  );
type Archive = {
  id: string;
  status: string;
  manifest: StorageManifest;
  boundResources: StorageResource[];
  effectiveReaders: string[];
  scanApprovalTrusted: boolean;
  verificationTrusted: boolean;
  stagedBlobs: {
    id: string;
    sha256: string;
    size: number;
    scanState: string;
  }[];
};
export async function readImportArchive(
  host: StorageService,
  db: PoolClient,
  ctx: Context,
  archiveId: string,
): Promise<Archive> {
  const r = await db.query(
    "SELECT manifest FROM storage_imports WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 AND manifest->>'type'='import-proposal'",
    [ctx.workspaceId, id.parse(archiveId), ctx.principalId],
  );
  if (!r.rowCount) throw Error("NOT_FOUND");
  const stored = r.rows[0].manifest as Omit<Archive, "id" | "status">;
  for (const bound of stored.boundResources ?? [])
    await host.parent(db, ctx, bound);
  for (const p of [
    ...stored.manifest.pages.map((p) => ({ kind: "page" as const, id: p.id })),
    ...stored.manifest.sources.map((p) => ({
      kind: "source" as const,
      id: p.id,
    })),
  ]) {
    const exists = await db.query(
      "SELECT 1 FROM resources WHERE workspace_id=$1 AND kind=$2 AND id=$3",
      [ctx.workspaceId, p.kind, p.id],
    );
    if (exists.rowCount) await host.parent(db, ctx, p);
  }
  const mapped = await db.query(
    "SELECT target_id FROM storage_import_sources WHERE workspace_id=$1 AND import_id=$2",
    [ctx.workspaceId, archiveId],
  );
  for (const row of mapped.rows)
    await host.parent(db, ctx, { kind: "source", id: row.target_id });
  for (const blob of stored.manifest.blobs) {
    const exists = await db.query(
      "SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, blob.id],
    );
    if (exists.rowCount) await host.blob(db, ctx, blob.id);
  }
  const effect = await db.query(
    "SELECT result FROM storage_import_effects WHERE workspace_id=$1 AND import_id=$2",
    [ctx.workspaceId, archiveId],
  );
  for (const blobId of Object.values(effect.rows[0]?.result?.blobMap ?? {}))
    await host.blob(db, ctx, id.parse(blobId));
  return { id: archiveId, status: "proposed", ...stored } as Archive;
}
export class ImportWorkflow {
  constructor(readonly host: StorageService) {}
  private async personal(db: PoolClient, ctx: Context) {
    const r = await db.query(
      "SELECT 1 FROM access_spaces s JOIN access_namespaces n ON n.id=s.namespace_id JOIN access_principals p ON p.id=n.owner_id AND p.active AND p.kind='human' WHERE s.workspace_id=$1 AND s.active AND n.kind='personal' AND n.owner_id=$2",
      [ctx.workspaceId, ctx.principalId],
    );
    return !!r.rowCount;
  }
  private async source(
    db: PoolClient,
    ctx: Context,
    archive: Archive,
    original: StorageManifest["sources"][number],
    input: Submission,
    allowNew: boolean,
  ) {
    const mapped = await db.query(
      "SELECT target_id,content_hash FROM storage_import_sources WHERE workspace_id=$1 AND import_id=$2 AND original_id=$3",
      [ctx.workspaceId, archive.id, original.id],
    );
    const targetId =
      input.sourceMap[original.id] ?? mapped.rows[0]?.target_id ?? original.id;
    if (mapped.rowCount && targetId !== mapped.rows[0].target_id)
      throw Error("IDEMPOTENCY_CONFLICT");
    const target = await db.query(
      "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, targetId],
    );
    const content = z.string().min(1).max(100000).parse(original.data.content);
    if (!target.rowCount) {
      if (targetId !== original.id || !allowNew)
        throw Error("IMPORT_SOURCE_REGISTRATION_REQUIRED");
      return { targetId, content, isNew: true };
    }
    await this.host.parent(db, ctx, { kind: "source", id: targetId });
    await this.host.authorize(db, ctx, "source.create", {
      kind: "source",
      id: targetId,
    });
    const audience = await readers(db, ctx.workspaceId, "source", targetId);
    if (targetId === original.id) {
      if (target.rows[0].data.content !== content)
        throw Error("IMMUTABLE_SOURCE_MISMATCH");
    } else {
      const old = await db.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, original.id],
      );
      if (!old.rowCount || old.rows[0].data.content !== content)
        throw Error("IMPORT_SOURCE_REGISTRATION_REQUIRED");
      await this.host.parent(db, ctx, { kind: "source", id: original.id });
      const upper = await readers(db, ctx.workspaceId, "source", original.id);
      const proof = await db.query(
        "SELECT 1 FROM workflow_events WHERE workspace_id=$1 AND kind='source.correct' AND resource_id=$2 AND data->>'replacementId'=$3",
        [ctx.workspaceId, original.id, targetId],
      );
      if (!proof.rowCount || audience.some((who) => !upper.includes(who)))
        throw Error("SOURCE_SCOPE_CONFLICT");
    }
    if (audience.some((who) => !original.readers.includes(who)))
      throw Error("SOURCE_SCOPE_CONFLICT");
    if (
      mapped.rowCount &&
      mapped.rows[0].content_hash !== sha256(target.rows[0].data.content)
    )
      throw Error("IMMUTABLE_SOURCE_MISMATCH");
    return {
      targetId,
      content: target.rows[0].data.content as string,
      isNew: false,
    };
  }
  private async prepare(
    db: PoolClient,
    ctx: Context,
    archiveId: string,
    input: Submission,
    newBlobIds: Record<string, string>,
  ) {
    await this.host.authorize(db, ctx, "source.create");
    const archive = await readImportArchive(this.host, db, ctx, archiveId),
      personal = await this.personal(db, ctx),
      state = await loadState(db, ctx.workspaceId);
    if (!archive.manifest.pages.length) throw Error("NO_IMPORT_PAGES");
    if (archive.manifest.pages.length > 20) throw Error("IMPORT_BATCH_LIMIT");
    if (
      Object.keys(input.baseVersions).some(
        (pid) => !archive.manifest.pages.some((p) => p.id === pid),
      ) ||
      Object.keys(input.sourceMap).some(
        (sid) => !archive.manifest.sources.some((s) => s.id === sid),
      )
    )
      throw Error("INVALID_IMPORT_MAPPING");
    const sourceMap: Record<string, string> = Object.create(null),
      newSources = [];
    for (const original of archive.manifest.sources) {
      id.parse(original.id);
      const checked = await this.source(
        db,
        ctx,
        archive,
        original,
        input,
        personal,
      );
      sourceMap[original.id] = checked.targetId;
      if (checked.isNew) newSources.push({ original, ...checked });
    }
    const blobMap: Record<string, string> = {},
      blobPlans: {
        original: StorageManifest["blobs"][number];
        targetId: string;
        parent: StorageResource;
        isNew: boolean;
      }[] = [];
    for (const original of archive.manifest.blobs) {
      const existing = await db.query(
        "SELECT * FROM storage_blobs WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, original.id],
      );
      if (existing.rowCount) {
        const blob = await this.host.blob(db, ctx, original.id);
        if (
          blob.sha256 !== original.sha256 ||
          blob.mime !== original.mime ||
          blob.filename !== original.filename ||
          blob.parent_kind !== original.parent.kind ||
          blob.parent_id !== original.parent.id
        )
          throw Error("IMMUTABLE_BLOB_MISMATCH");
        if (blob.scan_state !== "clean") throw Error("SCAN_REQUIRED");
        if (original.attachment) {
          const version = await db.query(
            "SELECT slot_id,revision FROM storage_attachment_versions WHERE workspace_id=$1 AND blob_id=$2",
            [ctx.workspaceId, original.id],
          );
          if (
            version.rows[0]?.slot_id !== original.attachment.slotId ||
            version.rows[0]?.revision !== original.attachment.revision
          )
            throw Error("IMMUTABLE_ATTACHMENT_MISMATCH");
        }
        blobMap[original.id] = original.id;
        blobPlans.push({
          original,
          targetId: original.id,
          parent: original.parent,
          isNew: false,
        });
        continue;
      }
      const checked = inspectContent(
        Buffer.from(original.base64, "base64"),
        original.mime,
        original.filename,
      );
      if (checked.scanState !== "clean")
        throw Error("IMPORTED_BINARY_SCAN_REQUIRED");
      let parent: StorageResource;
      if (original.parent.kind === "source")
        parent = { kind: "source", id: sourceMap[original.parent.id] };
      else if (state.pages.some((p) => p.id === original.parent.id))
        parent = original.parent;
      else {
        if (!personal) throw Error("NEW_ID_IMPORT_PERSONAL_ONLY");
        const page = archive.manifest.pages.find(
          (p) => p.id === original.parent.id,
        );
        const refs = z.array(id).parse(page?.versions.at(-1)?.sourceIds);
        parent = { kind: "source", id: sourceMap[refs[0]] };
      }
      if (!parent.id) throw Error("INCOMPLETE_PROVENANCE");
      const originalAudience =
        original.parent.kind === "source"
          ? archive.manifest.sources.find((s) => s.id === original.parent.id)
              ?.readers
          : archive.manifest.pages.find((p) => p.id === original.parent.id)
              ?.readers;
      const exists = await db.query(
        "SELECT 1 FROM resources WHERE workspace_id=$1 AND kind=$2 AND id=$3",
        [ctx.workspaceId, parent.kind, parent.id],
      );
      if (exists.rowCount) {
        await this.host.parent(db, ctx, parent);
        const audience = await readers(
          db,
          ctx.workspaceId,
          parent.kind,
          parent.id,
        );
        if (audience.some((who) => !originalAudience?.includes(who)))
          throw Error("SOURCE_SCOPE_CONFLICT");
      }
      const targetId = (newBlobIds[original.id] ??= randomUUID());
      blobMap[original.id] = targetId;
      blobPlans.push({ original, targetId, parent, isNew: true });
    }
    const slotMap: Record<string, string> = {};
    for (const plan of blobPlans) {
      const key = plan.original.attachment?.slotId ?? plan.original.id;
      const group = blobPlans.filter(
        (p) => (p.original.attachment?.slotId ?? p.original.id) === key,
      );
      if (
        group.some(
          (p) =>
            p.isNew !== plan.isNew ||
            p.parent.kind !== plan.parent.kind ||
            p.parent.id !== plan.parent.id,
        )
      )
        throw Error("IMPORT_ATTACHMENT_CHAIN_CONFLICT");
      slotMap[key] = plan.isNew
        ? (newBlobIds["slot:" + key] ??= randomUUID())
        : (plan.original.attachment?.slotId ?? "");
    }
    const draftIds = new Set(archive.manifest.pages.map((p) => p.id)),
      dependencies = new Set<string>(),
      drafts: Draft[] = [];
    for (const p of archive.manifest.pages) {
      const old = state.pages.find((page) => page.id === p.id);
      const base = input.baseVersions[p.id];
      if (base === undefined) throw Error("BASE_VERSION_REQUIRED");
      if (old) {
        await this.host.parent(db, ctx, { kind: "page", id: p.id });
        await this.host.authorize(db, ctx, "changeset.propose", {
          kind: "page",
          id: p.id,
        });
        if (current(old).number !== base) throw Error("STALE_VERSION");
        dependencies.add(old.id);
      } else if (!personal || base !== 0)
        throw Error("NEW_ID_IMPORT_PERSONAL_ONLY");
      const versions = [...p.versions].sort(
          (a, b) => Number(a.number) - Number(b.number),
        ),
        latest = versions.at(-1)!;
      let content = z.string().min(1).max(100000).parse(latest.content);
      for (const [oldId, newId] of Object.entries(blobMap))
        content = rewriteReference(
          content,
          `/api/v1/storage/blobs/${oldId}`,
          `/api/v1/storage/blobs/${newId}`,
        );
      for (const plan of blobPlans) {
        const attachment = plan.original.attachment;
        if (!attachment) continue;
        content = rewriteReference(
          content,
          `/api/v1/storage/attachments/${attachment.slotId}/versions/${attachment.revision}`,
          `/api/v1/storage/blobs/${plan.targetId}`,
        );
      }
      for (const plan of blobPlans) {
        const attachment = plan.original.attachment;
        if (!attachment) continue;
        content = rewriteReference(
          content,
          `/api/v1/storage/attachments/${attachment.slotId}`,
          `/api/v1/storage/blobs/${blobMap[attachment.headId]}`,
        );
      }
      inspectContent(Buffer.from(content), "text/markdown", "import.md");
      const requiredSources = new Set<string>(),
        links = new Set<string>(z.array(id).parse(p.data.links ?? []));
      const pending = [p.id],
        seen = new Set<string>();
      // The entire imported archive is input to this proposal, not only its displayed latest body.
      for (const sourceId of Object.values(sourceMap))
        requiredSources.add(sourceId);
      while (pending.length) {
        const pid = pending.pop()!;
        if (seen.has(pid)) throw Error("IMPORT_TREE_CYCLE");
        seen.add(pid);
        const original = archive.manifest.pages.find((page) => page.id === pid);
        if (!original) throw Error("INCOMPLETE_PROVENANCE");
        for (const v of original.versions) {
          for (const sid of z.array(id).parse(v.sourceIds))
            requiredSources.add(sourceMap[sid]);
          if (v.provenance) {
            const a = z
              .object({ sourceIds: z.array(id), pageIds: z.array(id) })
              .parse(v.provenance);
            for (const sid of a.sourceIds) requiredSources.add(sourceMap[sid]);
            for (const dep of a.pageIds)
              if (state.pages.some((p) => p.id === dep)) dependencies.add(dep);
              else if (!draftIds.has(dep)) throw Error("INCOMPLETE_PROVENANCE");
          }
        }
        const parent = original.operational?.parent_id;
        if (parent) {
          const parentId = id.parse(parent);
          links.add(parentId);
          pending.push(parentId);
          if (state.pages.some((p) => p.id === parentId))
            dependencies.add(parentId);
        }
      }
      if (old) {
        for (const sid of inheritedProvenance(old).sourceIds)
          requiredSources.add(sid);
        for (const pid of inheritedProvenance(old).pageIds)
          dependencies.add(pid);
      }
      for (const blob of blobPlans) {
        if (blob.parent.kind === "source") requiredSources.add(blob.parent.id);
      }
      for (const link of links) {
        if (state.pages.some((p) => p.id === link)) dependencies.add(link);
        else if (!draftIds.has(link)) throw Error("INCOMPLETE_PROVENANCE");
      }
      if (!requiredSources.size || [...requiredSources].some((sid) => !sid))
        throw Error("INCOMPLETE_PROVENANCE");
      drafts.push({
        id: p.id,
        title: z.string().trim().min(1).max(300).parse(p.data.title),
        summary: z
          .string()
          .max(2000)
          .parse(p.data.summary ?? ""),
        content,
        scope: old?.scope ?? "private",
        links: [...links].filter((link) => link !== p.id),
        sourceIds: [...requiredSources],
        facts: [],
        baseVersion: base,
      });
    }
    return {
      archive,
      state,
      sourceMap,
      newSources,
      drafts,
      dependencies: [...dependencies],
      blobMap,
      blobPlans,
      slotMap,
    };
  }
  async propose(ctx: Context, archiveId: string, raw: unknown) {
    id.parse(archiveId);
    const input = submit.parse(raw),
      requestHash = digest(input);
    const newBlobIds: Record<string, string> = {};
    const existing = () =>
      this.host.run(ctx, "changeset.propose", undefined, async (db) => {
        await this.host.authorize(db, ctx, "source.create");
        await readImportArchive(this.host, db, ctx, archiveId);
        const r = await db.query(
          "SELECT request_hash,result FROM storage_import_effects WHERE workspace_id=$1 AND import_id=$2",
          [ctx.workspaceId, archiveId],
        );
        if (!r.rowCount) return null;
        if (r.rows[0].request_hash !== requestHash)
          throw Error("IDEMPOTENCY_CONFLICT");
        return r.rows[0].result as {
          id: string;
          hash: string;
          importId: string;
          sourceMap: Record<string, string>;
          blobMap: Record<string, string>;
          slotMap: Record<string, string>;
        };
      });
    const saved = await existing();
    if (saved) return saved;
    const initial = await this.host.run(
      ctx,
      "changeset.propose",
      undefined,
      (db) => this.prepare(db, ctx, archiveId, input, newBlobIds),
    );
    const core = new KnowledgeService(this.host.pool);
    for (const item of initial.newSources) {
      inspectContent(Buffer.from(item.content), "text/plain", "source.txt");
      z.string().min(1).max(300).parse(item.original.data.title);
    }
    for (const item of initial.newSources) {
      const bytes = Buffer.from(item.content);
      inspectContent(bytes, "text/plain", "source.txt");
      const source = {
        id: item.targetId,
        title: z.string().min(1).max(300).parse(item.original.data.title),
        tool: "akh-import",
        project: ctx.workspaceId,
        content: item.content,
        scope: "private" as const,
        verification: "미검증" as const,
        createdAt: new Date().toISOString(),
        processed: false,
        targetPageId: initial.drafts[0].id,
      };
      try {
        await core.registerSource(
          ctx,
          source,
          [ctx.principalId],
          async (db) => {
            await this.host.authorize(db, ctx, "source.create");
            if (!(await this.personal(db, ctx)))
              throw Error("NEW_ID_IMPORT_PERSONAL_ONLY");
            await readImportArchive(this.host, db, ctx, archiveId);
            const blob = await this.host.writeContent(db, bytes);
            await this.host.recheck(db, ctx, "source.create");
            await readImportArchive(this.host, db, ctx, archiveId);
            await db.query(
              "INSERT INTO storage_import_sources VALUES($1,$2,$3,$4,$5)",
              [
                ctx.workspaceId,
                archiveId,
                item.original.id,
                item.targetId,
                sha256(item.content),
              ],
            );
            const blobId = randomUUID();
            await db.query(
              "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,$2,'source',$3,$4,$5,'text/plain','source.txt','clean',$6)",
              [
                ctx.workspaceId,
                blobId,
                item.targetId,
                blob.sha256,
                blob.size,
                ctx.principalId,
              ],
            );
            await db.query(
              "INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash) VALUES($1,$2,$3,$4,$5)",
              [
                ctx.workspaceId,
                randomUUID(),
                item.targetId,
                blobId,
                blob.sha256,
              ],
            );
          },
        );
      } catch (error) {
        const mapped = await this.host.run(
          ctx,
          "changeset.propose",
          undefined,
          async (db) => {
            await readImportArchive(this.host, db, ctx, archiveId);
            const r = await db.query(
              "SELECT target_id FROM storage_import_sources WHERE workspace_id=$1 AND import_id=$2 AND original_id=$3",
              [ctx.workspaceId, archiveId, item.original.id],
            );
            return r.rows[0]?.target_id;
          },
        );
        if (mapped !== item.targetId) throw error;
      }
    }
    const prepared = await this.host.run(
      ctx,
      "changeset.propose",
      undefined,
      async (db) => {
        const p = await this.prepare(db, ctx, archiveId, input, newBlobIds);
        return {
          ...p,
          envelope: await captureEnvelope(db, ctx, p.state, p.dependencies, [
            ...new Set(p.drafts.flatMap((d) => d.sourceIds)),
          ]),
        };
      },
    );
    try {
      const result = await core.propose(
        ctx,
        prepared.drafts,
        [...new Set(prepared.drafts.flatMap((d) => d.sourceIds))],
        {
          expectedStateHash: digest(prepared.state),
          inputEnvelope: prepared.envelope,
          dependencyIds: prepared.dependencies,
          onCreated: async (db, result) => {
            let again = await this.prepare(
              db,
              ctx,
              archiveId,
              input,
              newBlobIds,
            );
            const prior = await db.query(
              "SELECT 1 FROM storage_import_effects WHERE workspace_id=$1 AND import_id=$2",
              [ctx.workspaceId, archiveId],
            );
            if (prior.rowCount) throw Error("IMPORT_ALREADY_PROPOSED");
            for (const plan of again.blobPlans)
              await this.host.writeContent(
                db,
                Buffer.from(plan.original.base64, "base64"),
              );
            await this.host.recheck(db, ctx, "changeset.propose");
            again = await this.prepare(db, ctx, archiveId, input, newBlobIds);
            for (const original of again.archive.manifest.sources) {
              const targetId = again.sourceMap[original.id];
              const row = await db.query(
                "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
                [ctx.workspaceId, targetId],
              );
              await db.query(
                "INSERT INTO storage_import_sources VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
                [
                  ctx.workspaceId,
                  archiveId,
                  original.id,
                  targetId,
                  sha256(row.rows[0].data.content),
                ],
              );
            }
            for (const plan of again.blobPlans) {
              if (!plan.isNew) continue;
              const b = plan.original;
              await this.host.parent(db, ctx, plan.parent);
              await db.query(
                "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'clean',$9)",
                [
                  ctx.workspaceId,
                  plan.targetId,
                  plan.parent.kind,
                  plan.parent.id,
                  b.sha256,
                  Buffer.from(b.base64, "base64").length,
                  b.mime,
                  b.filename,
                  ctx.principalId,
                ],
              );
            }
            const createdSlots = new Set<string>();
            for (const plan of again.blobPlans) {
              if (!plan.isNew) continue;
              const b = plan.original,
                a = b.attachment,
                key = a?.slotId ?? b.id,
                slotId = again.slotMap[key];
              if (!createdSlots.has(slotId)) {
                createdSlots.add(slotId);
                await db.query(
                  "INSERT INTO storage_attachment_slots(workspace_id,id,parent_kind,parent_id,head_id,revision) VALUES($1,$2,$3,$4,$5,$6)",
                  [
                    ctx.workspaceId,
                    slotId,
                    plan.parent.kind,
                    plan.parent.id,
                    a ? again.blobMap[a.headId] : plan.targetId,
                    a?.headRevision ?? 1,
                  ],
                );
              }
              await db.query(
                "INSERT INTO storage_attachment_versions VALUES($1,$2,$3,$4)",
                [ctx.workspaceId, slotId, a?.revision ?? 1, plan.targetId],
              );
            }
            await db.query(
              "INSERT INTO storage_import_effects(workspace_id,import_id,principal_id,request_hash,batch_id,batch_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)",
              [
                ctx.workspaceId,
                archiveId,
                ctx.principalId,
                requestHash,
                result.id,
                result.hash,
                {
                  ...result,
                  importId: archiveId,
                  sourceMap: again.sourceMap,
                  blobMap: again.blobMap,
                  slotMap: again.slotMap,
                  reason: input.reason,
                },
              ],
            );
            await audit(db, ctx, "storage.import.submit", archiveId);
          },
        },
      );
      await ctx.authorization?.revalidate();
      return {
        ...result,
        importId: archiveId,
        sourceMap: prepared.sourceMap,
        blobMap: prepared.blobMap,
        slotMap: prepared.slotMap,
      };
    } catch (error) {
      const recovered = await existing();
      if (recovered) return recovered;
      throw error;
    }
  }
}
