import { createPublicKey, verify } from "node:crypto";
import { request } from "node:https";
import { z } from "zod";

export type RecipientIdentity = {
  workspaceId: string;
  principalId: string;
  identityIssuer: string;
  subject: string;
};
export type RecipientBinding = (
  identity: RecipientIdentity,
  options: { signal: AbortSignal },
) => Promise<{ address: string; verifiedAt: string; validUntil: string }>;
/** Approved HTTPS endpoint returns a short-lived Ed25519 JWT for exactly the requested canonical subject. */
export function createRecipientBinding(options: {
  url: string;
  allowedOrigins: readonly string[];
  issuer: string;
  publicKey: string;
  token?: string;
  ca?: string | Buffer;
}): RecipientBinding {
  const endpoint = new URL(options.url),
    issuer = new URL(options.issuer),
    key = createPublicKey(options.publicKey);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !options.allowedOrigins.includes(endpoint.origin) ||
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    key.asymmetricKeyType !== "ed25519"
  )
    throw Error("RECIPIENT_CONFIGURATION");
  return async (identity, { signal }) => {
    try {
      const body = JSON.stringify(identity);
      const token = await new Promise<string>((resolve, reject) => {
        const req = request(
          endpoint,
          {
            method: "POST",
            ca: options.ca,
            signal,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              ...(options.token
                ? { Authorization: `Bearer ${options.token}` }
                : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 16384) req.destroy(Error("RECIPIENT_STATUS_UNKNOWN"));
              else chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () => {
              try {
                if (res.statusCode !== 200) throw Error();
                resolve(
                  z
                    .object({ token: z.string().max(12000) })
                    .strict()
                    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
                    .token,
                );
              } catch {
                reject(Error("RECIPIENT_STATUS_UNKNOWN"));
              }
            });
          },
        );
        req.setTimeout(5000, () =>
          req.destroy(Error("RECIPIENT_STATUS_UNKNOWN")),
        );
        req.on("error", reject);
        req.end(body);
      });
      const parts = token.split(".");
      if (
        parts.length !== 3 ||
        parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
      )
        throw Error();
      const header = z
        .object({ alg: z.literal("EdDSA"), typ: z.literal("JWT") })
        .strict()
        .parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
      void header;
      if (
        !verify(
          null,
          Buffer.from(parts[0] + "." + parts[1]),
          key,
          Buffer.from(parts[2], "base64url"),
        )
      )
        throw Error();
      const claims = z
        .object({
          iss: z.string(),
          aud: z.literal("collaboration-recipient"),
          iat: z.number().int(),
          exp: z.number().int(),
          workspaceId: z.string(),
          principalId: z.string(),
          identityIssuer: z.string(),
          subject: z.string(),
          email: z.string().email().max(254),
          email_verified: z.literal(true),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
      const now = Date.now();
      if (
        claims.iss !== options.issuer ||
        claims.workspaceId !== identity.workspaceId ||
        claims.principalId !== identity.principalId ||
        claims.identityIssuer !== identity.identityIssuer ||
        claims.subject !== identity.subject ||
        claims.iat * 1000 > now + 5000 ||
        claims.iat * 1000 < now - 30000 ||
        claims.exp * 1000 <= now ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 30
      )
        throw Error();
      return {
        address: claims.email,
        verifiedAt: new Date(claims.iat * 1000).toISOString(),
        validUntil: new Date(claims.exp * 1000).toISOString(),
      };
    } catch {
      throw Error("RECIPIENT_STATUS_UNKNOWN");
    }
  };
}
