import { randomUUID } from "node:crypto";
import type { CollaborationService } from "./service";
export class CollaborationWorker {
  private running = false;
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<boolean>;
  private controller?: AbortController;
  constructor(
    readonly service: CollaborationService,
    readonly options: {
      workerId?: string;
      pollMs?: number;
      onError?: (e: unknown) => void;
    } = {},
  ) {}
  async tick(): Promise<boolean> {
    if (this.closing) return false;
    if (this.active) return this.active;
    this.active = this.run();
    try {
      return await this.active;
    } finally {
      this.active = undefined;
    }
  }
  private async run() {
    await this.service.syncPlans();
    await this.service.scanReviews();
    await this.service.planDigests();
    if (this.closing) return false;
    const lease = await this.service.claim(
      this.options.workerId ?? "collaboration-" + randomUUID(),
    );
    if (!lease) return false;
    const controller = new AbortController();
    this.controller = controller;
    let done = false,
      heartbeat: ReturnType<typeof setTimeout> | undefined;
    const beat = () => {
      heartbeat = setTimeout(
        () => {
          void this.service.heartbeat(lease).then(
            () => {
              if (!done) beat();
            },
            () => controller.abort(),
          );
        },
        Math.max(10, Math.floor(this.service.leaseMs / 3)),
      );
    };
    beat();
    try {
      await this.service.runDigest(lease, controller.signal);
    } finally {
      done = true;
      if (heartbeat) clearTimeout(heartbeat);
      this.controller = undefined;
    }
    return true;
  }
  start() {
    if (this.running) return;
    this.closing = false;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      void this.tick()
        .catch((e) => this.options.onError?.(e))
        .finally(() => {
          if (this.running)
            this.timer = setTimeout(loop, this.options.pollMs ?? 1000);
        });
    };
    loop();
  }
  async stop() {
    this.closing = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.active;
  }
}
