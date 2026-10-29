import fs from "node:fs";
import assert from "node:assert/strict";
const base = JSON.parse(
  fs.readFileSync("docs/requirements/requirements.json", "utf8"),
).requirements;
const map = JSON.parse(fs.readFileSync("src/data/roadmap.json", "utf8"));
const core = JSON.parse(
  fs.readFileSync("docs/requirements/core-requirements.json", "utf8"),
).requirements;
assert.equal(base.length, 239);
assert.equal(core.length, 12);
assert.equal(map.length, base.length + core.length);
assert.equal(new Set(map.map((r) => r.id)).size, map.length);
for (const r of [...base, ...core]) {
  const m = map.find((m) => m.id === r.id);
  assert(m);
  assert(m.phase);
  assert.equal(m.acceptance, r.acceptance);
  assert.equal(m.status, "미검증");
  assert.equal(typeof m.demoCoverage, "boolean");
}
console.log(
  `PASS: all ${map.length} requirements have a roadmap phase, original acceptance and honest production status`,
);
