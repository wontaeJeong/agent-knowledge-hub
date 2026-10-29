import { test } from "node:test";
import assert from "node:assert/strict";
import { sealBackup, openBackup } from "./backup-format.mjs";
test("authenticated backup encryption round trips and rejects tampering/wrong key", () => {
  const body = Buffer.from("sensitive source and session records");
  const key = "0123456789abcdef0123456789abcdef";
  const encrypted = sealBackup(body, key);
  assert.ok(!encrypted.includes("sensitive"));
  assert.deepEqual(openBackup(encrypted, key), body);
  assert.throws(() =>
    openBackup(encrypted, "different0123456789abcdef0123456789"),
  );
  const corrupt = JSON.parse(encrypted);
  corrupt.tag = Buffer.alloc(16).toString("base64");
  assert.throws(() => openBackup(JSON.stringify(corrupt), key));
  assert.throws(() => sealBackup(body, "short"));
});
