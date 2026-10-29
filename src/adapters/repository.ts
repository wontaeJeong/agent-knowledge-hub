import { seed } from "../domain/seed";
import type { State } from "../domain/types";
/** Replace this boundary with a server repository; never treat local state as authorization. */
export interface WikiRepository {
  load(): State;
  save(state: State): void;
  reset(): State;
}
const KEY = "agent-knowledge-hub.demo.v1";
// These old keys are retained only to migrate existing browser data.
const LEGACY_KEY = "folio-wiki.demo.v1";
export function readStoredValue(key: string, legacyKey: string) {
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const previous = localStorage.getItem(legacyKey);
  if (previous !== null) {
    try {
      localStorage.setItem(key, previous);
      localStorage.removeItem(legacyKey);
    } catch {
      // A failed migration must not hide or delete the existing value.
    }
  }
  return previous;
}
const copy = () => structuredClone(seed);
export const demoRepository: WikiRepository = {
  load() {
    try {
      const raw = readStoredValue(KEY, LEGACY_KEY);
      if (!raw) return copy();
      const v = JSON.parse(raw);
      if (
        v.schemaVersion !== 1 ||
        !Array.isArray(v.pages) ||
        !Array.isArray(v.sources) ||
        !Array.isArray(v.changes) ||
        !Array.isArray(v.audit) ||
        !Array.isArray(v.runs) ||
        !Array.isArray(v.shares)
      )
        throw Error("schema");
      return v as State;
    } catch {
      return copy();
    }
  },
  save(s) {
    localStorage.setItem(KEY, JSON.stringify(s));
  },
  reset() {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
    return copy();
  },
};
