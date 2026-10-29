import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDevServer } from "./dev-server.mjs";

test(
  "official MCP client edits personal knowledge, cannot publish, closes on EOF and resumes",
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-mcp-"));
    const page = {
      id: "guide",
      title: "Guide",
      content: "original",
      links: [],
      sourceRefs: [],
      spaceId: "team-a",
      version: 1,
      localCopyAllowed: true,
    };
    const remote = await startDevServer({
      file: path.join(dir, "remote"),
      identities: { token: { userId: "alice", spaces: ["team-a"] } },
      pages: [page],
    });
    let client;
    t.after(async () => {
      await client?.close();
      await remote.close();
      await rm(dir, { recursive: true, force: true });
    });
    const connect = async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("scripts/wiki-connector/mcp.mjs")],
        env: {
          AGENT_KNOWLEDGE_HUB_WIKI_URL: remote.url,
          AGENT_KNOWLEDGE_HUB_WIKI_TOKEN: "token",
          AGENT_KNOWLEDGE_HUB_WIKI_DIR: path.join(dir, "local"),
        },
        stderr: "pipe",
      });
      let errors = "";
      transport.stderr.on("data", (chunk) => (errors += chunk));
      const c = new Client({ name: "integration-test", version: "1.0.0" });
      await c.connect(transport);
      return { c, transport, errors: () => errors };
    };
    let connected = await connect();
    client = connected.c;
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("wiki_write"));
    assert.ok(names.includes("wiki_prepare_merge"));
    assert.ok(!names.some((n) => /publish|approve|confirm/.test(n)));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    await call("wiki_write", {
      page: { ...page, content: "written by an agent" },
    });
    await call("wiki_sync");
    assert.equal(
      (await call("wiki_read", { id: "guide" })).page.content,
      "written by an agent",
    );
    assert.equal(
      (await remote.service.request("token", "snapshot", {})).shared[0].content,
      "original",
    );
    const denied = await client.callTool({
      name: "wiki_read",
      arguments: { id: "missing" },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /NOT_FOUND/);
    assert.equal(connected.errors(), "");
    await client.close();
    await assert.rejects(readFile(path.join(dir, "local", ".lock", "owner")), {
      code: "ENOENT",
    });
    connected = await connect();
    client = connected.c;
    const read = await client.callTool({
      name: "wiki_read",
      arguments: { id: "guide" },
    });
    assert.equal(
      JSON.parse(read.content[0].text).page.content,
      "written by an agent",
    );
  },
);
