import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { DirectoryAuthority, type VerifiedUserInfo } from "./directory";
import type { GlobalLogoutAdapter } from "./sessions";
import type { GroupProof } from "./directory";

/** Invoke only with the result of the server's authenticated OIDC fetchUserInfo
 * (expected subject already verified by openid-client), never an HTTP body.
 * Group claim values are preserved exactly, including Keycloak paths when that
 * is the deployed mapper. They are not fabricated directory GUIDs. */
export function createVerifiedOidcDirectoryAdapter(config: {
  issuer: string;
  maxAgeSeconds?: number;
  groupClaim?: string;
  allowLoopbackHttp?: boolean;
}) {
  return async (
    subject: string,
    info: Readonly<Record<string, unknown>>,
  ): Promise<GroupProof> => {
    const authority = new DirectoryAuthority({
      issuer: config.issuer,
      maxAgeSeconds: config.maxAgeSeconds ?? 60,
      allowLoopbackHttp: config.allowLoopbackHttp,
      fetchVerifiedUserInfo: async () => ({
        issuer: config.issuer,
        subject: typeof info.sub === "string" ? info.sub : "",
        groups: info[config.groupClaim ?? "groups"] as readonly string[],
      }),
    });
    return authority.verify(subject);
  };
}

type Fetch = typeof globalThis.fetch;
function approvedEndpoint(value: string, origins: readonly string[]) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !origins.includes(url.origin)
  )
    throw Error("UNAPPROVED_IDENTITY_ENDPOINT");
  return url;
}
async function limitedText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("INVALID_IDENTITY_RESPONSE");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw Error("IDENTITY_RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** Approved external adapter: detached trust is the pinned RSA public key, not
 * an email, a claimed group name, TLS alone, or a client-supplied issuer. A local
 * provider may instead inject already verified OIDC UserInfo into DirectoryAuthority.
 * Production HTTPS and verification remain mandatory here, including fixtures. */
export function signedDirectoryAuthority(config: {
  issuer: string;
  endpoint: string;
  approvedOrigins: readonly string[];
  audience: string;
  publicKey: string | KeyObject;
  maxAgeSeconds: number;
  fetch?: Fetch;
}) {
  const endpoint = approvedEndpoint(config.endpoint, config.approvedOrigins);
  const key =
    typeof config.publicKey === "string"
      ? createPublicKey(config.publicKey)
      : config.publicKey;
  if (
    key.type !== "public" ||
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    !config.audience
  )
    throw Error("INVALID_DIRECTORY_VERIFICATION_KEY");
  return new DirectoryAuthority({
    issuer: config.issuer,
    maxAgeSeconds: config.maxAgeSeconds,
    fetchVerifiedUserInfo: async (subject): Promise<VerifiedUserInfo> => {
      const response = await (config.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/jwt",
        },
        body: JSON.stringify({ subject }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (
        !response.ok ||
        (response.url && response.url !== endpoint.href) ||
        response.headers.get("content-type")?.split(";")[0] !==
          "application/jwt"
      )
        throw Error("INVALID_DIRECTORY_RESPONSE");
      const raw = await limitedText(response, 65536),
        parts = raw.split(".");
      if (
        parts.length !== 3 ||
        parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))
      )
        throw Error("INVALID_DIRECTORY_SIGNATURE");
      const header = JSON.parse(
        Buffer.from(parts[0], "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (
        header.alg !== "RS256" ||
        header.crit ||
        header.jku ||
        header.jwk ||
        header.x5u ||
        !verify(
          "RSA-SHA256",
          Buffer.from(parts[0] + "." + parts[1]),
          key,
          Buffer.from(parts[2], "base64url"),
        )
      )
        throw Error("INVALID_DIRECTORY_SIGNATURE");
      const claims = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf8"),
        ) as Record<string, unknown>,
        now = Date.now() / 1000;
      if (
        claims.iss !== config.issuer ||
        claims.sub !== subject ||
        claims.aud !== config.audience ||
        typeof claims.iat !== "number" ||
        typeof claims.exp !== "number" ||
        claims.iat > now + 1 ||
        claims.iat < now - config.maxAgeSeconds ||
        claims.exp <= now ||
        claims.exp > claims.iat + config.maxAgeSeconds ||
        !Array.isArray(claims.groups)
      )
        throw Error("DIRECTORY_IDENTITY_MISMATCH");
      return {
        issuer: config.issuer,
        subject,
        groups: claims.groups as string[],
        validUntil: new Date(claims.exp * 1000).toISOString(),
      };
    },
  });
}
/** Optional approved revocation service, e.g. an IdP admin bridge configured
 * server-side with workload/mTLS authentication in its injected transport.
 * Success requires a bounded explicit revocation acknowledgement, not a redirect
 * or fabricated URL. No bearer material is duplicated into identity storage. */
export class ApprovedHttpsGlobalLogout implements GlobalLogoutAdapter {
  private readonly endpoint: URL;
  constructor(
    private readonly config: {
      endpoint: string;
      approvedOrigins: readonly string[];
      issuer: string;
      fetch?: Fetch;
    },
  ) {
    this.endpoint = approvedEndpoint(config.endpoint, config.approvedOrigins);
  }
  async logout(identity: { issuer: string; subject: string }): Promise<void> {
    if (identity.issuer !== this.config.issuer || !identity.subject)
      throw Error("LOGOUT_IDENTITY_MISMATCH");
    const response = await (this.config.fetch ?? fetch)(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(identity),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (response.url && response.url !== this.endpoint.href))
      throw Error("IDP_LOGOUT_FAILED");
    const receipt = JSON.parse(await limitedText(response, 4096));
    if (receipt.revoked !== true) throw Error("IDP_LOGOUT_UNCONFIRMED");
  }
}
