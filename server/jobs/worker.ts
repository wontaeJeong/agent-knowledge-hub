import { randomUUID } from "node:crypto";
import type { JobService } from "./service";
import type { JobHandler, Lease, Completion } from "./types";

export interface WorkerOptions {
  workerId?: string;
  heartbeatMs?: number;
  pollMs?: number;
  lane?: "interactive" | "maintenance";
  onError?: (error: unknown) => void;
}
/** Server worker only. No connector daemon and no HTTP-inline execution. Each
 * tick handles one claim; start serially polls, multiple workers scale to quotas. */
export class JobWorker {
  readonly workerId: string;
  private running = false;
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<boolean>;
  private polling?: Promise<void>;
  private abort?: AbortController;
  constructor(
    readonly service: JobService,
    readonly handlers: Readonly<Partial<Record<string, JobHandler>>>,
    readonly options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? randomUUID();
    if (
      options.heartbeatMs !== undefined &&
      (options.heartbeatMs < 1 || options.heartbeatMs >= service.leaseMs)
    )
      throw Error("INVALID_HEARTBEAT");
  }
  async tick(): Promise<boolean> {
    if (this.closing) return false;
    if (this.active) return this.active;
    this.active = this.execute();
    try {
      return await this.active;
    } finally {
      this.active = undefined;
    }
  }
  private async execute(): Promise<boolean> {
    const lease = await this.service.claim(this.workerId, this.options.lane);
    if (!lease) return false;
    if (this.closing) {
      await this.service.fail(lease, "WORKER_STOPPED", true);
      return true;
    }
    const controller = new AbortController();
    this.abort = controller;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let failure = "";
    let finished = false,
      handlerTask: Promise<Completion> | undefined;
    const abort = (code: string) => {
      if (!failure) failure = code;
      controller.abort(Error(code));
    };
    const beat = () => {
      heartbeat = setTimeout(
        () => {
          void this.service.heartbeat(lease).then(
            () => {
              if (!finished && !controller.signal.aborted) beat();
            },
            (e) => abort(e instanceof Error ? e.message : "POLICY_UNAVAILABLE"),
          );
        },
        this.options.heartbeatMs ??
          Math.max(1, Math.floor(this.service.leaseMs / 3)),
      );
    };
    try {
      const ctx = await this.service.ready(lease),
        handler = this.handlers[lease.input.kind];
      if (!handler) throw Error("HANDLER_NOT_CONFIGURED");
      timeout = setTimeout(() => abort("TIMEOUT"), lease.input.timeoutMs);
      beat();
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        ),
      );
      // A handler ignoring AbortSignal cannot hold the worker forever. Late
      // results have no automatic effects; all commits must return Completion.
      handlerTask = handler({
        lease,
        ctx,
        signal: controller.signal,
        ready: async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          await this.service.ready(lease);
        },
        checkpoint: (v) => this.service.checkpoint(lease, v),
        recordModel: (u) => this.service.recordModel(lease, u),
        beginModel: (r) => this.service.beginModel(lease, r),
      });
      const result = await Promise.race([handlerTask, aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      await this.service.complete(lease, result);
    } catch (e) {
      // Give signal-aware transports a bounded chance to flush actual/unknown
      // usage before shutdown closes the pool. A handler ignoring abort still
      // cannot hold the worker indefinitely or acquire late effect rights.
      if (controller.signal.aborted && handlerTask) {
        let grace: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            handlerTask.catch(() => {}),
            new Promise<void>((resolve) => {
              grace = setTimeout(resolve, 1000);
            }),
          ]);
        } finally {
          if (grace) clearTimeout(grace);
        }
      }
      const driverCode =
        e && typeof e === "object" && "code" in e ? String(e.code) : "";
      const transientDatabase =
        /^(08\w{3}|40001|40P01|55P03|57P0[123]|53300|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(
          driverCode,
        );
      const code =
        failure ||
        (transientDatabase
          ? "DB_UNAVAILABLE"
          : e instanceof Error
            ? e.message
            : "EXECUTION_FAILED");
      try {
        await this.service.fail(
          lease,
          code,
          /MODEL_UNAVAILABLE|MODEL_FAILED|DB_UNAVAILABLE|ECONNRESET|ETIMEDOUT|UPSTREAM_5|QUEUE_BUSY|WORKER_STOPPED/.test(
            code,
          ),
        );
      } catch (fail) {
        if (!(fail instanceof Error && fail.message === "LEASE_LOST"))
          this.options.onError?.(fail);
      }
    } finally {
      finished = true;
      if (heartbeat) clearTimeout(heartbeat);
      if (timeout) clearTimeout(timeout);
      this.abort = undefined;
    }
    return true;
  }
  start(): void {
    if (this.running) return;
    this.closing = false;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.polling = this.service
        .scheduleTick()
        .then(() => (this.running ? this.tick() : false))
        .then(() => {})
        .catch((e) => this.options.onError?.(e))
        .finally(() => {
          if (this.running)
            this.timer = setTimeout(loop, this.options.pollMs ?? 1000);
        });
    };
    loop();
  }
  async stop(): Promise<void> {
    this.closing = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort(Error("WORKER_STOPPED"));
    await Promise.all([this.active, this.polling]);
  }
}

/** Return a deterministic key for host-side reviewed idempotent effects. */
export const effectKey = (lease: Pick<Lease, "id">) =>
  "durable-job:" + lease.id;
