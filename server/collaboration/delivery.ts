import { request } from "node:https";
import type { DigestGateway, DigestPayload, DeliveryReceipt } from "./types";
export interface GatewayOptions {
  url: string;
  allowedOrigins: readonly string[];
  token?: string;
  ca?: string | Buffer;
  timeoutMs?: number;
  maxResponseBytes?: number;
  statusPath?: string;
}
export function createDigestGateway(options: GatewayOptions): DigestGateway {
  const endpoint = new URL(options.url);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !options.allowedOrigins.includes(endpoint.origin)
  )
    throw Error("GATEWAY_NOT_APPROVED");
  const timeout = options.timeoutMs ?? 5000,
    limit = options.maxResponseBytes ?? 32768;
  if (
    !Number.isInteger(timeout) ||
    timeout < 10 ||
    timeout > 30000 ||
    !Number.isInteger(limit) ||
    limit < 100 ||
    limit > 65536
  )
    throw Error("GATEWAY_CONFIGURATION");
  const statusPath = options.statusPath ?? "/deliveries/";
  if (
    !statusPath.startsWith("/") ||
    statusPath.includes("?") ||
    statusPath.includes("#")
  )
    throw Error("GATEWAY_CONFIGURATION");
  async function call(
    url: URL,
    method: string,
    signal: AbortSignal,
    body?: DigestPayload,
  ): Promise<DeliveryReceipt | null> {
    signal.throwIfAborted();
    const serialized = body ? JSON.stringify(body) : undefined;
    if (serialized && Buffer.byteLength(serialized) > 100000)
      throw Error("DELIVERY_PAYLOAD_LIMIT");
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          ca: options.ca,
          rejectUnauthorized: true,
          signal,
          headers: {
            Accept: "application/json",
            ...(serialized
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(serialized),
                  "Idempotency-Key": body!.deliveryId,
                }
              : {}),
            ...(options.token
              ? { Authorization: "Bearer " + options.token }
              : {}),
          },
        },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              req.destroy(Error("GATEWAY_RESPONSE_LIMIT"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => reject(Error("GATEWAY_UNAVAILABLE")));
          res.on("end", () => {
            if (res.statusCode === 404 && method === "GET") {
              resolve(null);
              return;
            }
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400
            ) {
              reject(Error("GATEWAY_REDIRECT_DENIED"));
              return;
            }
            if (
              res.statusCode !== 200 &&
              res.statusCode !== 201 &&
              res.statusCode !== 202
            ) {
              reject(
                Error(
                  res.statusCode &&
                    res.statusCode >= 400 &&
                    res.statusCode < 500
                    ? "GATEWAY_REJECTED"
                    : "GATEWAY_UNAVAILABLE",
                ),
              );
              return;
            }
            try {
              const r = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (
                r.deliveryId !==
                  (body?.deliveryId ??
                    decodeURIComponent(
                      url.pathname.slice(statusPath.length),
                    )) ||
                typeof r.receiptId !== "string" ||
                !/^[a-zA-Z0-9_-]{1,200}$/.test(r.receiptId) ||
                !["accepted", "delivered"].includes(r.status)
              )
                throw Error();
              resolve({
                deliveryId: r.deliveryId,
                receiptId: r.receiptId,
                status: r.status,
              });
            } catch {
              reject(Error("GATEWAY_RECEIPT_INVALID"));
            }
          });
        },
      );
      req.setTimeout(timeout, () => req.destroy(Error("GATEWAY_TIMEOUT")));
      req.on("error", (error) =>
        reject(
          Error(
            error instanceof Error && /^GATEWAY_[A-Z_]+$/.test(error.message)
              ? error.message
              : "GATEWAY_UNAVAILABLE",
          ),
        ),
      );
      if (serialized) req.write(serialized);
      req.end();
    });
  }
  return {
    send: async (input) => {
      const payload = await input.finalize();
      if (!payload) return null;
      return call(endpoint, "POST", input.signal, payload);
    },
    status: (input) =>
      call(
        new URL(
          statusPath + encodeURIComponent(input.deliveryId),
          endpoint.origin,
        ),
        "GET",
        input.signal,
      ),
  };
}
