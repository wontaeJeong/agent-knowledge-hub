import { createHash } from "node:crypto";
export const MAX_BYTES = 1024 * 1024;
export const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
export function requireId(value) {
  if (
    typeof value !== "string" ||
    !idPattern.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw Error("VALIDATION_FAILED");
  return value;
}
export function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw Error("VALIDATION_FAILED");
  return value;
}
export const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
export function validatePage(page) {
  if (!page || typeof page !== "object") throw Error("VALIDATION_FAILED");
  requireId(page.id);
  requireId(page.spaceId);
  revision(page.version);
  if (
    typeof page.title !== "string" ||
    !page.title.trim() ||
    page.title.length > 500 ||
    typeof page.content !== "string" ||
    page.content.length > 200000 ||
    !Array.isArray(page.links) ||
    page.links.length > 500 ||
    !Array.isArray(page.sourceRefs) ||
    page.sourceRefs.length > 500 ||
    page.localCopyAllowed !== true
  )
    throw Error("VALIDATION_FAILED");
  page.links.forEach(requireId);
  for (const ref of page.sourceRefs) {
    requireId(ref.id);
    revision(ref.version);
    if (typeof ref.location !== "string" || ref.location.length > 500)
      throw Error("VALIDATION_FAILED");
  }
  if (page.upstream) {
    requireId(page.upstream.spaceId);
    requireId(page.upstream.pageId);
    revision(page.upstream.version);
  }
  return structuredClone({
    id: page.id,
    title: page.title,
    content: page.content,
    links: page.links,
    sourceRefs: page.sourceRefs,
    spaceId: page.spaceId,
    version: page.version,
    localCopyAllowed: true,
    ...(page.upstream ? { upstream: page.upstream } : {}),
  });
}
export function safeError(error) {
  const code = error?.message;
  return typeof code === "string" && /^[A-Z_]{3,50}$/.test(code)
    ? code
    : "CONNECTION_FAILED";
}
export function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}
export async function readJsonBody(stream) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("INVALID_JSON");
  }
}
