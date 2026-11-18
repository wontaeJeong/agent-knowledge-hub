import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sourceHashes } from "../2026-11-18-document-reader/manifest.mjs";

const dir = new URL("./", import.meta.url);
const evidence = JSON.parse(
  await readFile(
    process.argv[2] ?? new URL("browser-results.json", dir),
    "utf8",
  ),
);
assert.equal(
  (await sourceHashes()).productionFingerprint,
  evidence.productionFingerprint,
);
assert.deepEqual(
  evidence.results.map((row) => [row.width, row.theme]),
  [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
    [390, "dark"],
  ],
);
assert.equal(Object.keys(evidence.artifacts).length, 8);
for (const row of evidence.results) {
  for (const key of [
    "keyboardSave",
    "keyboardReopen",
    "keyboardReorder",
    "confirmedDelete",
    "conflictRefreshAndEdit",
    "relogin",
    "sourceRevoked",
    "otherOwnerDenied",
    "otherSpaceDenied",
    "privateStorageAndUrl",
    "entrySessionChecked",
    "transientDraftRestored",
    "compositionReleased",
    "preservedDraftFocus",
    "cookieChangedBeforeRelease",
    "ownerDelete404",
  ])
    assert.equal(row[key], true, key);
  for (const screen of ["list", "view"]) {
    const file = row.width + "-" + row.theme + "-" + screen + ".png";
    const bytes = await readFile(new URL(file, dir));
    assert.equal(bytes.readUInt32BE(16), row.width);
    assert.equal(bytes.readUInt32BE(20), row.width === 1440 ? 1000 : 844);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      evidence.artifacts[file],
    );
  }
}
console.log(
  "Verified production fingerprint, 4 browser sessions and 8 PNG hashes and dimensions.",
);
