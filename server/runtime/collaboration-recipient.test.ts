import { test, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { testTlsCertificate } from "../test-tls-fixture";

test("approved HTTPS binding returns only a signed, fresh, exact principal and subject address", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { cert, key } = testTlsCertificate();
  let subject = "subject-1";
  const server = createServer({ cert, key }, async (_req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const data =
      enc({ alg: "EdDSA", typ: "JWT" }) +
      "." +
      enc({
        iss: "https://directory.example.test",
        aud: "collaboration-recipient",
        iat: now,
        exp: now + 20,
        workspaceId: "space",
        principalId: "principal",
        identityIssuer: "https://id.example.test",
        subject,
        email: "person@example.test",
        email_verified: true,
      });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        token:
          data +
          "." +
          sign(null, Buffer.from(data), privateKey).toString("base64url"),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `https://127.0.0.1:${(server.address() as { port: number }).port}/proof`;
  try {
    const runtime = await import("./collaboration-host");
    const create = (runtime as unknown as { createRecipientBinding?: Function })
      .createRecipientBinding;
    expect(create).toBeTypeOf("function");
    const resolve = create!({
      url,
      allowedOrigins: [new URL(url).origin],
      issuer: "https://directory.example.test",
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      ca: cert,
    });
    const input = {
      workspaceId: "space",
      principalId: "principal",
      identityIssuer: "https://id.example.test",
      subject: "subject-1",
    };
    expect(
      await resolve(input, { signal: new AbortController().signal }),
    ).toMatchObject({ address: "person@example.test" });
    subject = "other";
    await expect(
      resolve(input, { signal: new AbortController().signal }),
    ).rejects.toThrow("RECIPIENT_STATUS_UNKNOWN");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("production delivery config is off by default and rejects incomplete or unapproved configuration", async () => {
  const runtime = await import("./collaboration-host");
  const parse = (
    runtime as unknown as { collaborationDeliveryFromEnvironment?: Function }
  ).collaborationDeliveryFromEnvironment;
  expect(parse).toBeTypeOf("function");
  expect(parse!({})).toEqual({});
  expect(() =>
    parse!({ AKH_COLLABORATION_RECIPIENT_URL: "https://proof.example.test/" }),
  ).toThrow("COLLABORATION_DELIVERY_CONFIGURATION");
});

test("configured signed proof and TLS gateway send no digest bytes after source revocation at final gate", async () => {
  const { fixture, adoptFixture } = await import("../test-support");
  const { createCollaborationHost, createRecipientBinding } =
    await import("./collaboration-host");
  const { createDigestGateway } = await import("../collaboration");
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "UPDATE access_principals SET issuer='https://id.example.test',subject='subject-1' WHERE id='editor'",
  );
  await f.pool.query(
    "INSERT INTO access_principals(id,kind) VALUES('collab-dispatcher','service')",
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"),
    { cert, key } = testTlsCertificate();
  let proofs = 0,
    sends = 0;
  const server = createServer({ cert, key }, async (req, res) => {
    if (req.url === "/proof") {
      proofs++;
      if (proofs === 2)
        await f.pool.query(
          "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
          [f.workspaceId],
        );
      const now = Math.floor(Date.now() / 1000),
        enc = (v: unknown) =>
          Buffer.from(JSON.stringify(v)).toString("base64url");
      const data =
        enc({ alg: "EdDSA", typ: "JWT" }) +
        "." +
        enc({
          iss: "https://directory.example.test",
          aud: "collaboration-recipient",
          iat: now,
          exp: now + 20,
          workspaceId: f.workspaceId,
          principalId: "editor",
          identityIssuer: "https://id.example.test",
          subject: "subject-1",
          email: "person@example.test",
          email_verified: true,
        });
      res.end(
        JSON.stringify({
          token:
            data +
            "." +
            sign(null, Buffer.from(data), privateKey).toString("base64url"),
        }),
      );
    } else {
      sends++;
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = createCollaborationHost(
    f.pool,
    "https://knowledge.example.test",
    {
      dispatcherId: "collab-dispatcher",
      directoryProviderId: "fixture",
      directoryStatus: async (subject) => ({
        ...subject,
        active: true,
        verifiedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 20000).toISOString(),
      }),
      recipientBinding: createRecipientBinding({
        url: origin + "/proof",
        allowedOrigins: [origin],
        issuer: "https://directory.example.test",
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        ca: cert,
      }),
      gateway: createDigestGateway({
        url: origin + "/deliveries",
        allowedOrigins: [origin],
        ca: cert,
      }),
    },
  );
  try {
    await host.service.preferences(f.editor, {
      expectedRevision: 0,
      dailyDigest: true,
    });
    await host.service.syncPlans();
    await f.pool.query(
      "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data,created_at) VALUES($1,'signed-notif','editor','topic',1,'publication','{}',now())",
      [f.workspaceId],
    );
    await f.pool.query(
      "UPDATE collaboration_digest_plans SET next_at=clock_timestamp()+interval '1 millisecond',cursor_at=clock_timestamp()-interval '1 day' WHERE workspace_id=$1",
      [f.workspaceId],
    );
    await new Promise((r) => setTimeout(r, 10));
    await host.worker.tick();
    expect(proofs).toBe(2);
    expect(sends).toBe(0);
    expect((await host.service.deliveries(f.editor)).items[0].status).toBe(
      "no-delivery",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
