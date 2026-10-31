import type { Pool, PoolClient } from "pg";
import type { Context } from "../service";
import type { InputEnvelope } from "../provenance";
import type { ModelOptions } from "../runtime/model";
import { prepareTransmission, type Purpose } from "./model";

export function configuredModelEndpoint() {
  const base = process.env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL;
  if (
    !base ||
    !process.env.AGENT_KNOWLEDGE_HUB_LLM_MODEL ||
    process.env.AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION !== "true"
  )
    throw Error("MODEL_NOT_CONFIGURED");
  return new URL(base.replace(/\/$/, "") + "/chat/completions").href;
}
/** Server-owned binding; exact envelope is from the actual input projection, never a DTO. */
export async function bindModelTransmission(
  pool: Pool,
  ctx: Context,
  purpose: Purpose,
  envelope: InputEnvelope,
  options: ModelOptions = {},
  endpoint = configuredModelEndpoint(),
) {
  const destinationId = process.env.AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID;
  if (!destinationId) throw Error("MODEL_TRANSMISSION_DENIED");
  const input = {
    destinationId,
    purpose,
    pageIds: envelope.pageIds,
    sourceIds: envelope.sourceIds,
  };
  let check = await prepareTransmission(pool, ctx, input, endpoint, envelope);
  return {
    options: {
      ...options,
      beforeTransmission: async (actualEndpoint: string) => {
        await options.beforeTransmission?.(actualEndpoint);
        // Runs AFTER existing provider/budget hooks, immediately before actual fetch.
        check = await prepareTransmission(
          pool,
          ctx,
          input,
          actualEndpoint,
          envelope,
        );
      },
    } satisfies ModelOptions,
    recheck: async (db: PoolClient) => check(db),
  };
}
