import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  symlink,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { openClient } from "./client.mjs";

test("explicit selected source survives an unknown response and reconnects with the same key without retaining raw content", async () => {
  const root = await mkdtemp(join(tmpdir(), "akh-selected-"));
  const directory = join(root, "state");
  await writeFile(join(root, "notes.md"), "SELECTED RAW BODY");
  let drop = true;
  const registered = new Map();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const q = JSON.parse(raw);
    if (q.action === "knowledge-capabilities") {
      res.end(JSON.stringify({ schemaVersion: "1.0", referenceOnly: true }));
      return;
    }
    if (q.action !== "knowledge-register") {
      res.writeHead(400).end(JSON.stringify({ code: "VALIDATION_FAILED" }));
      return;
    }
    const k = q.input.idempotency_key;
    if (!registered.has(k))
      registered.set(k, {
        source_id: "raw-new",
        status: "registered",
        published: false,
      });
    if (drop) {
      drop = false;
      req.socket.destroy();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(registered.get(k)));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const options = {
    directory,
    url: `http://127.0.0.1:${server.address().port}/api/v1/connector`,
    token: "fixture",
    sourceRoot: root,
  };
  let c = await openClient(options);
  try {
    await assert.rejects(
      () =>
        c.registerSource({
          id: "pick-1",
          file: "notes.md",
          source: {
            title: "Notes",
            targetPageId: "topic",
            scope: "private",
            readers: ["editor"],
          },
        }),
      /CONNECTION_FAILED/,
    );
    const stored = await readFile(join(directory, "state.json"), "utf8");
    assert.equal(stored.includes("SELECTED RAW BODY"), false);
    assert.equal((await c.knowledgeStatus())[0].status, "outcome-unknown");
    await c.close();
    c = await openClient(options);
    assert.equal((await c.resumeKnowledge("pick-1")).source_id, "raw-new");
    assert.equal(registered.size, 1);
    assert.equal((await c.knowledgeStatus())[0].status, "registered");
  } finally {
    await c.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("source selection rejects escapes, secrets and changed queued source before transmission", async () => {
  const root = await mkdtemp(join(tmpdir(), "akh-path-"));
  const outside = await mkdtemp(join(tmpdir(), "akh-outside-"));
  await writeFile(join(outside, "outside.md"), "outside");
  await symlink(join(outside, "outside.md"), join(root, "link.md"));
  await mkdir(join(root, ".aws"));
  await writeFile(join(root, ".aws", "credentials"), "secret");
  await writeFile(join(root, "notes.md"), "before");
  const c = await openClient({
    directory: join(root, "state"),
    sourceRoot: root,
    url: "http://127.0.0.1:1/api/v1/connector",
    token: "fixture",
  });
  await assert.rejects(
    () => c.knowledge({ id: "bad", kind: "unsupported" }),
    /VALIDATION_FAILED/,
  );
  const select = (file) =>
    c.registerSource({
      id: "same-key",
      file,
      source: {
        title: "Notes",
        targetPageId: "topic",
        scope: "private",
        readers: ["editor"],
      },
    });
  try {
    await assert.rejects(() => select("link.md"), /SOURCE_PATH_DENIED/);
    await assert.rejects(() => select("../outside.md"), /SOURCE_PATH_DENIED/);
    await assert.rejects(
      () => select(".aws/credentials"),
      /SOURCE_PATH_DENIED/,
    );
    await assert.rejects(() => select("notes.md"), /CONNECTION_FAILED/);
    await writeFile(join(root, "notes.md"), "after");
    await assert.rejects(
      () => c.resumeKnowledge("same-key"),
      /SELECTED_SOURCE_CHANGED/,
    );
  } finally {
    await c.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
