import type { Pool } from "pg";
import { transaction } from "../database";
import { membership, audit } from "../repository";
import { assertEnvelope } from "../provenance";
import { authorizeInTransaction } from "../access/index";
import { answerOutput, id as identifier } from "../runtime/schema";
import type { RuntimeService } from "../runtime/knowledge";
import type { Context } from "../service";

/** A questioner's saved answer is not a public page. Check all actual influencing input, never citations alone. */
export async function readStoredAnswer(
  pool: Pool,
  runtime: RuntimeService,
  ctx: Context,
  id: string,
) {
  identifier.parse(id);
  await ctx.authorization?.revalidate();
  const result = await transaction(pool, ctx.workspaceId, async (db) => {
    await membership(db, ctx);
    await ctx.authorization?.assertSession(db);
    await authorizeInTransaction(db, ctx, "knowledge.read");
    const row = await db.query(
        "SELECT data FROM runtime_answers WHERE workspace_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.workspaceId, ctx.principalId, id],
      ),
      data = row.rows[0]?.data;
    if (!data || data.requestAuthorizationPending || !data.inputEnvelope)
      throw Error("NOT_FOUND");
    try {
      await assertEnvelope(
        db,
        ctx,
        (await runtime.view(db, ctx)).state,
        data.inputEnvelope,
      );
    } catch (e) {
      if (
        e instanceof Error &&
        ["NOT_FOUND", "STALE_VERSION"].includes(e.message)
      )
        throw Error("NOT_FOUND");
      throw e;
    }
    const fields = answerOutput.parse({
      content: data.content,
      insufficient: data.insufficient,
      citations: data.citations,
    });
    await audit(db, ctx, "query.read", id);
    return {
      ...fields,
      id: data.id,
      question: data.question,
      mode: data.mode,
      at: data.at,
    };
  });
  await ctx.authorization?.revalidate();
  return result;
}
