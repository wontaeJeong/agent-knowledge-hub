import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { demoRepository } from "./repository";
import { seed } from "../domain/seed";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("saves and reloads demo state under the project namespace", () => {
  demoRepository.save(seed);
  expect(
    JSON.parse(localStorage.getItem("agent-knowledge-hub.demo.v1")!),
  ).toEqual(seed);
  expect(demoRepository.load()).toEqual(seed);
});

it("migrates existing browser state without losing it", () => {
  const state = { ...seed, audit: [] };
  localStorage.setItem("folio-wiki.demo.v1", JSON.stringify(state));
  expect(demoRepository.load()).toEqual(state);
  expect(
    JSON.parse(localStorage.getItem("agent-knowledge-hub.demo.v1")!),
  ).toEqual(state);
  expect(localStorage.getItem("folio-wiki.demo.v1")).toBeNull();
});

it("prefers current data and reset cannot resurrect legacy state", () => {
  localStorage.setItem(
    "folio-wiki.demo.v1",
    JSON.stringify({ ...seed, audit: [] }),
  );
  localStorage.setItem("agent-knowledge-hub.demo.v1", JSON.stringify(seed));
  expect(demoRepository.load()).toEqual(seed);
  demoRepository.reset();
  expect(localStorage.getItem("agent-knowledge-hub.demo.v1")).toBeNull();
  expect(localStorage.getItem("folio-wiki.demo.v1")).toBeNull();
  expect(demoRepository.load()).toEqual(seed);
});

it("still reads existing data if migration cannot write to storage", () => {
  const state = { ...seed, audit: [] };
  localStorage.setItem("folio-wiki.demo.v1", JSON.stringify(state));
  localStorage.setItem = () => {
    throw Error("quota");
  };
  expect(demoRepository.load()).toEqual(state);
  expect(localStorage.getItem("folio-wiki.demo.v1")).toBe(
    JSON.stringify(state),
  );
});
