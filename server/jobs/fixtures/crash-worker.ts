/** Real subprocess fixture: intentionally killed after a DB-persisted claim. */
import { Pool } from "pg";
import { JobService } from "../index";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const jobs = new JobService(
  pool,
  {
    authorize: async () => {},
    resolveIdentity: async (_db, identity) => ({ ...identity }),
    policyFingerprint: async () => "v1",
    validateScope: async () => {},
  },
  { clock: () => new Date(process.env.JOB_TEST_CLOCK!), leaseMs: 1000 },
);
const lease = await jobs.claim("process-to-kill");
process.send?.(lease);
setInterval(() => {}, 10000);
