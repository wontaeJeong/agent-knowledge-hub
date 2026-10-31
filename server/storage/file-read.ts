import type { PoolClient } from "pg";
import { Lexer, walkTokens } from "marked";
import { AccessService, effectiveAccess } from "../access/index";
import { transaction } from "../database";
import { membership, requireRead, audit } from "../repository";
import type { Context } from "../service";
import type { StorageService } from "./service";
type Blob = Awaited<ReturnType<StorageService["blob"]>>;
const validId = (id: string) =>
  /^[a-zA-Z0-9_-]{1,100}$/.test(id) &&
  !["__proto__", "constructor", "prototype"].includes(id);
function references(content: unknown, blobId: string) {
  if (typeof content !== "string" || content.length > 100000) return false;
  let found = false;
  walkTokens(Lexer.lex(content), (token) => {
    if (
      token.type === "link" &&
      "href" in token &&
      token.href === `/api/v1/storage/blobs/${blobId}`
    )
      found = true;
  });
  return found;
}
/** Server-only read admission. No role placeholders, no membership fallback after a modern NONE result. */
export class FileReadAccess {
  constructor(readonly host: StorageService) {}
  private async prove(
    db: PoolClient,
    ctx: Context,
    blobId: string,
  ): Promise<Blob> {
    if (!validId(blobId)) throw Error("NOT_FOUND");
    const modern = await db.query(
      "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
      [ctx.workspaceId],
    );
    const access = modern.rowCount ? await effectiveAccess(db, ctx) : null;
    let blob: Blob;
    if (!access || access.role) {
      // Preserve the existing canonical member/credential path, including historical service fixtures.
      await membership(db, ctx);
      await this.host.authorize(db, ctx, "knowledge.read");
      blob = await this.host.blob(db, ctx, blobId);
      await this.host.authorize(db, ctx, "knowledge.read", {
        kind: blob.parent_kind,
        id: blob.parent_id,
      });
    } else {
      if (ctx.credentialId || access.space.namespaceKind !== "team")
        throw Error("NOT_FOUND");
      const row = await db.query(
        "SELECT * FROM storage_blobs WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, blobId],
      );
      if (!row.rowCount) throw Error("NOT_FOUND");
      blob = row.rows[0] as Blob;
      const candidates = await db.query(
        `SELECT DISTINCT s.page_id,s.version,v.data FROM access_shares s
    JOIN versions v ON v.workspace_id=s.workspace_id AND v.page_id=s.page_id AND v.number=s.version
    JOIN access_principals p ON p.id=$2 AND p.active AND p.kind='human'
    JOIN access_team_members m ON m.team_id=$3 AND m.principal_id=p.id AND m.active
    WHERE s.workspace_id=$1 AND NOT s.revoked AND s.expires_at>clock_timestamp() AND 'knowledge.read'=ANY(s.actions)
    AND (s.principal_id=$2 OR s.group_id IN (SELECT gm.group_id FROM access_group_members gm JOIN access_groups g ON g.id=gm.group_id AND g.team_id=$3 WHERE gm.principal_id=$2))
    AND ($4='source' OR s.page_id=$5) AND strpos(v.data->>'content',$6)>0 ORDER BY s.page_id,s.version LIMIT 101`,
        [
          ctx.workspaceId,
          ctx.principalId,
          access.space.namespaceId,
          blob.parent_kind,
          blob.parent_id,
          `/api/v1/storage/blobs/${blobId}`,
        ],
      );
      if (candidates.rows.length > 100) throw Error("POLICY_UNAVAILABLE");
      let proven = false;
      for (const candidate of candidates.rows) {
        if (!references(candidate.data.content, blobId)) continue;
        if (
          blob.parent_kind === "source" &&
          ![
            ...(candidate.data.sourceIds ?? []),
            ...(candidate.data.provenance?.sourceIds ?? []),
          ].includes(blob.parent_id)
        )
          continue;
        try {
          // Mandatory authorizer receives the EXACT pinned version; raw ACL presence is never admission.
          await this.host.authorize(db, ctx, "knowledge.read", {
            kind: "page",
            id: candidate.page_id,
            version: candidate.version,
          });
          await new AccessService(this.host.pool).assertShareInputs(
            db,
            ctx,
            candidate.page_id,
            candidate.version,
          );
          if (blob.parent_kind === "source")
            await requireRead(db, ctx, "source", blob.parent_id);
          proven = true;
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !["NOT_FOUND", "FORBIDDEN"].includes(error.message)
          )
            throw error;
        }
      }
      if (!proven) throw Error("NOT_FOUND");
      const slot = await db.query(
        "SELECT s.withdrawn FROM storage_attachment_versions v JOIN storage_attachment_slots s ON s.workspace_id=v.workspace_id AND s.id=v.slot_id WHERE v.workspace_id=$1 AND v.blob_id=$2",
        [ctx.workspaceId, blobId],
      );
      if (slot.rows[0]?.withdrawn) throw Error("NOT_FOUND");
    }
    if (blob.scan_state !== "clean") throw Error("SCAN_REQUIRED");
    return blob;
  }
  async run<T>(
    ctx: Context,
    resolve: (db: PoolClient) => Promise<string>,
    work: (db: PoolClient, blob: Blob) => Promise<T>,
  ): Promise<T> {
    await ctx.authorization?.revalidate();
    const result = await transaction(
      this.host.pool,
      ctx.workspaceId,
      async (db) => {
        await ctx.authorization?.assertSession(db);
        const blob = await this.prove(db, ctx, await resolve(db));
        return work(db, blob);
      },
    );
    await ctx.authorization?.revalidate();
    return result;
  }
  async download(ctx: Context, blobId: string) {
    const blob = await this.run(
        ctx,
        async () => blobId,
        async (_db, b) => b,
      ),
      bytes = await this.host.files.get(blob.sha256);
    await this.run(
      ctx,
      async () => blobId,
      async (db, now) => {
        if (now.sha256 !== blob.sha256) throw Error("STALE_VERSION");
        await audit(db, ctx, "blob.download", blobId);
      },
    );
    return {
      bytes,
      filename: blob.filename,
      mime: blob.mime,
      sha256: blob.sha256,
    };
  }
}
