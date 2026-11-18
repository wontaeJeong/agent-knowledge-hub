import assert from "node:assert/strict";
import { fixture } from "../../../server/test-support";
import { validateBaseUrl } from "../../../scripts/test-server.mjs";

const url = validateBaseUrl(process.env.TEST_DATABASE_URL);
assert(
  process.env.AKH_C12_SYNTHETIC === "1" &&
    ["127.0.0.1", "localhost"].includes(url.hostname),
);
assert.match(url.pathname, /^\/akh_c12_test_[a-f0-9]{32}$/);
try {
  const f = await fixture();
  await f.pool.end();
  process.stdout.write(f.workspaceId);
} catch (error) {
  // fixture() owns an unreturned Pool if migration or seed throws. Exit this
  // one-shot child so the OS closes those sockets before the parent tries DROP.
  console.error(
    "Fixture subprocess initialization failed",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}
