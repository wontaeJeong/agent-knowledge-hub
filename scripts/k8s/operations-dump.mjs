import { spawn } from "node:child_process";
/** Async bounded-memory subprocess, signalled timeout, and nonzero exit propagated before archive authentication. */
export function kubectlDump(base, database, signal) {
  const child = spawn(
    "kubectl",
    [...base, "pg_dump", "-U", "knowledge", "-d", database, "-Fc"],
    { signal, stdio: ["ignore", "pipe", "pipe"] },
  );
  let error;
  child.stderr.on("data", () => {});
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(Error("PG_DUMP_FAILED")),
    );
  });
  done.catch((e) => {
    error = e;
    child.stdout.destroy(e);
  });
  return (async function* () {
    try {
      for await (const chunk of child.stdout) {
        if (error) throw error;
        yield chunk;
      }
      await done;
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  })();
}
