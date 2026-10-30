import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  DirectorySubject,
  DirectoryStatus,
  RuntimeIdentityOptions,
} from "../jobs/identity";

const proofSchema = z
  .object({
    principalId: z.string().min(1).max(100),
    issuer: z.string().url().nullable(),
    subject: z.string().min(1).max(500).nullable(),
    active: z.boolean().nullable(),
    verifiedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
  })
  .strict();
type DirectoryOptions = Pick<
  RuntimeIdentityOptions,
  "directoryStatus" | "directoryProviderId" | "maxDirectoryAgeMs"
>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw Error("DIRECTORY_STATUS_UNKNOWN");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw Error("DIRECTORY_STATUS_UNKNOWN");
      }
      chunks.push(next.value);
    }
    return JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    reader.releaseLock();
  }
}
function exactUrl(raw: string | undefined) {
  if (!raw) throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash)
    throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
  return url;
}
/** Only trusted process configuration selects authority/transport; no caller URL, credentials or grants are accepted. */
function buildDirectory(
  env: NodeJS.ProcessEnv,
  dependencies: { fetch?: typeof fetch },
): DirectoryOptions {
  const provider = env.AKH_DIRECTORY_PROVIDER;
  if (!provider || provider === "none") {
    if (env.AKH_DIRECTORY_STATUS_URL)
      throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
    return {};
  }
  const maxAge = Number(env.AKH_DIRECTORY_MAX_AGE_MS ?? 30000),
    timeout = Number(env.AKH_DIRECTORY_TIMEOUT_MS ?? 5000);
  if (
    !Number.isInteger(maxAge) ||
    maxAge < 100 ||
    maxAge > 300000 ||
    !Number.isInteger(timeout) ||
    timeout < 10 ||
    timeout > 10000
  )
    throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
  const request = dependencies.fetch ?? fetch;
  if (provider === "approved-http") {
    const url = exactUrl(env.AKH_DIRECTORY_STATUS_URL),
      origins = z
        .array(z.string().url())
        .max(20)
        .parse(JSON.parse(env.AKH_DIRECTORY_ALLOWED_ORIGINS ?? "[]"));
    if (
      url.protocol !== "https:" ||
      !origins.includes(url.origin) ||
      !env.AKH_DIRECTORY_STATUS_TOKEN
    )
      throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
    return {
      directoryProviderId: `approved-directory-v1:${sha(url.href)}`,
      maxDirectoryAgeMs: maxAge,
      directoryStatus: async (subject) => {
        try {
          if (!subject.issuer || !subject.subject)
            throw Error("DIRECTORY_STATUS_UNKNOWN");
          const response = await request(url.href, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(timeout),
            headers: {
              "content-type": "application/json",
              Authorization: `Bearer ${env.AKH_DIRECTORY_STATUS_TOKEN}`,
            },
            body: JSON.stringify(subject),
          });
          const proof = proofSchema.parse(await boundedJson(response)),
            now = Date.now(),
            at = Date.parse(proof.verifiedAt),
            until = Date.parse(proof.validUntil);
          if (
            proof.principalId !== subject.principalId ||
            proof.issuer !== subject.issuer ||
            proof.subject !== subject.subject ||
            at > now + 5000 ||
            at < now - maxAge ||
            until <= now ||
            until > at + maxAge
          )
            throw Error("DIRECTORY_STATUS_UNKNOWN");
          return proof;
        } catch {
          throw Error("DIRECTORY_STATUS_UNKNOWN");
        }
      },
    };
  }
  if (
    provider !== "keycloak-local" ||
    env.NODE_ENV === "production" ||
    env.OIDC_ALLOW_HTTP !== "true"
  )
    throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
  const base = exactUrl(env.OIDC_INTERNAL_URL),
    issuer = exactUrl(env.OIDC_ISSUER),
    realm = issuer.pathname
      .replace(/\/$/, "")
      .match(/^\/realms\/([a-zA-Z0-9_-]+)$/)?.[1];
  const hosts = ["localhost", "127.0.0.1", "knowledge-keycloak"];
  const username = env.AKH_DIRECTORY_ADMIN_USERNAME,
    password = env.AKH_DIRECTORY_ADMIN_PASSWORD;
  const roles = z
    .record(z.string(), z.enum(["reader", "editor", "reviewer"]))
    .parse(JSON.parse(env.OIDC_GROUP_ROLES ?? "{}"));
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !hosts.includes(base.hostname) ||
    base.pathname !== "/" ||
    !realm ||
    !username ||
    !password ||
    !Object.keys(roles).length
  )
    throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
  let cached: { token: string; until: number } | undefined,
    pending: Promise<string> | undefined;
  const adminToken = async (signal: AbortSignal) => {
    if (cached && cached.until > Date.now()) return cached.token;
    if (pending) return pending;
    pending = (async () => {
      const response = await request(
        new URL("/realms/master/protocol/openid-connect/token", base).href,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "password",
            client_id: "admin-cli",
            username,
            password,
          }),
        },
      );
      const result = z
        .object({
          access_token: z.string().min(1).max(12000),
          expires_in: z.number().positive().max(86400),
        })
        .passthrough()
        .parse(await boundedJson(response));
      cached = {
        token: result.access_token,
        until:
          Date.now() +
          Math.max(0, Math.min(60000, result.expires_in * 1000 - 5000)),
      };
      return cached.token;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
  return {
    directoryProviderId: `keycloak-local-v1:${sha(issuer.href + "|" + base.href)}`,
    maxDirectoryAgeMs: maxAge,
    directoryStatus: async (
      subject: DirectorySubject,
    ): Promise<DirectoryStatus> => {
      try {
        if (
          subject.issuer !== issuer.href.replace(/\/$/, "") ||
          !subject.subject ||
          subject.subject.length > 500
        )
          throw Error("DIRECTORY_STATUS_UNKNOWN");
        const signal = AbortSignal.timeout(timeout),
          token = await adminToken(signal),
          headers = { Authorization: `Bearer ${token}` };
        const path = `/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(subject.subject)}`;
        const userResponse = await request(new URL(path, base).href, {
          redirect: "error",
          signal,
          headers,
        });
        if (userResponse.status === 401) cached = undefined;
        const user = z
          .object({ id: z.string(), enabled: z.boolean() })
          .passthrough()
          .parse(await boundedJson(userResponse));
        if (user.id !== subject.subject)
          throw Error("DIRECTORY_STATUS_UNKNOWN");
        let active = user.enabled;
        if (active) {
          const memberships = z
            .array(
              z
                .object({ name: z.string(), path: z.string().optional() })
                .passthrough(),
            )
            .max(1000)
            .parse(
              await boundedJson(
                await request(new URL(path + "/groups", base).href, {
                  redirect: "error",
                  signal,
                  headers,
                }),
              ),
            );
          active = memberships.some(
            (group) =>
              Object.hasOwn(roles, group.name) ||
              Boolean(group.path && Object.hasOwn(roles, group.path)),
          );
        }
        const now = Date.now();
        return {
          ...subject,
          active,
          verifiedAt: new Date(now).toISOString(),
          validUntil: new Date(now + maxAge).toISOString(),
        };
      } catch {
        throw Error("DIRECTORY_STATUS_UNKNOWN");
      }
    },
  };
}
export function directoryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { fetch?: typeof fetch } = {},
): DirectoryOptions {
  try {
    return buildDirectory(env, dependencies);
  } catch {
    throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
  }
}
