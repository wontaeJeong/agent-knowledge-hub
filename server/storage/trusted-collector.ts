import { z } from "zod";
import type { PoolClient } from "pg";
import { request } from "node:https";
import type { Context } from "../service";
import { transaction } from "../database";
import { StorageService } from "./service";
import { collectArtifact } from "./collectors";
import { bounded, MAX_BYTES, sha256 } from "./content";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const sessionId = z.string().regex(/^ses_[a-zA-Z0-9]+$/);
const artifactId = z.string().regex(/^msg_[a-zA-Z0-9]+$/);
const configuration = z
  .object({
    id,
    workspaceId: id,
    principalId: id,
    issuer: z.string().url(),
    subject: z.string().min(1).max(500),
    label: z.string().min(1).max(100),
    baseUrl: z.string().url(),
    versionPath: z.string().regex(/^\/[a-zA-Z0-9_/-]+$/),
    authorization: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !/[\r\n]/.test(v)),
    allowedSessionIds: z.array(sessionId).min(1).max(1000),
    excludedSessionIds: z.array(sessionId).max(1000).default([]),
    excludedText: z.array(z.string().min(1).max(200)).max(100).default([]),
  })
  .strict();
type Configuration = z.infer<typeof configuration>;
export const collectorConfigurationFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
) => {
  try {
    return z
      .array(configuration)
      .max(100)
      .parse(JSON.parse(env.AKH_TOOL_COLLECTOR_BINDINGS_JSON ?? "[]"));
  } catch {
    throw Error("COLLECTOR_CONFIGURATION");
  }
};
type JsonReader = (url: URL, authorization: string) => Promise<unknown>;
/** No redirects, decompression, caller URLs or unbounded body. TLS verification stays enabled. */
export const createCollectorJsonReader =
  (options: { ca?: string } = {}): JsonReader =>
  (url, authorization) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          ca: options.ca,
          signal: AbortSignal.timeout(10000),
          headers: {
            authorization,
            accept: "application/json",
            "accept-encoding": "identity",
          },
        },
        async (res) => {
          try {
            if (res.statusCode !== 200) throw Error("COLLECTOR_FETCH_FAILED");
            if (
              res.headers["content-encoding"] &&
              res.headers["content-encoding"] !== "identity"
            )
              throw Error("ENCODING_DENIED");
            if (
              !/^application\/json(?:;|$)/i.test(
                res.headers["content-type"] ?? "",
              )
            )
              throw Error("UNSUPPORTED_MEDIA_TYPE");
            if (Number(res.headers["content-length"]) > MAX_BYTES)
              throw Error("PAYLOAD_TOO_LARGE");
            const bytes = await bounded(res, MAX_BYTES, 10000);
            resolve(JSON.parse(bytes.toString("utf8")));
          } catch (error) {
            res.destroy();
            reject(error);
          }
        },
      );
      req.on("error", () => reject(Error("COLLECTOR_FETCH_FAILED")));
      req.end();
    });
export const readCollectorJson: JsonReader = createCollectorJsonReader();
const selected = z
  .object({
    expectedRevision: z.number().int().positive(),
    sessionId,
    artifactId,
    format: z.enum(["api.synthetic-message", "api.assistant-message"]),
    selectedToolIds: z.array(z.string().min(1).max(200)).max(100).default([]),
    title: z.string().min(1).max(300),
    project: z.string().min(1).max(200),
    targetPageId: id.optional(),
  })
  .strict();

/** Only process configuration grants a host/session binding. A request can select, never assert ownership. */
export class TrustedArtifactCollector {
  private readonly configs: Configuration[];
  constructor(
    private readonly storage: StorageService,
    input: unknown,
    private readonly read: JsonReader = readCollectorJson,
  ) {
    this.configs = z.array(configuration).max(100).parse(input);
    const owners = new Map<string, string>(),
      ids = new Set<string>();
    for (const c of this.configs) {
      const u = new URL(c.baseUrl),
        key = c.workspaceId + "\0" + c.id,
        owner = c.issuer + "\0" + c.subject;
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/" ||
        c.versionPath.includes("//") ||
        ids.has(key) ||
        (owners.has(u.origin) && owners.get(u.origin) !== owner)
      )
        throw Error("COLLECTOR_CONFIGURATION");
      ids.add(key);
      owners.set(u.origin, owner);
    }
  }
  private fingerprint(c: Configuration) {
    return sha256(Buffer.from(JSON.stringify(c)));
  }
  async initialize() {
    for (const c of this.configs)
      await transaction(this.storage.pool, c.workspaceId, async (db) => {
        await this.identity(db, c);
        await db.query(
          "INSERT INTO storage_collector_connections(workspace_id,id,principal_id,configuration_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [c.workspaceId, c.id, c.principalId, this.fingerprint(c)],
        );
        const row = (
          await db.query(
            "SELECT principal_id,configuration_hash FROM storage_collector_connections WHERE workspace_id=$1 AND id=$2",
            [c.workspaceId, c.id],
          )
        ).rows[0];
        if (
          row.principal_id !== c.principalId ||
          row.configuration_hash !== this.fingerprint(c)
        )
          throw Error("COLLECTOR_CONFIGURATION_CHANGED");
      });
  }
  private async identity(db: PoolClient, c: Configuration) {
    const p = await db.query(
      "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human' AND issuer=$2 AND subject=$3 FOR SHARE",
      [c.principalId, c.issuer, c.subject],
    );
    if (!p.rowCount) throw Error("FORBIDDEN");
  }
  private config(ctx: Context, name: string) {
    const c = this.configs.find(
      (v) =>
        v.workspaceId === ctx.workspaceId &&
        v.id === name &&
        v.principalId === ctx.principalId,
    );
    if (!c) throw Error("NOT_FOUND");
    return c;
  }
  private async check(db: PoolClient, c: Configuration, revision: number) {
    await this.identity(db, c);
    const r = (
      await db.query(
        "SELECT * FROM storage_collector_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [c.workspaceId, c.id],
      )
    ).rows[0];
    if (!r || !r.active) throw Error("COLLECTOR_CONNECTION_REVOKED");
    if (
      r.revision !== revision ||
      r.configuration_hash !== this.fingerprint(c) ||
      r.principal_id !== c.principalId
    )
      throw Error("STALE_VERSION");
    // A logically applied workspace erasure remains fenced while physical purge
    // is pending. A legal-hold or failed preflight did not erase the workspace.
    const erased = await db.query(
      "SELECT 1 FROM operations_erasure_receipts WHERE workspace_id=$1 AND scope='workspace' AND (status='completed' OR (status='blocked' AND (error_code IS NULL OR error_code IN ('PHYSICAL_BLOB_PURGE_REQUIRED','SHARED_LIVE_BLOB_RETAINED')))) LIMIT 1",
      [c.workspaceId],
    );
    if (erased.rowCount) throw Error("ERASURE_WRITES_FENCED");
  }
  async list(ctx: Context) {
    return this.storage.run(ctx, "source.create", undefined, async (db) => {
      const items = [];
      for (const c of this.configs.filter(
        (c) =>
          c.workspaceId === ctx.workspaceId &&
          c.principalId === ctx.principalId,
      )) {
        await this.identity(db, c);
        const r = (
          await db.query(
            "SELECT active,revision FROM storage_collector_connections WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, c.id],
          )
        ).rows[0];
        if (r)
          items.push({
            id: c.id,
            label: c.label,
            tool: "opencode",
            version: "2.2.2",
            active: r.active,
            revision: r.revision,
            allowedSessionIds: c.allowedSessionIds.filter(
              (id) => !c.excludedSessionIds.includes(id),
            ),
          });
      }
      return { items };
    });
  }
  async revoke(ctx: Context, name: string, revision: number) {
    const c = this.config(ctx, name);
    z.number().int().positive().parse(revision);
    return this.storage.run(ctx, "source.create", undefined, async (db) => {
      await this.identity(db, c);
      const r = await db.query(
        "UPDATE storage_collector_connections SET active=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 AND revision=$4 RETURNING revision",
        [ctx.workspaceId, name, ctx.principalId, revision],
      );
      if (!r.rowCount) throw Error("STALE_VERSION");
      return { active: false, revision: r.rows[0].revision };
    });
  }
  async collect(ctx: Context, name: string, input: unknown) {
    const d = selected.parse(input),
      c = this.config(ctx, name);
    if (
      !c.allowedSessionIds.includes(d.sessionId) ||
      c.excludedSessionIds.includes(d.sessionId)
    )
      throw Error("COLLECTION_EXCLUDED");
    const guard = (db: PoolClient) => this.check(db, c, d.expectedRevision);
    await this.storage.run(ctx, "source.create", undefined, guard);
    const version = async () => {
      const v = z
        .object({ version: z.literal("2.2.2") })
        .safeParse(
          await this.read(new URL(c.versionPath, c.baseUrl), c.authorization),
        );
      if (!v.success) throw Error("UNSUPPORTED_COLLECTOR_VERSION");
    };
    await version();
    const raw = await this.read(
      new URL(`/api/session/${d.sessionId}/message/${d.artifactId}`, c.baseUrl),
      c.authorization,
    );
    await version();
    const artifact = collectArtifact(
      raw,
      {
        tool: "opencode",
        version: "2.2.2",
        format: d.format,
        sessionId: d.sessionId,
        selectedIds: [d.artifactId],
        selectedToolIds: d.selectedToolIds,
        excludedSessionIds: c.excludedSessionIds,
      },
      { sessionId: d.sessionId, artifactId: d.artifactId },
    );
    if (c.excludedText.some((text) => artifact.content.includes(text)))
      throw Error("COLLECTION_EXCLUDED");
    const eventId = sha256(
      Buffer.from(
        JSON.stringify([
          new URL(c.baseUrl).origin,
          c.issuer,
          c.subject,
          d.sessionId,
          artifact.externalId,
        ]),
      ),
    );
    return this.storage.ingestText(
      ctx,
      {
        title: d.title,
        project: d.project,
        targetPageId: d.targetPageId,
        tool: "opencode@2.2.2",
        content: artifact.content,
        collection: {
          format: d.format,
          kind: artifact.kind,
          omitted: artifact.omitted,
        },
        external: {
          id: eventId,
          sessionId: d.sessionId,
          version: artifact.version,
        },
      },
      guard,
    );
  }
}
