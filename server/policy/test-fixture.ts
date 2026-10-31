import type { Pool } from "pg";
import { vi } from "vitest";
import { transaction } from "../database";
import {
  registerTrustedDestinations,
  setSourcePolicy,
  type Purpose,
} from "./model";
/** TEST ONLY: explicit local synthetic classification/consent, never production bootstrap.
 * Adoption names fixture-owner explicitly; no approval is inferred from readability.
 */
export async function approveLocalTransmissionFixture(
  pool: Pool,
  workspaceId: string,
  endpoint: string,
  purposes: Purpose[],
  destinationId = "explicit-local-fixture",
  sourceIds = ["source-a"],
  ownerId = "fixture-owner",
) {
  const authorization = {
    revalidate: async () => {},
    assertSession: async () => {},
  };
  await registerTrustedDestinations(pool, [
    {
      id: destinationId,
      url: endpoint,
      purposes,
      classifications: ["synthetic"],
      active: true,
    },
  ]);
  const d = (
    await pool.query("SELECT fingerprint FROM model_destinations WHERE id=$1", [
      destinationId,
    ])
  ).rows[0];
  for (const sourceId of sourceIds) {
    const added = await pool.query(
      "INSERT INTO resource_readers VALUES($1,'source',$2,$3) ON CONFLICT DO NOTHING RETURNING principal_id",
      [workspaceId, sourceId, ownerId],
    );
    const old = (
      await pool.query(
        "SELECT revision FROM model_source_policies WHERE workspace_id=$1 AND source_id=$2",
        [workspaceId, sourceId],
      )
    ).rows[0];
    await transaction(pool, workspaceId, (db) =>
      setSourcePolicy(
        db,
        { workspaceId, principalId: ownerId, authorization },
        {
          sourceId,
          classification: "synthetic",
          expectedRevision: old?.revision ?? 0,
          grants: purposes.map((purpose) => ({
            destinationId,
            purpose,
            fingerprint: d.fingerprint,
          })),
          impactAcknowledged: true,
        },
      ),
    );
    // Preserve the regression fixture's original source upper bound. The named
    // local policy reviewer is not automatically a reader of published results.
    if (added.rowCount)
      await pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id=$3",
        [workspaceId, sourceId, ownerId],
      );
  }
  return authorization;
}
/** Explicit configured IN-PROCESS model fixture. This address is never contacted;
 * the test passes its own pure ModelCall and exercises current DB policy anyway. */
export async function approveInProcessModelFixture(
  pool: Pool,
  workspaceId: string,
  sourceIds = ["source-a"],
) {
  const base = "https://in-process-fixture.invalid/v1";
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", base);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "in-process-fixture");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv(
    "AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID",
    "explicit-in-process-fixture",
  );
  return approveLocalTransmissionFixture(
    pool,
    workspaceId,
    base + "/chat/completions",
    ["query", "ingest"],
    "explicit-in-process-fixture",
    sourceIds,
  );
}
