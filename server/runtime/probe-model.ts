/** Transport/authentication/model-advertisement probe, NOT an inference-quality or billing-success claim. */
export function modelAvailabilityProbe(config: {
  configured: boolean;
  baseUrl?: string;
  model: string | null;
  apiKey?: string;
}) {
  return async (): Promise<boolean | null> => {
    if (!config.configured || !config.baseUrl || !config.model) return null;
    let endpoint: URL;
    try {
      endpoint = new URL(config.baseUrl.replace(/\/$/, "") + "/models");
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        return null;
    } catch {
      return null;
    }
    try {
      const res = await fetch(endpoint, {
        redirect: "error",
        signal: AbortSignal.timeout(2500),
        headers: config.apiKey
          ? { Authorization: `Bearer ${config.apiKey}` }
          : {},
      });
      if ([404, 405].includes(res.status)) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return false;
      }
      if (!res.body) return null;
      const reader = res.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1048576) {
            await reader.cancel();
            return null;
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const data = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!Array.isArray(data.data)) return null;
      return data.data.some(
        (model: unknown) =>
          model !== null &&
          typeof model === "object" &&
          "id" in model &&
          model.id === config.model,
      );
    } catch {
      return false;
    }
  };
}
