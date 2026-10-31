import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { Pool, PoolClient } from "pg";
import type { Context } from "../../service";
import { AccessService } from "../../access/index";
import type {
  InteractiveSessionBinding,
  InteractiveSessionSnapshot,
  RuntimeIdentityOptions,
} from "../identity";
import type { RuntimeJobsBridge } from "../runtime";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Actual HTTP UserInfo + parent-session DAO fixture, not a company IdP claim. */
export async function browserIdentity(
  pool: Pool,
  identity: Context,
  servers: Server[],
) {
  const raw = "fixture-browser-" + randomUUID(),
    sessionId = hash(raw),
    csrf = "fixture-csrf-" + randomUUID(),
    accessToken = "fixture-access-" + randomUUID(),
    subject = "fixture-sub-" + randomUUID();
  let active = true,
    identityRole: "reader" | "editor" | "reviewer" = "editor",
    calls = 0,
    lockedNetworkCalls = 0;
  const userInfo = createServer(async (_req, res) => {
    calls++;
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT",
        [identity.workspaceId],
      );
      await db.query("ROLLBACK");
    } catch {
      lockedNetworkCalls++;
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
    const allowed =
      active && _req.headers.authorization === "Bearer " + accessToken;
    res.writeHead(allowed ? 200 : 401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        allowed
          ? { sub: subject, identityRole }
          : { error: "disabled-or-invalid-token" },
      ),
    );
  });
  servers.push(userInfo);
  userInfo.listen(0, "127.0.0.1");
  await once(userInfo, "listening");
  const url = `http://127.0.0.1:${(userInfo.address() as { port: number }).port}/userinfo`;
  await pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      sessionId,
      identity.workspaceId,
      identity.principalId,
      csrf,
      subject,
      accessToken,
      new Date(Date.now() + 3600000),
    ],
  );
  const assert = async (
    db: Pick<PoolClient, "query">,
    binding: InteractiveSessionBinding,
  ) => {
    const row = (
      await db.query(
        "SELECT * FROM runtime_sessions WHERE id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()",
        [binding.sessionId, binding.principalId],
      )
    ).rows[0];
    if (
      !row ||
      (binding.snapshot &&
        (hash(row.csrf) !== binding.snapshot.csrfHash ||
          hash(row.subject) !== binding.snapshot.subjectHash))
    )
      throw Error("UNAUTHENTICATED");
    return row;
  };
  const revalidate = async (
    binding: InteractiveSessionBinding,
    options?: { signal: AbortSignal },
  ): Promise<InteractiveSessionSnapshot> => {
    const row = await assert(pool, binding),
      res = await fetch(url, {
        headers: { Authorization: "Bearer " + row.access_token },
        signal: options?.signal,
      });
    if (!res.ok) throw Error("UNAUTHENTICATED");
    const info = (await res.json()) as {
      sub: string;
      identityRole: "reader" | "editor" | "reviewer";
    };
    if (info.sub !== row.subject) throw Error("UNAUTHENTICATED");
    const access = await new AccessService(pool).effective({
      principalId: binding.principalId,
      workspaceId: binding.workspaceId,
    });
    return {
      role: access.capabilities.includes("changeset.approve")
        ? "reviewer"
        : access.capabilities.includes("changeset.propose")
          ? "editor"
          : "reader",
      identityRole: info.identityRole,
      csrfHash: hash(row.csrf),
      subjectHash: hash(row.subject),
    };
  };
  const options: RuntimeIdentityOptions = {
    revalidateInteractiveGrant: revalidate,
    assertInteractiveGrant: async (db, binding) => {
      await assert(db, binding);
    },
  };
  const authorization = {
    sessionId,
    revalidate: async () => {
      await revalidate({
        sessionId,
        principalId: identity.principalId,
        workspaceId: identity.workspaceId,
      });
    },
    assertSession: async (db: PoolClient) => {
      await assert(db, {
        sessionId,
        principalId: identity.principalId,
        workspaceId: identity.workspaceId,
      });
    },
  };
  const ctx = {
    workspaceId: identity.workspaceId,
    principalId: identity.principalId,
    authorization,
  };
  return {
    ctx,
    sessionId,
    raw,
    csrf,
    accessToken,
    options,
    setActive: (value: boolean) => {
      active = value;
    },
    setIdentityRole: (value: typeof identityRole) => {
      identityRole = value;
    },
    calls: () => calls,
    lockedNetworkCalls: () => lockedNetworkCalls,
  };
}

/** Host-style transport fixture: authenticates the real parent pointer, keeps
 * CSRF, returns202/polls results, and logs out through the existing session DAO. */
export async function browserTransport(
  pool: Pool,
  browser: Awaited<ReturnType<typeof browserIdentity>>,
  bridge: RuntimeJobsBridge,
  servers: Server[],
) {
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      const raw = req.headers.cookie?.match(
        /(?:^|;\s*)akh_session=([^;]+)/,
      )?.[1];
      if (!raw || hash(raw) !== browser.sessionId)
        throw Error("UNAUTHENTICATED");
      if (
        req.method === "POST" &&
        req.headers["x-csrf-token"] !== browser.csrf
      ) {
        send(403, { code: "CSRF_FAILED" });
        return;
      }
      if (req.url === "/logout") {
        await pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
          hash(raw),
        ]);
        send(200, { ok: true });
        return;
      }
      await browser.ctx.authorization.revalidate();
      if (req.method === "GET" && req.url?.startsWith("/jobs/")) {
        send(200, await bridge.read(browser.ctx, req.url.slice(6)));
        return;
      }
      if (
        req.method === "POST" &&
        ["/query", "/ingest", "/lint"].includes(req.url ?? "")
      ) {
        let rawBody = "";
        for await (const c of req) rawBody += c;
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string") throw Error("IDEMPOTENCY_KEY_REQUIRED");
        send(
          202,
          await bridge.submitInteractive(
            browser.ctx,
            req.url!.slice(1) as "query" | "ingest" | "lint",
            JSON.parse(rawBody),
            key,
          ),
        );
        return;
      }
      send(404, { code: "NOT_FOUND" });
    } catch (e) {
      send(e instanceof Error && e.message === "UNAUTHENTICATED" ? 401 : 400, {
        code: e instanceof Error ? e.message : "REQUEST_FAILED",
      });
    }
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
