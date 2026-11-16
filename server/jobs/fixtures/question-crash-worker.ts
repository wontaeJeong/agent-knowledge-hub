import { Pool } from "pg";
import { createRuntimeJobs } from "../runtime";
import { RuntimeService } from "../../runtime/knowledge";
import { QuestionsService } from "../../questions/service";
import { authorizeInTransaction } from "../../access/index";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtime = new RuntimeService(pool);
const questions = new QuestionsService(pool, {
  runtime,
  authorize: authorizeInTransaction,
  runQuery: (ctx, q, mode, execution, context) =>
    runtime.query(ctx, q, mode, execution, context),
});
const bridge = createRuntimeJobs(pool, runtime, {
  workerCount: 1,
  questions: questions.questionJobAdapter(),
  directoryProviderId: "explicit-test-roster",
  directoryStatus: async (subject) => ({
    ...subject,
    active: true,
    verifiedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 10000).toISOString(),
  }),
  queue: { leaseMs: 60000, clock: () => new Date(process.env.JOB_TEST_CLOCK!) },
});
bridge.jobs.complete = async (lease) => {
  process.send?.({ id: lease.id });
  await new Promise<void>(() => {});
};
await bridge.workers[0].tick();
