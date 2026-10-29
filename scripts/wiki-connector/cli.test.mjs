import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startDevServer } from "./dev-server.mjs";
const exec = promisify(execFile);

test("CLI persists private work, exposes a frozen review, and publishes only with reviewer credentials", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-cli-"));
  const page = {
    id: "guide",
    title: "Guide",
    content: "original",
    spaceId: "team-a",
    version: 1,
    localCopyAllowed: true,
    links: [],
    sourceRefs: [],
  };
  const remote = await startDevServer({
    file: path.join(dir, "remote"),
    identities: {
      alice: { userId: "alice", spaces: ["team-a"] },
      reviewer: { userId: "reviewer", spaces: ["team-a"], reviewer: true },
    },
    pages: [page],
  });
  t.after(async () => {
    await remote.close();
    await rm(dir, { recursive: true, force: true });
  });
  const command = async (args, token = "alice") => {
    const { stdout } = await exec(
      process.execPath,
      [path.resolve("scripts/wiki-connector/cli.mjs"), ...args],
      {
        env: {
          ...process.env,
          AGENT_KNOWLEDGE_HUB_WIKI_URL: remote.url,
          AGENT_KNOWLEDGE_HUB_WIKI_TOKEN: token,
          AGENT_KNOWLEDGE_HUB_WIKI_DIR: path.join(dir, "local"),
        },
      },
    );
    return JSON.parse(stdout);
  };
  await command(["sync"]);
  const file = path.join(dir, "page.json");
  await writeFile(file, JSON.stringify({ ...page, content: "CLI proposal" }));
  assert.equal((await command(["write", file])).pending, 1);
  await command(["sync"]);
  const proposalFile = path.join(dir, "pr.json");
  await writeFile(
    proposalFile,
    JSON.stringify({
      id: "pr-one",
      pageId: "guide",
      targetSpaceId: "team-a",
      baseVersion: 1,
    }),
  );
  await command(["propose", proposalFile]);
  assert.equal(
    (await command(["show-proposal", "pr-one"], "reviewer")).page.content,
    "CLI proposal",
  );
  await assert.rejects(
    command(["publish", "pr-one"]),
    (error) => error.stderr.trim() === "FORBIDDEN",
  );
  await command(["approve", "pr-one"], "reviewer");
  assert.equal(
    (await command(["publish", "pr-one"], "reviewer")).status,
    "published",
  );
});

test("CLI refuses non-synthetic service configuration", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-cli-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  await writeFile(file, "{}");
  await assert.rejects(
    exec(process.execPath, [
      path.resolve("scripts/wiki-connector/cli.mjs"),
      "serve",
      file,
    ]),
    (error) => error.stderr.trim() === "SYNTHETIC_ONLY",
  );
});
