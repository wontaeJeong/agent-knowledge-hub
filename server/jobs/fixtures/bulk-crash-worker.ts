/** Synthetic test worker: terminate after a real item commit, before queue completion. */
import { Pool } from "pg";
import { createRuntimeJobs } from "../runtime";
import { RuntimeService } from "../../runtime/knowledge";
import { createHash } from "node:crypto";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bridge = createRuntimeJobs(pool, new RuntimeService(pool), {
  workerCount: 1,
  queue: { leaseMs: 60000, clock: () => new Date(process.env.JOB_TEST_CLOCK!) },
  revalidateInteractiveGrant: async (binding) => {
    const r = (
      await pool.query(
        "SELECT * FROM runtime_sessions WHERE id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()",
        [binding.sessionId, binding.principalId],
      )
    ).rows[0];
    if (!r) throw Error("UNAUTHENTICATED");
    const response = await fetch(process.env.BULK_TEST_USERINFO!, {
      headers: { Authorization: "Bearer " + r.access_token },
    });
    if (!response.ok) throw Error("UNAUTHENTICATED");
    const info = (await response.json()) as {
      sub: string;
      identityRole: "editor";
    };
    if (info.sub !== r.subject) throw Error("UNAUTHENTICATED");
    return {
      role: "reviewer",
      identityRole: info.identityRole,
      csrfHash: hash(r.csrf),
      subjectHash: hash(r.subject),
    };
  },
  assertInteractiveGrant: async (db, binding) => {
    if (
      !(
        await db.query(
          "SELECT 1 FROM runtime_sessions WHERE id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()",
          [binding.sessionId, binding.principalId],
        )
      ).rowCount
    )
      throw Error("UNAUTHENTICATED");
  },
});
bridge.jobs.complete = async (lease) => {
  process.send?.({ id: lease.id });
  await new Promise<void>(() => {});
};
await bridge.worker.tick();
