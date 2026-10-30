import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { directoryFromEnvironment } from "./directory";
test("unconfigured service directory stays unknown and development admin mode is forbidden in production", () => {
  expect(directoryFromEnvironment({})).toEqual({});
  expect(() =>
    directoryFromEnvironment({
      NODE_ENV: "production",
      AKH_DIRECTORY_PROVIDER: "keycloak-local",
      OIDC_ALLOW_HTTP: "true",
    }),
  ).toThrow("DIRECTORY_CONFIGURATION_REQUIRED");
  expect(() =>
    directoryFromEnvironment({
      AKH_DIRECTORY_PROVIDER: "approved-http",
      AKH_DIRECTORY_STATUS_URL: "http://169.254.169.254/status",
    }),
  ).toThrow("DIRECTORY_CONFIGURATION_REQUIRED");
});
test("approved HTTP authority resolves only the exact bound subject, with real bounded transport and no product grant changes", async () => {
  let corrupt = false;
  const calls: { url: string; authorization: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      url: req.url!,
      authorization: String(req.headers.authorization),
      body,
    });
    const input = JSON.parse(body),
      now = Date.now();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ...input,
        principalId: corrupt ? "other" : input.principalId,
        active: true,
        verifiedAt: new Date(now).toISOString(),
        validUntil: new Date(now + 10000).toISOString(),
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const provider = directoryFromEnvironment(
      {
        AKH_DIRECTORY_PROVIDER: "approved-http",
        AKH_DIRECTORY_STATUS_URL: "https://directory.example.invalid/status",
        AKH_DIRECTORY_ALLOWED_ORIGINS: '["https://directory.example.invalid"]',
        AKH_DIRECTORY_STATUS_TOKEN: "fixture-token-not-a-secret",
      },
      {
        fetch: (url, init) => {
          expect(String(url)).toBe("https://directory.example.invalid/status");
          expect(init?.redirect).toBe("error");
          return fetch(local + "/status", init);
        },
      },
    );
    const subject = {
      principalId: "verified-principal",
      issuer: "https://issuer.example.invalid",
      subject: "verified-subject",
    };
    expect(await provider.directoryStatus!(subject)).toMatchObject({
      ...subject,
      active: true,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toEqual(subject);
    expect(calls[0].authorization).toBe("Bearer fixture-token-not-a-secret");
    corrupt = true;
    await expect(provider.directoryStatus!(subject)).rejects.toThrow(
      "DIRECTORY_STATUS_UNKNOWN",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("local Keycloak adapter checks both enabled state and current admission groups without trusting roles from caller data", async () => {
  let enabled = true,
    groups = true;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/token")) {
      res.end(
        JSON.stringify({ access_token: "fixture-admin-token", expires_in: 60 }),
      );
      return;
    }
    if (req.headers.authorization !== "Bearer fixture-admin-token") {
      res.writeHead(401).end("{}");
      return;
    }
    if (req.url?.endsWith("/groups")) {
      res.end(
        JSON.stringify(groups ? [{ name: "writers", path: "/writers" }] : []),
      );
      return;
    }
    res.end(JSON.stringify({ id: "known-subject", enabled }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const provider = directoryFromEnvironment({
      NODE_ENV: "development",
      OIDC_ALLOW_HTTP: "true",
      AKH_DIRECTORY_PROVIDER: "keycloak-local",
      OIDC_ISSUER: "http://localhost:28081/realms/knowledge",
      OIDC_INTERNAL_URL: base,
      OIDC_GROUP_ROLES: '{"writers":"editor"}',
      AKH_DIRECTORY_ADMIN_USERNAME: "fixture-admin",
      AKH_DIRECTORY_ADMIN_PASSWORD: "fixture-only-password",
    });
    const subject = {
      principalId: "verified-principal",
      issuer: "http://localhost:28081/realms/knowledge",
      subject: "known-subject",
    };
    expect((await provider.directoryStatus!(subject)).active).toBe(true);
    enabled = false;
    expect((await provider.directoryStatus!(subject)).active).toBe(false);
    enabled = true;
    groups = false;
    expect((await provider.directoryStatus!(subject)).active).toBe(false);
    await expect(
      provider.directoryStatus!({
        ...subject,
        issuer: "https://other-issuer.example.invalid",
      }),
    ).rejects.toThrow("DIRECTORY_STATUS_UNKNOWN");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
