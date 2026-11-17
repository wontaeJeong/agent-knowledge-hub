import type { PoolClient } from "pg";
/** Shared application transactions; exclusive coordinated snapshot/physical deletion. Always lock BEFORE workspace rows. */
export const MUTATION_GATE = 822025;
export async function acquireSharedMutationGate(db: PoolClient) {
  await db.query("SELECT pg_advisory_xact_lock_shared($1)", [MUTATION_GATE]);
  await db.query("SELECT pg_advisory_xact_lock(7203101)");
}

/** All shared application work takes directory serialization before workspace,
 * session, identity and grant rows. Projection can reenter the same xact lock. */
export const DIRECTORY_PROJECTION_GATE = 7203101;
