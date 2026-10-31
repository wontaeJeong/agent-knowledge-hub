import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("real approved TLS webhook/email delivery, rejection and timeout without external network", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "akh-alert-tls-")),
    key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "pipe" },
  );
  const received = [];
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push({
        path: req.url,
        body: JSON.parse(body),
        id: req.headers["idempotency-key"],
        auth: req.headers.authorization,
      });
      if (req.url === "/timeout") {
        const timer = setTimeout(() => {
          res.writeHead(200);
          res.end();
        }, 500);
        timer.unref();
        return;
      }
      res.writeHead(req.url === "/fail" ? 503 : 200);
      res.end();
    },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `https://127.0.0.1:${server.address().port}`;
  try {
    const script = `import {webhookAdapter,emailGatewayAdapter} from './server/operations/monitoring.ts';
 const origin=${JSON.stringify(origin)},base={allowedOrigins:[origin],token:'synthetic-relay-token'},alert={id:'incident-1',code:'MODEL_UNAVAILABLE'};
 await webhookAdapter({...base,url:origin+'/ok'})(alert);
 await emailGatewayAdapter({...base,url:origin+'/mail',recipients:['ops@example.com']})(alert);
 for(const path of ['/fail','/timeout']){let failed=false;try{await webhookAdapter({...base,url:origin+path,timeoutMs:30})(alert);}catch{failed=true;}if(!failed)throw Error('EXPECTED_FAILURE');}
 console.log('VERIFIED');`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    const code = await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /VERIFIED/);
    assert.deepEqual(received[0].body, {
      id: "incident-1",
      code: "MODEL_UNAVAILABLE",
    });
    assert.equal(received[0].id, "incident-1");
    assert.equal(received[0].auth, "Bearer synthetic-relay-token");
    assert.deepEqual(received[1].body.to, ["ops@example.com"]);
    assert.equal(received.length, 4);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
