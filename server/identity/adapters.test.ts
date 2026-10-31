import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import {
  signedDirectoryAuthority,
  ApprovedHttpsGlobalLogout,
} from "./adapters";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (s) =>
          new Promise<void>((resolve, reject) =>
            s.close((e) => (e ? reject(e) : resolve())),
          ),
      ),
  );
});
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
function jwt(claims: Record<string, unknown>, key = privateKey) {
  const input =
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url") +
    "." +
    Buffer.from(JSON.stringify(claims)).toString("base64url");
  return (
    input +
    "." +
    sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")
  );
}
test("actual loopback signed provider fixture: exact opaque IDs, forged signature, stale claims, issuer/subject and response-size denial", async () => {
  let responseBody = "",
    requested = "";
  const server = createServer(async (req, res) => {
    for await (const chunk of req) requested += chunk.toString();
    res.setHeader("Content-Type", "application/jwt");
    res.end(responseBody);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("FIXTURE_LISTEN");
  // Test-only loopback transport. Production adapter still requires an approved
  // HTTPS URL and verifies the response signature; this is NOT a TLS deployment test.
  const transport: typeof fetch = async (_input, init) => {
    const result = await fetch(`http://127.0.0.1:${address.port}/proof`, init);
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
  const authority = signedDirectoryAuthority({
    issuer: "https://idp.example",
    endpoint: "https://approved.example/proof",
    approvedOrigins: ["https://approved.example"],
    audience: "knowledge",
    publicKey,
    maxAgeSeconds: 60,
    fetch: transport,
  });
  const claims = {
    iss: "https://idp.example",
    sub: "opaque-sub-1",
    aud: "knowledge",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 50,
    groups: ["directory-group-id-791", "admission"],
  };
  responseBody = jwt(claims);
  const proof = await authority.verify("opaque-sub-1");
  expect(proof.groups).toEqual(["directory-group-id-791", "admission"]);
  expect(JSON.parse(requested)).toEqual({ subject: "opaque-sub-1" });
  responseBody = jwt({ ...claims, iss: "https://attacker.example" });
  await expect(authority.verify("opaque-sub-1")).rejects.toThrow(
    "DIRECTORY_IDENTITY_MISMATCH",
  );
  responseBody = jwt({ ...claims, sub: "another-subject" });
  await expect(authority.verify("opaque-sub-1")).rejects.toThrow(
    "DIRECTORY_IDENTITY_MISMATCH",
  );
  responseBody = jwt({
    ...claims,
    iat: claims.iat - 200,
    exp: claims.exp - 200,
  });
  await expect(authority.verify("opaque-sub-1")).rejects.toThrow(
    "DIRECTORY_IDENTITY_MISMATCH",
  );
  const another = generateKeyPairSync("rsa", { modulusLength: 2048 });
  responseBody = jwt(claims, another.privateKey);
  await expect(authority.verify("opaque-sub-1")).rejects.toThrow(
    "INVALID_DIRECTORY_SIGNATURE",
  );
  responseBody = "x".repeat(65537);
  await expect(authority.verify("opaque-sub-1")).rejects.toThrow(
    "IDENTITY_RESPONSE_TOO_LARGE",
  );
  expect(() =>
    signedDirectoryAuthority({
      issuer: "https://idp.example",
      endpoint: "https://evil.example/proof",
      approvedOrigins: ["https://approved.example"],
      audience: "knowledge",
      publicKey,
      maxAgeSeconds: 60,
    }),
  ).toThrow("UNAPPROVED_IDENTITY_ENDPOINT");
});
test("optional IdP logout requires a real adapter acknowledgement and approved HTTPS endpoint", async () => {
  let receipt = { revoked: false };
  let sent: unknown;
  const adapter = new ApprovedHttpsGlobalLogout({
    issuer: "https://idp.example",
    endpoint: "https://approved.example/logout",
    approvedOrigins: ["https://approved.example"],
    fetch: async (_input, init) => {
      sent = JSON.parse(init?.body as string);
      return Response.json(receipt);
    },
  });
  await expect(
    adapter.logout({ issuer: "https://idp.example", subject: "subject-1" }),
  ).rejects.toThrow("IDP_LOGOUT_UNCONFIRMED");
  receipt = { revoked: true };
  await adapter.logout({ issuer: "https://idp.example", subject: "subject-1" });
  expect(sent).toEqual({ issuer: "https://idp.example", subject: "subject-1" });
  expect(
    () =>
      new ApprovedHttpsGlobalLogout({
        issuer: "https://idp.example",
        endpoint: "http://approved.example/logout",
        approvedOrigins: ["http://approved.example"],
      }),
  ).toThrow("UNAPPROVED_IDENTITY_ENDPOINT");
});
