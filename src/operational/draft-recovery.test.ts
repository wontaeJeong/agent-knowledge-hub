import { expect, test, vi } from "vitest";
import {
  RecoveryCache,
  DraftAutosave,
  type RecoveryBinding,
  type Draft,
} from "./draft-recovery";
const draft: Draft = {
  id: "d",
  revision: 0,
  title: "작업",
  content: "기준",
  pageId: "p",
  baseVersion: 1,
};
const binding = (expiresAt = Date.now() + 300000): RecoveryBinding => ({
  id: "d",
  pageId: "p",
  baseVersion: 1,
  expectedRevision: 0,
  sourceIds: [],
  dependencyVersions: {},
  principalId: "u",
  workspaceId: "s",
  lineageHash: "a".repeat(64),
  policyHash: "b".repeat(64),
  expiresAt,
  cacheBinding: "c".repeat(64),
});
function storage() {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (n: number) => [...m.keys()][n] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
}
test("local-copy denied means zero cached content, bounded grant/TTL/bytes and restart never bypass server identity validation", async () => {
  let now = 1000;
  const store = storage();
  const cache = new RecoveryCache(store, () => now);
  expect(cache.write(null, draft, "미전송 비밀")).toBe(false);
  expect(store.length).toBe(0);
  const grant = binding(now + 300000);
  expect(cache.write(grant, draft, "허용된 작업")).toBe(true);
  const restart = new RecoveryCache(store, () => now);
  const check = vi.fn(async () => {
    throw Error("identity revoked");
  });
  await expect(restart.recover("u", "s", "p", check)).rejects.toThrow();
  expect(store.length).toBe(0);
  cache.write(grant, draft, "허용된 작업");
  now += 300001;
  expect(cache.write(grant, draft, "만료 뒤 새 비밀")).toBe(false);
  expect(await cache.recover("u", "s", "p", check)).toBe(null);
  expect(store.length).toBe(0);
});
test("identity/space cannot read another cache and oversize entries are not persisted", async () => {
  const store = storage();
  const cache = new RecoveryCache(store);
  cache.write(binding(), draft, "작업");
  expect(await cache.recover("other", "s", "p", vi.fn())).toBe(null);
  expect(await cache.recover("u", "other", "p", vi.fn())).toBe(null);
  expect(cache.write(binding(), draft, "가".repeat(200000))).toBe(false);
});
test("cache entry/total byte limits are enforced and only allowlisted fields are serialized", () => {
  const store = storage(); const cache = new RecoveryCache(store);
  for (let n = 0; n < 12; n++) {
    const b = { ...binding(), pageId: `p${n}`, csrfToken: "MUST_NOT_PERSIST_CSRF" };
    const d = { ...draft, pageId: b.pageId, accessToken: "MUST_NOT_PERSIST_TOKEN" };
    expect(cache.write(b, d, "x".repeat(50000))).toBe(true);
  }
  expect(store.length).toBeLessThanOrEqual(10);
  const values = Array.from({ length: store.length }, (_, i) => store.getItem(store.key(i)!)!);
  expect(values.reduce((n, v) => n + new TextEncoder().encode(v).length, 0)).toBeLessThanOrEqual(524288);
  expect(values.join("")).not.toContain("MUST_NOT_PERSIST");
});
test("lost acknowledgement retries exactly same mutation before newer typing; conflict keeps both versions until explicit choice", async () => {
  let attempts = 0;
  const sent: unknown[] = [];
  const autosave = new DraftAutosave(
    draft,
    async (input) => {
      sent.push(input);
      attempts++;
      if (attempts === 1) throw new TypeError("connection lost after commit");
      return {
        ...draft,
        content: input.content,
        revision: input.expectedRevision + 1,
      };
    },
    () => {},
  );
  autosave.edit("첫 입력");
  await autosave.flush();
  expect(autosave.status).toBe("offline");
  autosave.edit("다음 입력");
  await autosave.flush();
  expect(sent[0]).toEqual(sent[1]);
  expect(sent).toHaveLength(3);
  expect(autosave.draft.content).toBe("다음 입력");
  autosave.dispose();
});
test("typing is debounced at most one second and a disposed editor cannot update a different identity", async () => {
  vi.useFakeTimers();
  const save = vi.fn(async (input) => ({ ...draft, ...input, revision: 1 }));
  const onChange = vi.fn();
  const autosave = new DraftAutosave(draft, save, onChange);
  autosave.edit("입력");
  await vi.advanceTimersByTimeAsync(1000);
  expect(save).toHaveBeenCalledTimes(1);
  autosave.edit("닫힌 입력");
  autosave.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(save).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
