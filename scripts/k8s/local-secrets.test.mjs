import { test } from "node:test";
import assert from "node:assert/strict";
import { localOperationalSecrets } from "./local-secrets.mjs";
const encode = (value) => Buffer.from(value).toString("base64");
test("local redeploy preserves independent operational keys and never reads unknown secret material", () => {
  const old = {
    AKH_METRICS_TOKEN: encode("metrics-key-".repeat(4)),
    AUDIT_EXPORT_KEY: encode("encryption-key-".repeat(4)),
    AUDIT_SIGNING_KEY: encode("signing-key-".repeat(4)),
    AGENT_KNOWLEDGE_HUB_BACKUP_KEY: encode("backup-key-".repeat(4)),
    BACKUP_KEY_ID: encode("local-stable-v2"),
    UNRELATED: encode("do-not-copy"),
  };
  const result = localOperationalSecrets(old);
  assert.equal(result.AUDIT_EXPORT_KEY, "encryption-key-".repeat(4));
  assert.equal(result.AUDIT_SIGNING_KEY, "signing-key-".repeat(4));
  assert.equal(result.BACKUP_KEY_ID, "local-stable-v2");
  assert.equal(result.UNRELATED, undefined);
  assert.equal(
    JSON.parse(result.BACKUP_KEYS_JSON)["local-stable-v2"],
    "backup-key-".repeat(4),
  );
});
test("first install creates different strong keys and refuses implicit key replacement or signing-key reuse", () => {
  const result = localOperationalSecrets({});
  assert.ok(result.AUDIT_EXPORT_KEY.length >= 32);
  assert.notEqual(result.AUDIT_EXPORT_KEY, result.AUDIT_SIGNING_KEY);
  assert.notEqual(
    result.AUDIT_EXPORT_KEY,
    result.AGENT_KNOWLEDGE_HUB_BACKUP_KEY,
  );
  assert.throws(
    () => localOperationalSecrets({ AUDIT_EXPORT_KEY: encode("bad-old-key") }),
    /OPERATIONAL_SECRET_CONFIGURATION/,
  );
  const same = encode("same-key-".repeat(5));
  assert.throws(
    () =>
      localOperationalSecrets({
        AUDIT_EXPORT_KEY: same,
        AUDIT_SIGNING_KEY: same,
      }),
    /OPERATIONAL_KEY_SEPARATION/,
  );
});
