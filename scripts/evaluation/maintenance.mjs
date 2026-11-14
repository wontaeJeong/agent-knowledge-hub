import { measureReview, validateIsolation } from "./evolution.mjs";
/** Trusted orchestration; driver methods must invoke the real authenticated service. */
export async function runMaintenance({
  driver,
  stages,
  heldout,
  expected,
  model,
  provider,
  expectedIdentity,
  signal,
  maxReviewAttempts = 3,
  modelTimeoutMs = 60000,
}) {
  if (
    !driver ||
    !Array.isArray(stages) ||
    stages.length < 3 ||
    !Number.isInteger(maxReviewAttempts) ||
    maxReviewAttempts < 1 ||
    maxReviewAttempts > 10 ||
    new Set(stages.map((s) => s.stage)).size !== stages.length
  )
    throw Error("EVALUATION_CONFIG_INVALID");
  if (
    !Number.isInteger(modelTimeoutMs) ||
    modelTimeoutMs < 1 ||
    modelTimeoutMs > 300000
  )
    throw Error("EVALUATION_CONFIG_INVALID");
  const modelCall = async (fn) => {
    const controller = new AbortController();
    let timeout = false;
    const onAbort = () => controller.abort();
    if (signal?.aborted) throw Error("ABORTED");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timeout = true;
      controller.abort();
    }, modelTimeoutMs);
    try {
      return await Promise.race([
        fn(controller.signal),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(Error(timeout ? "MODEL_TIMEOUT" : "ABORTED")),
            { once: true },
          ),
        ),
      ]);
    } catch (error) {
      if (controller.signal.aborted)
        throw Error(timeout ? "MODEL_TIMEOUT" : "ABORTED");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  };
  if (
    !model ||
    typeof driver.verifyModel !== "function" ||
    typeof driver.verifyActors !== "function"
  )
    throw Error("EVALUATION_CONFIG_INVALID");
  await driver.verifyModel(model, provider);
  const identities = await driver.verifyActors();
  if (
    expectedIdentity &&
    (identities.workspaceId !== expectedIdentity.workspaceId ||
      identities.editor !== expectedIdentity.principalId)
  )
    throw Error("EVALUATION_IDENTITIES_INVALID");
  const sources = await driver.sources();
  const byId = new Map(sources.map((s) => [s.id, s]));
  if (
    stages.some(
      (s) =>
        !Array.isArray(s.sourceIds) ||
        !s.sourceIds.length ||
        !s.operationalQuestion?.trim() ||
        s.sourceIds.some((id) => !byId.has(id)),
    )
  )
    throw Error("EVALUATION_SOURCE_INVALID");
  // Validate only selected material, before any maintenance model/write call.
  const initialWiki = await driver.pages();
  validateIsolation(
    [
      ...stages.map((s) => ({
        ...s,
        material: s.sourceIds.map((id) => byId.get(id)),
      })),
      initialWiki,
    ],
    heldout,
    expected,
  );
  const cycles = [],
    snapshots = [];
  const available = new Set();
  let stopped = false;
  for (const stage of stages) {
    for (const id of stage.sourceIds) available.add(id);
    const raw = [...available].map((id) => structuredClone(byId.get(id)));
    if (stopped || signal?.aborted) {
      cycles.push({ stage: stage.stage, status: "unexecuted", attempts: [] });
      snapshots.push({
        stage: stage.stage,
        sources: raw,
        wiki: null,
        maintenance: { cost: null },
      });
      continue;
    }
    const cycle = {
      stage: stage.stage,
      status: "running",
      attempts: [],
      reviewWorkMs: null,
      reviewWaitMs: null,
      changes: 0,
    };
    let mark;
    try {
      mark = await driver.usageMark();
      let published;
      for (let i = 0; i < maxReviewAttempts; i++) {
        const proposal = await modelCall((signal) =>
          driver.ingest(stage.sourceIds, signal),
        );
        if (!proposal?.id || !proposal?.hash) throw Error("NO_PROPOSAL");
        const offeredAt = new Date().toISOString();
        if (signal?.aborted) throw Error("ABORTED");
        const review = await driver.review({
          stage: stage.stage,
          proposal: structuredClone(proposal),
          attempt: i + 1,
          signal,
        });
        if (signal?.aborted) throw Error("ABORTED");
        const events = Array.isArray(review?.events)
          ? structuredClone(review.events)
          : [];
        const started = events[0]?.at ? Date.parse(events[0].at) : NaN;
        const ended = events[1]?.at ? Date.parse(events[1].at) : NaN;
        const measured =
          events.every((e) => e.actorId === identities.reviewer) &&
          started >= Date.parse(offeredAt) &&
          ended <= Date.now()
            ? measureReview(events)
            : { workMs: null };
        const attempt = {
          proposalId: proposal.id,
          hash: proposal.hash,
          offeredAt,
          decision: review?.decision ?? "unmeasured",
          actionStatus: "pending",
          reason:
            typeof review?.reason === "string"
              ? review.reason.slice(0, 2000)
              : null,
          events,
          reviewWorkMs: measured.workMs,
          reviewWaitMs:
            measured.workMs !== null &&
            Number.isFinite(started) &&
            started >= Date.parse(offeredAt)
              ? started - Date.parse(offeredAt)
              : null,
        };
        cycle.attempts.push(attempt);
        if (review?.decision === "reject") {
          await driver.reject(proposal);
          attempt.actionStatus = "accepted";
          continue;
        }
        if (review?.decision !== "approve") throw Error("REVIEW_REQUIRED");
        await driver.approve(proposal);
        attempt.actionStatus = "accepted";
        published = await driver.publish(proposal);
        break;
      }
      if (!published?.versions || !Object.keys(published.versions).length)
        throw Error("REVIEW_LIMIT");
      cycle.versions = published.versions;
      cycle.changes = Object.keys(published.versions).length;
      cycle.operationalAnswerId = (
        await modelCall((signal) =>
          driver.query(stage.operationalQuestion, signal),
        )
      ).id;
      cycle.lint = await driver.lint();
      const wiki = await driver.pages();
      validateIsolation([wiki], heldout, expected);
      const work = cycle.attempts.map((a) => a.reviewWorkMs);
      cycle.reviewWorkMs = work.every((v) => v !== null)
        ? work.reduce((a, b) => a + b, 0)
        : null;
      const wait = cycle.attempts.map((a) => a.reviewWaitMs);
      cycle.reviewWaitMs = wait.every((v) => v !== null)
        ? wait.reduce((a, b) => a + b, 0)
        : null;
      cycle.status = "completed";
      const usage = await driver.usageSince(mark);
      cycle.usage = usage;
      snapshots.push({
        stage: stage.stage,
        sources: raw,
        wiki: structuredClone(wiki),
        maintenance: {
          cost: usage.maintenanceCost ?? null,
          queryCost: usage.queryCost ?? null,
        },
      });
    } catch (error) {
      const pending = cycle.attempts.at(-1);
      if (pending?.actionStatus === "pending") pending.actionStatus = "failed";
      cycle.status =
        error instanceof Error && error.message === "MODEL_TIMEOUT"
          ? "timed-out"
          : error instanceof Error && error.message === "ABORTED"
            ? "aborted"
            : "failed";
      cycle.reconciliationRequired =
        cycle.status === "timed-out" ||
        cycle.status === "aborted" ||
        Boolean(cycle.versions) ||
        cycle.attempts.length > 0;
      cycle.errorCode =
        error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : "EXECUTION_FAILED";
      try {
        cycle.usage =
          mark === undefined ? { cost: null } : await driver.usageSince(mark);
      } catch {
        cycle.usage = { cost: null };
      }
      snapshots.push({
        stage: stage.stage,
        sources: raw,
        wiki: null,
        maintenance: {
          cost: cycle.usage.maintenanceCost ?? null,
          queryCost: cycle.usage.queryCost ?? null,
        },
      });
      stopped = true;
    }
    cycles.push(cycle);
  }
  const attempts = cycles.flatMap((c) => c.attempts);
  const measuredAttempts = attempts.filter(
    (a) => a.reviewWorkMs !== null,
  ).length;
  const reviewSummary = {
    reviewed: attempts.filter(
      (a) => a.decision === "approve" || a.decision === "reject",
    ).length,
    accepted: attempts.filter((a) => a.actionStatus === "accepted").length,
    rejected: attempts.filter((a) => a.decision === "reject").length,
    reproposed: cycles.reduce(
      (n, c) => n + Math.max(0, c.attempts.length - 1),
      0,
    ),
    measuredAttempts,
    workMs:
      attempts.length && measuredAttempts === attempts.length
        ? attempts.reduce((n, a) => n + a.reviewWorkMs, 0)
        : null,
    waitMs:
      attempts.length && attempts.every((a) => a.reviewWaitMs !== null)
        ? attempts.reduce((n, a) => n + a.reviewWaitMs, 0)
        : null,
    changes: cycles.reduce((n, c) => n + (c.changes ?? 0), 0),
  };
  return {
    identities,
    status: cycles.every((c) => c.status === "completed")
      ? "completed"
      : "incomplete",
    cycles,
    snapshots,
    reviewSummary,
  };
}
