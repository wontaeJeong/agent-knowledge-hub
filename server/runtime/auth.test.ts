import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { fixture } from "../test-support";
import { OidcAuth } from "./auth";
import { RuntimeService } from "./knowledge";
import { createRuntimeHandler } from "./http";

let f: Awaited<ReturnType<typeof fixture>>,
  app: Server,
  provider: Server,
  origin: string,
  issuer: string;
let nonce = "",
  allowed = true,
  tokenCodeCalls = 0,
  forged = false;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwt = (claims: unknown) => {
  const input =
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString(
      "base64url",
    ) +
    "." +
    Buffer.from(JSON.stringify(claims)).toString("base64url");
  return (
    input +
    "." +
    sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")
  );
};
beforeAll(async () => {
  f = await fixture();
  provider = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/realms/test/.well-known/openid-configuration")
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          userinfo_endpoint: issuer + "/userinfo",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
    if (req.url === "/realms/test/jwks")
      return res.end(
        JSON.stringify({
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              kid: "test",
              alg: "RS256",
              use: "sig",
            },
          ],
        }),
      );
    if (req.url === "/realms/test/token") {
      tokenCodeCalls++;
      let raw = "";
      for await (const c of req) raw += c.toString();
      const body = new URLSearchParams(raw);
      if (body.get("code") !== "valid" || !body.get("code_verifier")) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: "invalid_grant" }));
      }
      const now = Math.floor(Date.now() / 1000);
      let idToken = jwt({
        iss: issuer,
        sub: "real-user",
        aud: "knowledge-hub",
        iat: now,
        exp: now + 300,
        nonce,
      });
      if (forged)
        idToken =
          idToken.slice(0, idToken.lastIndexOf(".") + 1) +
          Buffer.alloc(256).toString("base64url");
      return res.end(
        JSON.stringify({
          access_token: "live-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        }),
      );
    }
    if (req.url === "/realms/test/userinfo") {
      if (!allowed) {
        res.writeHead(401);
        return res.end("{}");
      }
      return res.end(JSON.stringify({ sub: "real-user", groups: ["writers"] }));
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}/realms/test`;
  app = createServer();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const env = { ...process.env };
  Object.assign(process.env, {
    APP_ORIGIN: origin,
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: "knowledge-hub",
    OIDC_CLIENT_SECRET: "test-secret",
    OIDC_ALLOW_HTTP: "true",
    OIDC_GROUP_ROLES: JSON.stringify({ writers: "editor" }),
    WORKSPACE_ID: f.workspaceId,
    NODE_ENV: "test",
  });
  try {
    const auth = await OidcAuth.create(f.pool);
    app.on(
      "request",
      createRuntimeHandler({
        pool: f.pool,
        service: new RuntimeService(f.pool),
        auth,
        origin,
        workspaceId: f.workspaceId,
      }),
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
test("forged ID token signature cannot mint a database session", async () => {
  forged = true;
  const login = await fetch(origin + "/auth/login", { redirect: "manual" });
  const authorization = new URL(login.headers.get("location")!);
  nonce = authorization.searchParams.get("nonce")!;
  const result = await fetch(
    origin +
      "/auth/callback?code=valid&state=" +
      authorization.searchParams.get("state"),
    {
      redirect: "manual",
      headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0] },
    },
  );
  expect(result.status).not.toBe(302);
  expect(result.headers.get("set-cookie")).toBeNull();
});
afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => provider.close(() => r()));
  await f.pool.end();
});
test("real discovery/JWKS signature code flow, nonce/state and replay rejection; IdP disable fails closed", async () => {
  forged = false;
  tokenCodeCalls = 0;
  const login = await fetch(origin + "/auth/login", { redirect: "manual" });
  expect(login.status).toBe(302);
  const authorization = new URL(login.headers.get("location")!);
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  nonce = authorization.searchParams.get("nonce")!;
  const loginCookie = login.headers.get("set-cookie")!.split(";")[0];
  const callback =
    origin +
    "/auth/callback?code=valid&state=" +
    authorization.searchParams.get("state");
  const result = await fetch(callback, {
    redirect: "manual",
    headers: { Cookie: loginCookie },
  });
  expect(result.status).toBe(302);
  expect(tokenCodeCalls).toBe(1);
  const sessionCookie = result.headers.get("set-cookie")!.split(";")[0];
  expect(result.headers.get("set-cookie")).toContain("HttpOnly");
  expect(
    (
      await fetch(callback, {
        redirect: "manual",
        headers: { Cookie: loginCookie },
      })
    ).status,
  ).toBe(401);
  expect(tokenCodeCalls).toBe(1);
  const me = await fetch(origin + "/api/v1/me", {
    headers: { Cookie: sessionCookie },
  });
  expect(me.status).toBe(200);
  const data = await me.json();
  expect(data.principalId).toMatch(/^[a-f0-9]{64}$/);
  expect(data.role).toBe("editor");
  allowed = false;
  expect(
    (await fetch(origin + "/api/v1/me", { headers: { Cookie: sessionCookie } }))
      .status,
  ).toBe(401);
  allowed = true;
  expect(
    (await fetch(origin + "/api/v1/me", { headers: { Cookie: sessionCookie } }))
      .status,
  ).toBe(401);
});
