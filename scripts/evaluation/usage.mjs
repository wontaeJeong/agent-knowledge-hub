/** Use only an exclusive synthetic/evaluation workspace and principal; concurrent calls contaminate the interval. */
export function createUsageReader({
  pool,
  workspaceId,
  principalId,
  exclusiveWorkspace,
}) {
  if (!pool || !workspaceId || !principalId)
    throw Error("EVALUATION_CONFIG_INVALID");
  if (exclusiveWorkspace !== true) throw Error("EVALUATION_ISOLATION_REQUIRED");
  return {
    async mark() {
      return (
        await pool.query(
          "SELECT coalesce(max(id),0)::text AS id FROM model_usage_events WHERE workspace_id=$1 AND principal_id=$2",
          [workspaceId, principalId],
        )
      ).rows[0].id;
    },
    async since(mark) {
      if (!/^\d+$/.test(String(mark))) throw Error("EVALUATION_USAGE_INVALID");
      const rows = (
        await pool.query(
          "SELECT operation,cost_usd,input_tokens,output_tokens,succeeded FROM model_usage_events WHERE workspace_id=$1 AND principal_id=$2 AND id>$3::bigint ORDER BY id",
          [workspaceId, principalId, mark],
        )
      ).rows;
      const group = (ops) => rows.filter((r) => ops.includes(r.operation));
      const amount = (items) =>
        items.length &&
        items.every(
          (r) => r.cost_usd !== null && Number.isFinite(Number(r.cost_usd)),
        )
          ? items.reduce((a, r) => a + Number(r.cost_usd), 0)
          : null;
      const maintenance = group(["ingest", "organize"]),
        query = group(["query"]);
      const maintenanceCost = amount(maintenance),
        queryCost = amount(query);
      return {
        calls: rows.length,
        failed: rows.filter((r) => !r.succeeded).length,
        maintenanceCalls: maintenance.length,
        queryCalls: query.length,
        maintenanceCost,
        queryCost,
        totalCost:
          maintenanceCost === null || queryCost === null
            ? null
            : maintenanceCost + queryCost,
        events: rows.map((r) => ({
          operation: r.operation,
          succeeded: r.succeeded,
          cost: r.cost_usd === null ? null : Number(r.cost_usd),
          inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
          outputTokens:
            r.output_tokens === null ? null : Number(r.output_tokens),
        })),
      };
    },
  };
}
