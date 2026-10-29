export async function readJsonBody(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<unknown> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw Error("INPUT_TOO_LARGE");
    parts.push(chunk);
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(parts),
    );
    return JSON.parse(raw || "{}");
  } catch {
    throw Error("VALIDATION_FAILED");
  }
}
