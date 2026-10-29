import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openClient } from "./client.mjs";
import { startDevServer } from "./dev-server.mjs";
import { safeError, readJsonBody, requireId } from "./protocol.mjs";

const [command, ...args] = process.argv.slice(2);
const environment = () => ({
  directory:
    process.env.AGENT_KNOWLEDGE_HUB_WIKI_DIR ??
    path.join(os.homedir(), ".agent-knowledge-hub", "wiki"),
  url: process.env.AGENT_KNOWLEDGE_HUB_WIKI_URL,
  token: process.env.AGENT_KNOWLEDGE_HUB_WIKI_TOKEN,
});
try {
  if (command === "serve") {
    if (!args[0]) throw Error("CONFIG_REQUIRED");
    const config = JSON.parse(await readFile(args[0], "utf8"));
    if (config.syntheticOnly !== true) throw Error("SYNTHETIC_ONLY");
    const remote = await startDevServer({
      ...config,
      file: path.resolve(config.file),
    });
    console.log(
      `합성 자료 전용 개발 서비스: ${remote.url}\n운영 인증·DB가 아닙니다. 종료: Ctrl+C`,
    );
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await remote.close();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } else if (
    command === "approve" ||
    command === "publish" ||
    command === "show-proposal"
  ) {
    // Reviewer credentials never enter the MCP tool catalog.
    const { url, token } = environment();
    const target = new URL(url);
    if (
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      (target.protocol !== "https:" &&
        !(target.protocol === "http:" && target.hostname === "127.0.0.1"))
    )
      throw Error("HTTPS_REQUIRED");
    if (!token) throw Error("TOKEN_REQUIRED");
    requireId(args[0]);
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        action: command === "show-proposal" ? "proposal" : command,
        input: { id: args[0] },
      }),
    });
    const value = await readJsonBody(response.body);
    if (!response.ok) throw Error(value.error);
    console.log(JSON.stringify(value, null, 2));
  } else if (
    [
      "status",
      "sync",
      "read",
      "search",
      "write",
      "conflicts",
      "prepare-merge",
      "confirm-merge",
      "propose",
    ].includes(command)
  ) {
    const client = await openClient(environment());
    try {
      let value;
      if (command === "write")
        value = await client.write(JSON.parse(await readFile(args[0], "utf8")));
      else if (command === "read") value = await client.read(args[0], args[1]);
      else if (command === "search") value = await client.search(args[0] ?? "");
      else if (command === "prepare-merge")
        value = await client.prepareMerge(
          args[0],
          await readFile(args[1], "utf8"),
        );
      else if (command === "confirm-merge") {
        if (args[2] !== "--human-reviewed")
          throw Error("HUMAN_REVIEW_REQUIRED");
        value = await client.confirmMerge(args[0], args[1]);
      } else if (command === "propose")
        value = await client.propose(
          JSON.parse(await readFile(args[0], "utf8")),
        );
      else value = await client[command]();
      console.log(JSON.stringify(value, null, 2));
    } finally {
      await client.close();
    }
  } else {
    console.log(
      "wiki: serve <synthetic-config.json> | status | sync | read <id> [space] | search <query> | write <page.json> | conflicts | prepare-merge <id> <text-file> | confirm-merge <id> <hash> --human-reviewed | propose <proposal.json> | show-proposal/approve/publish <id>",
    );
    if (command) process.exitCode = 1;
  }
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
