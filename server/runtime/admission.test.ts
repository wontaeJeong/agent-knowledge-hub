import { test, expect } from "vitest";
import { HttpAdmission } from "./admission";
test("global concurrency is held until real handler completion and release is idempotent", () => {
  const limits = new HttpAdmission({ globalActive: 1, principalActive: 1 });
  const first = limits.enter();
  expect(() => limits.enter()).toThrow("RATE_LIMITED");
  first.release();
  first.release();
  expect(() => limits.enter().release()).not.toThrow();
});
test("authenticated quota and active limits are separate per space/principal and recover after the real window", () => {
  let now = 1000;
  const limits = new HttpAdmission({
    globalActive: 4,
    principalActive: 1,
    read: 2,
    write: 1,
    windowMs: 1000,
    now: () => now,
  });
  const first = limits.enter();
  first.identify("one", "alice", false);
  const concurrent = limits.enter();
  expect(() => concurrent.identify("one", "alice", false)).toThrow(
    "RATE_LIMITED",
  );
  concurrent.release();
  first.release();
  const second = limits.enter();
  second.identify("one", "alice", false);
  second.release();
  const over = limits.enter();
  expect(() => over.identify("one", "alice", false)).toThrow("RATE_LIMITED");
  over.release();
  const other = limits.enter();
  other.identify("two", "alice", false);
  other.release();
  now += 1000;
  const reset = limits.enter();
  reset.identify("one", "alice", false);
  reset.release();
});
test("rejected writes expose bounded retry timing and never spend another principal quota", () => {
  let now = 5000;
  const limits = new HttpAdmission({
    write: 1,
    windowMs: 60000,
    now: () => now,
  });
  const first = limits.enter();
  first.identify("one", "alice", true);
  first.release();
  now += 2000;
  const rejected = limits.enter();
  try {
    rejected.identify("one", "alice", true);
    throw Error("quota did not reject");
  } catch (e) {
    expect(e).toMatchObject({ message: "RATE_LIMITED", retryAfterSeconds: 58 });
  } finally {
    rejected.release();
  }
  const bob = limits.enter();
  expect(() => bob.identify("one", "bob", true)).not.toThrow();
  bob.release();
});
test("large mutable bodies have a separate global cap without blocking ordinary reads", () => {
  const limits = new HttpAdmission({
    globalActive: 4,
    principalActive: 2,
    mutationActive: 1,
  });
  const upload = limits.enter();
  upload.identify("one", "alice", true);
  const second = limits.enter();
  expect(() => second.identify("one", "bob", true)).toThrow("RATE_LIMITED");
  second.release();
  const read = limits.enter();
  expect(() => read.identify("one", "bob", false)).not.toThrow();
  read.release();
  upload.release();
  const next = limits.enter();
  expect(() => next.identify("one", "bob", true)).not.toThrow();
  next.release();
});
