import { test, expect } from "vitest";
import { extensionErrorStatuses } from "./errors";
test("public error catalog never treats prototype properties or dependency messages as safe status codes", () => {
  for (const code of [
    "constructor",
    "toString",
    "__proto__",
    "password=do-not-echo",
    "ENO_SUCH_PROVIDER_BODY",
  ])
    expect(extensionErrorStatuses[code]).toBeUndefined();
  expect(extensionErrorStatuses.OFFICIAL_REVIEW_REQUIRED).toBe(409);
  expect(extensionErrorStatuses.PAYLOAD_TOO_LARGE).toBe(413);
});
