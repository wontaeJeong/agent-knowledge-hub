import type { Pool } from "pg";
import type { Context } from "../service";
import { z } from "zod";
import { transaction } from "../database";
import { policyAdmin, authorize } from "./common";
import { featureState, features, setFeature } from "./features";
import { assertFeature } from "./features";
import { modelConfig } from "../runtime/model";
import { configuredModelEndpoint } from "./binding";
import { fingerprint } from "../provenance";
import { setSourcePolicy, type SourcePolicyInput } from "./model";
import {
  readPrivateImportPolicy,
  setPrivateImportPolicy,
  type PrivateImportPolicyInput,
} from "./imports";

/** Host performs normal authentication, Origin/CSRF/body-size controls first.
 * Context is server-resolved. There is intentionally no destination registration route.
 */
export async function handlePolicyRequest(
  pool: Pool,
  ctx: Context,
  method: string,
  path: string,
  body: unknown,
) {
  if (!path.startsWith("/api/v1/policy")) return null;
  if (!ctx.authorization && !ctx.credentialId) throw Error("UNAUTHENTICATED");
  await ctx.authorization?.revalidate();
  return transaction(pool, ctx.workspaceId, async (db) => {
    const privateImport = path.match(
      /^\/api\/v1\/policy\/imports\/([a-zA-Z0-9_-]{1,100})$/,
    );
    if (privateImport && method === "GET") {
      const policy = await readPrivateImportPolicy(db, ctx, privateImport[1]);
      const raw = (
        await db.query(
          "SELECT revision,selection,parsed FROM imports WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, privateImport[1]],
        )
      ).rows[0];
      const files = (
        await db.query(
          "SELECT id,size,sha256,received FROM import_files WHERE workspace_id=$1 AND import_id=$2 ORDER BY id",
          [ctx.workspaceId, privateImport[1]],
        )
      ).rows;
      const stored = (
        await db.query(
          "SELECT input_hash,import_revision FROM policy_private_import_sources WHERE workspace_id=$1 AND import_id=$2",
          [ctx.workspaceId, privateImport[1]],
        )
      ).rows[0];
      const currentInputApproved =
        !!stored &&
        stored.import_revision === raw.revision &&
        stored.input_hash ===
          fingerprint({
            revision: raw.revision,
            selection: raw.selection,
            parsed: raw.parsed,
            files,
          });
      const destinations = await db.query(
        "SELECT id,purposes,classifications,fingerprint,revision FROM model_destinations WHERE active AND purposes ? 'organize' ORDER BY id",
      );
      const modelConfigured = modelConfig().configured;
      const modelDestinationId =
        process.env.AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID ?? null;
      const configured =
        modelConfigured && modelDestinationId
          ? (
              await db.query(
                "SELECT canonical_url FROM model_destinations WHERE id=$1 AND active AND purposes ? 'organize'",
                [modelDestinationId],
              )
            ).rows[0]
          : undefined;
      let transmissionFeaturesEnabled = true;
      try {
        await assertFeature(db, ctx, "models", undefined, "source.create");
        await assertFeature(db, ctx, "imports", undefined, "source.create");
      } catch (e) {
        if (e instanceof Error && e.message === "FEATURE_DISABLED")
          transmissionFeaturesEnabled = false;
        else throw e;
      }
      return {
        status: 200,
        body: {
          ...policy,
          destinations: destinations.rows,
          modelConfigured,
          modelDestinationId,
          modelDestinationApproved:
            !!configured &&
            configured.canonical_url === configuredModelEndpoint(),
          transmissionFeaturesEnabled,
          currentInputApproved,
          impact:
            "개인 원본의 현재 내용·선택 범위만 전송 허용합니다. 공유·발행·사내 승인이 아닙니다.",
        },
      };
    }
    if (privateImport && method === "PUT") {
      const parsed = z
        .object({
          expectedRevision: z.number().int().nonnegative(),
          expectedImportRevision: z.number().int().positive(),
          classification: z.string(),
          grants: z.array(z.unknown()).max(100),
          impactAcknowledged: z.literal(true),
        })
        .strict()
        .parse(body);
      await setPrivateImportPolicy(db, ctx, {
        ...parsed,
        importId: privateImport[1],
      } as PrivateImportPolicyInput);
      return { status: 200, body: { revision: parsed.expectedRevision + 1 } };
    }
    if (path === "/api/v1/policy" && method === "GET") {
      await policyAdmin(db, ctx);
      const destinations = await db.query(
        "SELECT id,purposes,classifications,fingerprint,revision FROM model_destinations WHERE active ORDER BY id",
      );
      return {
        status: 200,
        body: {
          features: await featureState(db, ctx),
          destinations: destinations.rows,
          impact:
            "원본별 허용은 전체 파생 페이지에 영향을 줍니다. 사전 등록된 목적지에 대한 로컬 정책이며 사내 승인이 아닙니다.",
        },
      };
    }
    const source = path.match(
      /^\/api\/v1\/policy\/sources\/([a-zA-Z0-9_-]{1,100})$/,
    );
    if (source && method === "GET") {
      await policyAdmin(db, ctx);
      await authorize(db, ctx, "knowledge.read", {
        kind: "source",
        id: source[1],
      });
      const p = await db.query(
        "SELECT source_id,revision,classification,grants FROM model_source_policies WHERE workspace_id=$1 AND source_id=$2",
        [ctx.workspaceId, source[1]],
      );
      return {
        status: 200,
        body: p.rows[0] ?? {
          source_id: source[1],
          revision: 0,
          classification: "unknown",
          grants: [],
        },
      };
    }
    if (source && method === "PUT") {
      const parsed = z
        .object({
          expectedRevision: z.number().int().nonnegative(),
          classification: z.string(),
          grants: z.array(z.unknown()).max(100),
          impactAcknowledged: z.literal(true),
        })
        .strict()
        .parse(body);
      await setSourcePolicy(db, ctx, {
        ...parsed,
        sourceId: source[1],
      } as SourcePolicyInput);
      return { status: 200, body: { revision: parsed.expectedRevision + 1 } };
    }
    const feature = path.match(/^\/api\/v1\/policy\/features\/([a-z]+)$/);
    if (feature && method === "PUT") {
      const parsed = z
        .object({
          enabled: z.boolean(),
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict()
        .parse(body);
      const name = z.enum(features).parse(feature[1]);
      await setFeature(db, ctx, name, parsed.enabled, parsed.expectedRevision);
      return { status: 200, body: { revision: parsed.expectedRevision + 1 } };
    }
    throw Error("NOT_FOUND");
  });
}
