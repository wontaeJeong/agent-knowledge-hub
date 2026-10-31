import { fork } from "node:child_process";
import type { ParserFile } from "./parser";
import type { ImportSelection, ParsedImport } from "../../src/domain/imports";
export async function isolatedParse(
  files: ParserFile[],
  selection: ImportSelection,
  timeout = 30_000,
): Promise<ParsedImport> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./parser-child.ts", import.meta.url), [], {
      execArgv: ["--import", "tsx", "--max-old-space-size=256"],
      env: { NODE_ENV: process.env.NODE_ENV || "production", LANG: "C.UTF-8" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    });
    let settled = false;
    const done = (error: Error | null, result?: ParsedImport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => done(Error("PARSER_LIMIT")), timeout);
    timer.unref();
    child.once("error", () => done(Error("PARSER_FAILED")));
    child.once("exit", () => done(Error("PARSER_FAILED")));
    child.once(
      "message",
      (value: { ok: boolean; result?: ParsedImport; code?: string }) => {
        if (value.ok && value.result) done(null, value.result);
        else
          done(
            Error(
              value.code && /^[A-Z_]{1,80}$/.test(value.code)
                ? value.code
                : "PARSER_FAILED",
            ),
          );
      },
    );
    child.send({ files, selection }, (error) => {
      if (error) done(Error("PARSER_FAILED"));
    });
  });
}
