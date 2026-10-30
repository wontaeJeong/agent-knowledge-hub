import { createHash } from "node:crypto";
interface Limits {
  globalActive: number;
  principalActive: number;
  mutationActive: number;
  read: number;
  write: number;
  windowMs: number;
  identities: number;
  now: () => number;
}
interface Counter {
  start: number;
  read: number;
  write: number;
  active: number;
}
export class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("RATE_LIMITED");
  }
}
/** App1 backpressure only; durable execution/model budgets remain enforced separately in PostgreSQL. */
export class HttpAdmission {
  private active = 0;
  private mutations = 0;
  private counters = new Map<string, Counter>();
  private readonly limits: Limits;
  constructor(options: Partial<Limits> = {}) {
    this.limits = {
      globalActive: 64,
      principalActive: 8,
      mutationActive: 6,
      read: 240,
      write: 60,
      windowMs: 60000,
      identities: 4096,
      now: Date.now,
      ...options,
    };
    if (options.mutationActive === undefined)
      this.limits.mutationActive = Math.min(6, this.limits.globalActive);
    for (const [key, value] of Object.entries(this.limits))
      if (key !== "now" && (!Number.isSafeInteger(value) || Number(value) < 1))
        throw Error("INVALID_HTTP_LIMITS");
    if (
      this.limits.globalActive > 64 ||
      this.limits.principalActive > this.limits.globalActive ||
      this.limits.windowMs > 3600000 ||
      this.limits.identities > 100000
    )
      throw Error("INVALID_HTTP_LIMITS");
  }
  enter() {
    if (this.active >= this.limits.globalActive) throw new RateLimited(1);
    this.active++;
    let released = false,
      identified = false,
      owned: Counter | undefined,
      ownsMutation = false;
    return {
      identify: (space: string, principal: string, mutation: boolean) => {
        if (released || identified) throw Error("INVALID_HTTP_LIMIT_STATE");
        const now = this.limits.now();
        for (const [key, counter] of this.counters)
          if (!counter.active && now - counter.start >= this.limits.windowMs)
            this.counters.delete(key);
        const key = createHash("sha256")
          .update(space + "\0" + principal)
          .digest("hex");
        let counter = this.counters.get(key);
        if (!counter) {
          if (this.counters.size >= this.limits.identities)
            throw new RateLimited(Math.ceil(this.limits.windowMs / 1000));
          counter = { start: now, read: 0, write: 0, active: 0 };
          this.counters.set(key, counter);
        }
        if (now - counter.start >= this.limits.windowMs) {
          counter.start = now;
          counter.read = 0;
          counter.write = 0;
        }
        const lane = mutation ? "write" : "read",
          remaining = Math.max(
            1,
            Math.ceil((this.limits.windowMs - (now - counter.start)) / 1000),
          );
        if (counter.active >= this.limits.principalActive)
          throw new RateLimited(1);
        if (mutation && this.mutations >= this.limits.mutationActive)
          throw new RateLimited(1);
        if (counter[lane] >= this.limits[lane])
          throw new RateLimited(remaining);
        counter[lane]++;
        counter.active++;
        identified = true;
        owned = counter;
        if (mutation) {
          this.mutations++;
          ownsMutation = true;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        if (owned) owned.active--;
        if (ownsMutation) this.mutations--;
      },
    };
  }
}
