import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hash, requireId } from "./protocol.mjs";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const selectedSource = z
  .object({
    id,
    file: z.string().min(1).max(4096),
    source: z
      .object({
        title: z.string().trim().min(1).max(300),
        targetPageId: id,
        scope: z.enum(["private", "team", "company"]).default("private"),
        readers: z.array(z.string().min(1).max(200)).min(1).max(100),
        project: z.string().max(200).default(""),
      })
      .strict(),
  })
  .strict();
export const knowledgeOperation = z.discriminatedUnion("kind", [
  z
    .object({
      id,
      kind: z.literal("ingest"),
      sourceIds: z.array(id).min(1).max(20),
      mode: z.enum(["offline", "model"]),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("query"),
      question: z.string().trim().min(1).max(2000),
      mode: z.enum(["offline", "model"]),
    })
    .strict(),
  z.object({ id, kind: z.literal("lint") }).strict(),
  z.object({ id, kind: z.literal("file-answer"), answerId: id }).strict(),
]);
function parseLocal(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw Error("VALIDATION_FAILED");
  return result.data;
}
function secretPath(value) {
  return value
    .split(/[\\/]/)
    .some((part) =>
      /^(?:\.env(?:\..*)?|\.git|\.aws|\.ssh|\.codex|\.agents|\.npmrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/i.test(
        part,
      ),
    );
}
const inside = (root, file) => {
  const p = path.relative(root, file);
  return (
    p !== "" &&
    !path.isAbsolute(p) &&
    p !== ".." &&
    !p.startsWith(".." + path.sep)
  );
};
async function readSelected(root, file) {
  if (!root) throw Error("SOURCE_ROOT_REQUIRED");
  const canonical = await realpath(root);
  const selected = path.resolve(canonical, file);
  if (!inside(canonical, selected) || secretPath(selected))
    throw Error("SOURCE_PATH_DENIED");
  let actual;
  try {
    actual = await realpath(selected);
  } catch {
    throw Error("SOURCE_PATH_DENIED");
  }
  if (!inside(canonical, actual) || secretPath(actual))
    throw Error("SOURCE_PATH_DENIED");
  // Open the resolved file without following a last-component substitution.
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 400000)
      throw Error("SOURCE_FILE_INVALID");
    const content = await handle.readFile("utf8");
    if (!content.trim() || content.length > 100000 || content.includes("\0"))
      throw Error("SOURCE_FILE_INVALID");
    // Re-resolve both paths after reading: parent symlink swaps must not redirect a selected file.
    if (
      (await realpath(selected)) !== actual ||
      (await realpath(root)) !== canonical
    )
      throw Error("SOURCE_PATH_DENIED");
    return content;
  } finally {
    await handle.close();
  }
}
export function knowledgeMethods({ state, persist, request, run, sourceRoot }) {
  const entries = () => (state.knowledgeOperations ??= {});
  const view = (e) => ({
    id: e.id,
    kind: e.kind,
    status: e.status,
    error: e.error ?? null,
    ...(e.result ? { result: e.result } : {}),
    ...(e.jobId ? { jobId: e.jobId } : {}),
    ...(e.digest ? { sourceDigest: e.digest } : {}),
    humanReviewRequired: true,
  });
  async function execute(e) {
    try {
      let action, input;
      if (e.kind === "register") {
        const content = await readSelected(sourceRoot, e.file);
        if (hash(content) !== e.digest) throw Error("SELECTED_SOURCE_CHANGED");
        action = "knowledge-register";
        input = {
          artifact: {
            ...e.source,
            content,
            tool: "local-selected-file",
            verification: "미검증",
          },
          idempotency_key: e.id,
        };
      } else if (e.kind === "file-answer") {
        action = "knowledge-file-answer";
        input = { answerId: e.answerId, idempotency_key: e.id };
      } else {
        const { id, kind } = e;
        action = "knowledge-" + kind;
        input = {
          payload:
            kind === "lint"
              ? {}
              : kind === "ingest"
                ? { sourceIds: e.sourceIds, mode: e.mode }
                : { question: e.question, mode: e.mode },
          idempotency_key: id,
        };
      }
      e.status = "outcome-unknown";
      e.error = null;
      await persist();
      let supported;
      try {
        supported = await request("knowledge-capabilities", {});
      } catch (error) {
        if (
          [
            "VALIDATION_FAILED",
            "UNKNOWN_OPERATION",
            "UNKNOWN_ACTION",
            "FEATURE_UNAVAILABLE",
            "NOT_FOUND",
          ].includes(error.message)
        )
          throw Error("FEATURE_UNAVAILABLE");
        throw error;
      }
      if (
        supported?.schemaVersion !== "1.0" ||
        supported?.referenceOnly !== true
      )
        throw Error("FEATURE_UNAVAILABLE");
      const result = await request(action, input);
      if (!result || typeof result !== "object")
        throw Error("INVALID_RESPONSE");
      e.result = result;
      e.status = result.status ?? "pending-review";
      e.jobId = ["ingest", "query", "lint"].includes(e.kind)
        ? result.id
        : undefined;
      await persist();
      return result;
    } catch (error) {
      e.error = error.message;
      e.status = [
        "CONNECTION_FAILED",
        "INVALID_JSON",
        "INVALID_RESPONSE",
      ].includes(error.message)
        ? "outcome-unknown"
        : "blocked";
      await persist();
      throw error;
    }
  }
  async function enqueue(e) {
    const all = entries(),
      old = all[e.id];
    if (old) {
      if (old.fingerprint !== e.fingerprint)
        throw Error("IDEMPOTENCY_CONFLICT");
      return execute(old);
    }
    if (Object.keys(all).length >= 1000) throw Error("QUEUE_FULL");
    all[e.id] = e;
    await persist();
    return execute(e);
  }
  return {
    registerSource: (input) =>
      run(async () => {
        const q = parseLocal(selectedSource, input);
        requireId(q.id);
        const content = await readSelected(sourceRoot, q.file);
        const digest = hash(content);
        return enqueue({
          ...q,
          kind: "register",
          digest,
          fingerprint: hash([q, digest]),
          status: "queued",
        });
      }),
    knowledge: (input) =>
      run(async () => {
        const q = parseLocal(knowledgeOperation, input);
        requireId(q.id);
        return enqueue({ ...q, fingerprint: hash(q), status: "queued" });
      }),
    resumeKnowledge: (id) =>
      run(async () => {
        requireId(id);
        const e = entries()[id];
        if (!e) throw Error("NOT_FOUND");
        return execute(e);
      }),
    pollKnowledge: (id) =>
      run(async () => {
        requireId(id);
        const e = entries()[id];
        if (!e?.jobId) throw Error("JOB_RECEIPT_REQUIRED");
        try {
          const result = await request("knowledge-job", { id: e.jobId });
          e.result = result;
          e.status = result.status;
          e.error = result.error ?? null;
          await persist();
          return result;
        } catch (error) {
          e.error = error.message;
          e.status = "unconfirmed";
          await persist();
          throw error;
        }
      }),
    knowledgeStatus: () => run(async () => Object.values(entries()).map(view)),
  };
}
