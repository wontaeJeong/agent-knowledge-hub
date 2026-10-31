/** Kill after the real runtime domain transaction commits, before queue completion. */
import { Pool } from "pg";
import { createRuntimeJobs } from "../runtime";
import { RuntimeService } from "../../runtime/knowledge";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const bridge = createRuntimeJobs(pool, new RuntimeService(pool), {
  workerCount: 1,
  directoryProviderId: "explicit-test-roster",
  directoryStatus: async (subject) => ({
    ...subject,
    active: true,
    verifiedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 10000).toISOString(),
  }),
  queue: { leaseMs: 60000, clock: () => new Date(process.env.JOB_TEST_CLOCK!) },
});
if (process.env.JOB_CRASH_STAGE === "model") {
  const save = bridge.jobs.savePrepared.bind(bridge.jobs);
  bridge.jobs.savePrepared = async (lease, stage, value) => {
    const result = await save(lease, stage, value);
    process.send?.({ id: lease.id, fence: lease.fence });
    await new Promise<void>(() => {});
    return result;
  };
} else
  bridge.jobs.complete = async (lease) => {
    process.send?.({ id: lease.id, fence: lease.fence });
    await new Promise<void>(() => {});
  };
await bridge.workers[0].tick();
