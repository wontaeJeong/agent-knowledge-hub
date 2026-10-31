import { execFileSync } from "node:child_process";

// The native Kind path remains available for its local acceptance environment.
// Everywhere else use the same PostgreSQL major version as the CI service.
export function runTestPgTool(args: string[], input?: Buffer): Buffer {
  const options = {
    input,
    stdio: "pipe" as const,
    maxBuffer: 128 * 1024 * 1024,
  };
  if (process.env.AKH_TEST_PG_KUBECTL === "1") {
    return execFileSync(
      "kubectl",
      [
        "--context",
        "kind-knowledge-hub-dev",
        "-n",
        "agent-knowledge-hub-local",
        "exec",
        "-i",
        "knowledge-db-0",
        "--",
        ...args,
      ],
      options,
    );
  }
  const url = new URL(process.env.TEST_DATABASE_URL!);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.search ||
    url.hash
  )
    throw Error("UNSUPPORTED_TEST_DATABASE_URL");
  const env = {
    ...process.env,
    PGHOST:
      process.platform === "darwin" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
        ? "host.docker.internal"
        : url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
  // Never place credentials in Docker arguments, command lines, or error messages.
  const toolArgs = args.filter(
    (_, i) => args[i] !== "-U" && args[i - 1] !== "-U",
  );
  return execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "host",
      "-e",
      "PGHOST",
      "-e",
      "PGPORT",
      "-e",
      "PGUSER",
      "-e",
      "PGPASSWORD",
      "postgres:17.6-alpine",
      ...toolArgs,
    ],
    { ...options, env },
  );
}
