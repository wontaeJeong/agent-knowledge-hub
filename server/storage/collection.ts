import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { bounded, deadline, inspectContent, MAX_BYTES } from "./content";

/** Fail-closed public IPv4 only. IPv6 is deliberately disabled, including mapped addresses. */
export function publicAddress(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2 || b === 88)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
export type PinnedFetch = (
  url: URL,
  address: string,
  signal: AbortSignal,
) => Promise<{
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
}>;
export const pinnedHttps: PinnedFetch = (url, address, signal) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal,
        agent: false,
        headers: {
          accept: "text/plain, text/markdown",
          "accept-encoding": "identity",
        },
        lookup: (_host, _opts, cb) => cb(null, address, 4),
      },
      (res) => {
        const headers = Object.fromEntries(
          Object.entries(res.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(",") : value,
          ]),
        );
        resolve({ status: res.statusCode ?? 0, headers, body: res });
      },
    );
    req.on("error", reject);
    req.end();
  });
export interface CollectionPolicy {
  enabled: boolean;
  approvedOrigins: string[];
  timeoutMs?: number;
}
export class UrlCollector {
  constructor(
    readonly policy: CollectionPolicy,
    readonly fetch: PinnedFetch = pinnedHttps,
    readonly resolve: (host: string) => Promise<string[]> = async (host) =>
      (await lookup(host, { all: true })).map((r) => r.address),
  ) {}
  async collect(raw: string) {
    if (!this.policy.enabled || !this.policy.approvedOrigins.length)
      throw Error("EXTERNAL_COLLECTION_DISABLED");
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !this.policy.approvedOrigins.includes(url.origin)
    )
      throw Error("ORIGIN_NOT_APPROVED");
    if (
      isIP(url.hostname) ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".local")
    )
      throw Error("NETWORK_POLICY_DENIED");
    const ms = Math.max(1, Math.min(this.policy.timeoutMs ?? 10000, 30000)),
      until = Date.now() + ms;
    const addresses = await deadline(this.resolve(url.hostname), ms);
    if (!addresses.length || addresses.some((a) => !publicAddress(a)))
      throw Error("NETWORK_POLICY_DENIED");
    // Connect only to the validated address; keep URL hostname for TLS SNI/certificate checks.
    const timeout = AbortSignal.timeout(ms);
    const response = await deadline(
      this.fetch(url, addresses[0], timeout),
      Math.max(1, until - Date.now()),
    );
    const discard = () => {
      const iterator = response.body[Symbol.asyncIterator]();
      void iterator.return?.().catch(() => {});
    };
    if (response.status !== 200) {
      discard();
      throw Error(
        response.status >= 300 && response.status < 400
          ? "REDIRECT_DENIED"
          : "COLLECTION_FAILED",
      );
    }
    if (
      response.headers["content-encoding"] &&
      response.headers["content-encoding"] !== "identity"
    ) {
      discard();
      throw Error("ENCODING_DENIED");
    }
    if (Number(response.headers["content-length"]) > MAX_BYTES) {
      discard();
      throw Error("PAYLOAD_TOO_LARGE");
    }
    const mime = response.headers["content-type"]?.split(";")[0].trim();
    if (!mime || !["text/plain", "text/markdown"].includes(mime)) {
      discard();
      throw Error("UNSUPPORTED_MEDIA_TYPE");
    }
    const bytes = await bounded(
      response.body,
      MAX_BYTES,
      Math.max(1, until - Date.now()),
    );
    const filename = mime === "text/plain" ? "collected.txt" : "collected.md";
    inspectContent(bytes, mime, filename);
    return {
      bytes,
      mime,
      filename,
      origin: url.href,
      collectedAt: new Date().toISOString(),
      verification: "unverified" as const,
    };
  }
}
