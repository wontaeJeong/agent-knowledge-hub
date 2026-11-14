import { test, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID, createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { migrate, transaction } from "../database";
import { captureEnvelope } from "../provenance";
import { loadState } from "../repository";
import { createServer } from "node:http";
import * as oidc from "openid-client";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { initializeSessionPolicy } from "../identity/sessions";
import { createRuntimeJobs } from "../jobs/runtime";
import { KnowledgeService } from "../service";
import { source, page } from "../test-support";
import type { IncomingMessage } from "node:http";

test("pre-010 migration captures only proven session membership and leaves unverified identities quarantined", async () => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "legacy_proof_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(
      "CREATE TABLE schema_migrations(version integer PRIMARY KEY,hash text NOT NULL)",
    );
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((n) => /^00[1-9]-.*\.sql$/.test(n))
      .sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations VALUES($1,$2)", [
        Number(name.split("-")[0]),
        createHash("sha256").update(sql).digest("hex"),
      ]);
    }
    const issuer = "https://old.example.test",
      pid = (s: string) =>
        createHash("sha256")
          .update(issuer + "\0" + s)
          .digest("hex");
    await pool.query("INSERT INTO workspaces VALUES('legacy'),('other'),('legacy-two')");
    for (const [subject, role] of [
      ["read", "reader"],
      ["edit", "editor"],
      ["review", "reviewer"],
      ["unknown", "reviewer"],
      ["disabled", "reviewer"],
    ]) {
      await pool.query("INSERT INTO memberships VALUES('legacy',$1,$2)", [
        pid(subject),
        role,
      ]);
      await pool.query(
        "INSERT INTO access_principals(id,display_name,enabled) VALUES($1,$2,$3)",
        [pid(subject), subject, subject !== "disabled"],
      );
      if (subject !== "unknown")
        await pool.query(
          "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,'legacy',$2,'csrf',$3,'synthetic',now()+interval '1 hour')",
          ["session-" + subject, pid(subject), subject],
        );
    }
    await pool.query("INSERT INTO memberships VALUES('other',$1,'reviewer')", [
      pid("review"),
    ]);
    await pool.query("INSERT INTO memberships VALUES('legacy-two',$1,'reviewer')",[pid('review')]);
    await pool.query("INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES('other-verified','legacy-two',$1,'csrf','review','synthetic',now()+interval '1 hour')",[pid('review')]);
    for (const [kind, id] of [
      ["source", source.id],
      ["page", page.id],
    ]) {
      await pool.query("INSERT INTO resources VALUES('legacy',$1,$2)", [
        kind,
        id,
      ]);
      for (const subject of ["read", "edit", "review"])
        await pool.query(
          "INSERT INTO resource_readers VALUES('legacy',$1,$2,$3)",
          [kind, id, pid(subject)],
        );
    }
    await pool.query(
      "INSERT INTO sources(workspace_id,id,data) VALUES('legacy',$1,$2)",
      [source.id, source],
    );
    const { versions, ...metadata } = page;
    await pool.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES('legacy',$1,$2)",
      [page.id, metadata],
    );
    await pool.query("INSERT INTO versions VALUES('legacy',$1,1,$2)", [
      page.id,
      versions[0],
    ]);
    await migrate(pool);
    expect(
      (
        await pool.query(
          "SELECT to_regclass('legacy_compat_memberships') AS relation",
        )
      ).rows[0].relation,
    ).not.toBeNull();
    const rows = (
      await pool.query(
        "SELECT workspace_id,principal_id,role,subject,revoked FROM legacy_compat_memberships ORDER BY subject,workspace_id",
      )
    ).rows;
    expect(rows).toEqual(
      ["edit", "read", "review"].map((subject) => ({
        workspace_id: "legacy",
        principal_id: pid(subject),
        role:
          subject === "edit"
            ? "editor"
            : subject === "read"
              ? "reader"
              : "reviewer",
        subject,
        revoked: false,
      })).concat([{workspace_id:'legacy-two',principal_id:pid('review'),role:'reviewer',subject:'review',revoked:false}]),
    );
    const groupBySubject: Record<string, string> = {
      read: "read",
      edit: "edit",
      review: "review",
    };
    const oidcKeys=generateKeyPairSync('rsa',{modulusLength:2048});
    let nonce='';
    const provider = createServer((req, res) => {
      res.setHeader('content-type','application/json');
      if(req.url==='/token'){
        const now=Math.floor(Date.now()/1000), enc=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
        const data=enc({alg:'RS256',kid:'test'})+'.'+enc({iss:issuer,sub:'edit',aud:'fixture',iat:now,exp:now+300,nonce});
        return res.end(JSON.stringify({access_token:'edit',token_type:'Bearer',expires_in:300,id_token:data+'.'+sign('RSA-SHA256',Buffer.from(data),oidcKeys.privateKey).toString('base64url')}));
      }
      if(req.url==='/jwks')return res.end(JSON.stringify({keys:[{...oidcKeys.publicKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'}]}));
      const subject=req.headers.authorization?.replace('Bearer ','') ?? '';
      res.end(JSON.stringify({sub:subject,groups:[groupBySubject[subject]??subject]}));
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    // Keep canonical issuer fixed; only the loopback UserInfo endpoint is synthetic.
    const config = new oidc.Configuration(
      { issuer, authorization_endpoint:providerUrl+'/authorize', token_endpoint:providerUrl+'/token', jwks_uri:providerUrl+'/jwks', userinfo_endpoint: providerUrl + "/userinfo", id_token_signing_alg_values_supported:['RS256'], token_endpoint_auth_methods_supported:['client_secret_post'], response_types_supported:['code'], subject_types_supported:['public'] },
      "fixture",
      "secret",
    );
    oidc.allowInsecureRequests(config);
    const auth = new OidcAuth(pool, config, "http://localhost", "legacy", {
      read: "reader",
      edit: "editor",
      review: "reviewer",
      unknown: "reviewer",
    }, {sessionPolicy:{absoluteSeconds:7200,idleSeconds:7000,touchSeconds:30}});
    const runtime = new RuntimeService(pool);
    const jobs = createRuntimeJobs(pool, runtime, {
      workerCount: 1,
      revalidateInteractiveGrant: (b) => auth.revalidateInteractiveGrant(b),
      assertInteractiveGrant: (db, b) => auth.assertInteractiveGrant(db, b),
    });
    const app = createServer(
      createRuntimeHandler({
        pool,
        service: runtime,
        origin: "http://localhost",
        workspaceId: "legacy",
        auth,
        jobs,
      }),
    );
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
      for (const [subject, role] of [
        ["read", "reader"],
        ["edit", "editor"],
        ["review", "reviewer"],
      ]) {
        await pool.query(
          "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,'legacy',$2,'csrf',$3,$3,now()+interval '1 hour')",
          [sessionHash(subject), pid(subject), subject],
        );
        const db = await pool.connect();
        try {
          await initializeSessionPolicy(db, {
            sessionId: sessionHash(subject),
            workspaceId: "legacy",
            principalId: pid(subject),
          });
        } finally {
          db.release();
        }
        const response = await fetch(base + "/api/v1/me", {
          headers: { cookie: `akh_session=${subject}` },
        });
        expect(response.status).toBe(200);
        const me = (await response.json()) as {
          role: string;
          capabilities: string[];
          spaceRole: string | null;
        };
        expect(me.role).toBe(role);
        expect(me.capabilities.includes("knowledge.read")).toBe(true);
        expect(me.capabilities.includes("changeset.propose")).toBe(
          role !== "reader",
        );
        expect(me.capabilities.includes("changeset.approve")).toBe(
          role === "reviewer",
        );
        expect(me.capabilities.includes("space.admin")).toBe(false);
        expect(me.spaceRole).toBeNull();
        const headers = { cookie: `akh_session=${subject}` };
        expect((await fetch(base + "/api/v1/pages", { headers })).status).toBe(
          200,
        );
        expect(
          (await fetch(base + "/api/v1/sources", { headers })).status,
        ).toBe(200);
        expect(
          (await fetch(base + "/api/v1/changesets", { headers })).status,
        ).toBe(200);
        const created = await fetch(base + "/api/v1/sources", {
          method: "POST",
          headers: {
            ...headers,
            origin: "http://localhost",
            "x-csrf-token": "csrf",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            source: {
              id: "s-" + subject,
              title: "Synthetic",
              content: "Test",
              scope: "private",
              targetPageId: "topic",
            },
            readers: [pid(subject)],
          }),
        });
        expect(created.status).toBe(role === "reader" ? 403 : 201);
      }
      const reviewHeaders={cookie:'akh_session=review',origin:'http://localhost','x-csrf-token':'csrf','content-type':'application/json'};
      const grantAttempt=await fetch(base+'/api/v1/grants',{method:'POST',headers:reviewHeaders,body:JSON.stringify({principalId:pid('review'),role:'admin',expectedVersion:1})});
      expect(grantAttempt.status).toBe(403);
      const tokenAttempt=await fetch(base+'/api/v1/credentials',{method:'POST',headers:reviewHeaders,body:JSON.stringify({actions:['knowledge.read'],expiresAt:new Date(Date.now()+3600000).toISOString()})});
      expect(tokenAttempt.status).toBe(403);
      await pool.query("UPDATE identity_session_activity SET created_at=clock_timestamp()-interval '4000 seconds',last_seen_at=clock_timestamp() WHERE session_id=$1",[sessionHash('edit')]);
      const longSession=await (await fetch(base+'/api/v1/me',{headers:{cookie:'akh_session=edit'}})).json() as {role:string;capabilities:string[]};
      expect(longSession.role).toBe('editor');expect(longSession.capabilities).toContain('changeset.propose');
      await pool.query("UPDATE identity_session_activity SET created_at=clock_timestamp(),last_seen_at=clock_timestamp() WHERE session_id=$1",[sessionHash('edit')]);
      {
        const login=await fetch(base+'/auth/login',{redirect:'manual'});
        const authorization=new URL(login.headers.get('location')!);nonce=authorization.searchParams.get('nonce')!;
        const callback=await fetch(base+'/auth/callback?code=valid&state='+encodeURIComponent(authorization.searchParams.get('state')!),{redirect:'manual',headers:{cookie:login.headers.get('set-cookie')!.split(';')[0]}});
        expect(callback.status).toBe(302);
        const freshCookie=callback.headers.get('set-cookie')!.split(';')[0];
        const me=await (await fetch(base+'/api/v1/me',{headers:{cookie:freshCookie}})).json() as {workspaceId:string;role:string};
        expect(me).toMatchObject({workspaceId:'legacy',role:'editor'});
      }
      groupBySubject.read = "review";
      const raised = (await (
        await fetch(base + "/api/v1/me", {
          headers: { cookie: "akh_session=read" },
        })
      ).json()) as { role: string; capabilities: string[] };
      expect(raised.role).toBe("reader");
      expect(raised.capabilities).not.toContain("changeset.approve");
      groupBySubject.read = "read";
      await pool.query(
        "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,'legacy',$2,'csrf','unknown','unknown',now()+interval '1 hour')",
        [sessionHash("unknown"), pid("unknown")],
      );
      const unknownDb = await pool.connect();
      try {
        await initializeSessionPolicy(unknownDb, {
          sessionId: sessionHash("unknown"),
          workspaceId: "legacy",
          principalId: pid("unknown"),
        });
      } finally {
        unknownDb.release();
      }
      expect(
        (
          await fetch(base + "/api/v1/pages", {
            headers: { cookie: "akh_session=unknown" },
          })
        ).status,
      ).toBe(404);
      groupBySubject.review = "read";
      const narrowed = (await (
        await fetch(base + "/api/v1/me", {
          headers: { cookie: "akh_session=review" },
        })
      ).json()) as { role: string; capabilities: string[] };
      expect(narrowed.role).toBe("reader");
      expect(narrowed.capabilities).not.toContain("changeset.approve");
      groupBySubject.review = "review";
      const sharedSource = await fetch(base + "/api/v1/sources", {
        method: "POST",
        headers: {
          cookie: "akh_session=edit",
          origin: "http://localhost",
          "x-csrf-token": "csrf",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: {
            id: "shared-source",
            title: "Shared",
            content: "Test",
            scope: "team",
            targetPageId: "topic",
          },
          readers: [pid("edit"), pid("review")],
        }),
      });
      expect(sharedSource.status).toBe(201);
      const queued = await fetch(base + "/api/v1/query", {
        method: "POST",
        headers: {
          cookie: "akh_session=edit",
          origin: "http://localhost",
          "x-csrf-token": "csrf",
          "content-type": "application/json",
          "idempotency-key": "legacy-query",
        },
        body: JSON.stringify({ question: "question", mode: "offline" }),
      });
      const receipt = (await queued.json()) as { id: string; code?: string };
      expect({ status: queued.status, code: receipt.code }).toEqual({
        status: 202,
        code: undefined,
      });
      await jobs.worker.tick();
      const result = await fetch(base + "/api/v1/jobs-v2/" + receipt.id, {
        headers: { cookie: "akh_session=edit" },
      });
      expect(result.status).toBe(200);
      expect(((await result.json()) as { status: string }).status).toBe(
        "succeeded",
      );
      const ctx = async (subject: string) => {
        const req = {
          headers: { cookie: `akh_session=${subject}` },
        } as IncomingMessage;
        const session = await auth.authenticate(req);
        expect(session).toBeTruthy();
        return { ...session!, authorization: auth.requestGuard(req, session!) };
      };
      const editor = await ctx("edit"),
        reviewer = await ctx("review"),
        core = new KnowledgeService(pool);
      const draft = [
        {
          id: "topic",
          title: "주제",
          summary: "improved",
          content: "new",
          scope: "team" as const,
          links: [],
          sourceIds: [source.id],
          facts: [],
          baseVersion: 1,
        },
      ];
      const queryGrant = (
        await pool.query(
          "SELECT credential_id FROM runtime_execution_grants WHERE job_id=$1",
          [receipt.id],
        )
      ).rows[0];
      expect(queryGrant).toBeTruthy();
      const queryOnly = {
        workspaceId: "legacy",
        principalId: pid("edit"),
        credentialId: queryGrant.credential_id,
      };
      await expect(
        core.propose(
          queryOnly,
          [{ ...draft[0], id: "query-only-page", baseVersion: 0 }],
          [source.id],
        ),
      ).rejects.toThrow("FORBIDDEN");
      await expect(
        core.registerSource(queryOnly, { ...source, id: "query-only-source" }, [
          pid("edit"),
        ]),
      ).rejects.toThrow("FORBIDDEN");
      await expect(
        runtime.ingest(queryOnly, [source.id], "offline"),
      ).rejects.toThrow("FORBIDDEN");
      const approvalCandidate = await core.propose(
        editor,
        [{ ...draft[0], id: "author-acl-approval", baseVersion: 0 }],
        [source.id],
      );
      await pool.query(
        "DELETE FROM resource_readers WHERE workspace_id='legacy' AND kind='source' AND resource_id=$1 AND principal_id=$2",
        [source.id, pid("edit")],
      );
      const approvalError = await core
        .approve(reviewer, approvalCandidate.id, approvalCandidate.hash)
        .then(
          () => "SUCCESS",
          (e) => (e as Error).message,
        );
      expect.soft(approvalError).toBe("NOT_FOUND");
      if (approvalError !== "SUCCESS") {
        await pool.query(
          "INSERT INTO resource_readers VALUES('legacy','source',$1,$2)",
          [source.id, pid("edit")],
        );
        await core.approve(
          reviewer,
          approvalCandidate.id,
          approvalCandidate.hash,
        );
        await pool.query(
          "DELETE FROM resource_readers WHERE workspace_id='legacy' AND kind='source' AND resource_id=$1 AND principal_id=$2",
          [source.id, pid("edit")],
        );
      }
      const publicationError = await core
        .publish(
          reviewer,
          approvalCandidate.id,
          approvalCandidate.hash,
          "author-acl-test",
        )
        .then(
          () => "SUCCESS",
          (e) => (e as Error).message,
        );
      expect.soft(publicationError).toBe("NOT_FOUND");
      await pool.query(
        "INSERT INTO resource_readers VALUES('legacy','source',$1,$2)",
        [source.id, pid("edit")],
      );
      await pool.query(
        "DELETE FROM requests WHERE workspace_id='legacy' AND key='author-acl-test'",
      );
      await pool.query(
        "DELETE FROM publications WHERE workspace_id='legacy' AND batch_id=$1",
        [approvalCandidate.id],
      );
      await pool.query(
        "DELETE FROM approvals WHERE workspace_id='legacy' AND batch_id=$1",
        [approvalCandidate.id],
      );
      await pool.query(
        "DELETE FROM batches WHERE workspace_id='legacy' AND id=$1",
        [approvalCandidate.id],
      );
      const dependencyCandidate = await core.propose(
        editor,
        [
          {
            ...draft[0],
            id: "author-dependency-acl",
            baseVersion: 0,
            links: ["topic"],
          },
        ],
        [source.id],
      );
      await pool.query(
        "DELETE FROM resource_readers WHERE workspace_id='legacy' AND kind='page' AND resource_id='topic' AND principal_id=$1",
        [pid("edit")],
      );
      await expect(
        core.approve(
          reviewer,
          dependencyCandidate.id,
          dependencyCandidate.hash,
        ),
      ).rejects.toThrow("NOT_FOUND");
      await pool.query(
        "INSERT INTO resource_readers VALUES('legacy','page','topic',$1)",
        [pid("edit")],
      );
      await pool.query(
        "DELETE FROM batches WHERE workspace_id='legacy' AND id=$1",
        [dependencyCandidate.id],
      );
      const contextOnlySource = { ...source, id: "context-only-source" };
      await core.registerSource(editor, contextOnlySource, [
        pid("edit"),
        pid("review"),
      ]);
      const fullInput = await transaction(pool, "legacy", async (db) =>
        captureEnvelope(
          db,
          editor,
          await loadState(db, "legacy"),
          [],
          [contextOnlySource.id],
        ),
      );
      const contextCandidate = await core.propose(
        editor,
        [{ ...draft[0], id: "author-context-acl", baseVersion: 0 }],
        [source.id],
        { inputEnvelope: fullInput },
      );
      await pool.query(
        "DELETE FROM resource_readers WHERE workspace_id='legacy' AND kind='source' AND resource_id=$1 AND principal_id=$2",
        [contextOnlySource.id, pid("edit")],
      );
      await expect(
        core.approve(reviewer, contextCandidate.id, contextCandidate.hash),
      ).rejects.toThrow("NOT_FOUND");
      await pool.query(
        "INSERT INTO resource_readers VALUES('legacy','source',$1,$2)",
        [contextOnlySource.id, pid("edit")],
      );
      await pool.query(
        "DELETE FROM batches WHERE workspace_id='legacy' AND id=$1",
        [contextCandidate.id],
      );
      const own = await core.propose(reviewer, draft, [source.id]);
      await expect(core.approve(reviewer, own.id, own.hash)).rejects.toThrow(
        "FORBIDDEN",
      );
      await expect(
        runtime.reject(reviewer, own.id, own.hash),
      ).resolves.toBeTruthy();
      await pool.query(
        "DELETE FROM batches WHERE workspace_id='legacy' AND id=$1",
        [own.id],
      );
      const proposed = await core.propose(editor, draft, [source.id]);
      await pool.query(
        "UPDATE runtime_sessions SET legacy_verified_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
        [sessionHash("edit")],
      );
      await pool.query("UPDATE access_principals SET issuer=NULL,subject=NULL WHERE id=$1",[pid('edit')]);
      const {legacyStoredRole} = await import('./legacy-compat');
      expect(await legacyStoredRole(pool,'legacy',pid('edit'),'https://other-issuer.example.test')).toBeNull();
      await core.approve(reviewer, proposed.id, proposed.hash);
      await pool.query(
        "DELETE FROM resource_readers WHERE workspace_id='legacy' AND kind='source' AND resource_id=$1 AND principal_id=$2",
        [source.id, pid("review")],
      );
      await expect(
        core.publish(reviewer, proposed.id, proposed.hash, "legacy-publish"),
      ).rejects.toThrow();
      await pool.query(
        "INSERT INTO resource_readers VALUES('legacy','source',$1,$2)",
        [source.id, pid("review")],
      );
      const published = await core.publish(
        reviewer,
        proposed.id,
        proposed.hash,
        "legacy-publish",
      );
      expect(published.versions.topic).toBe(2);
      await auth.authenticate({
        headers: { cookie: "akh_session=edit" },
      } as IncomingMessage);
      const next = await core.propose(
        editor,
        [{ ...draft[0], baseVersion: 2, content: "next" }],
        [source.id],
      );
      await core.approve(reviewer, next.id, next.hash);
      const spaces=await (await fetch(base+'/api/v1/spaces',{headers:{cookie:'akh_session=review'}})).json() as {items:{id:string}[]};
      expect(spaces.items.map(item=>item.id).sort()).toEqual(['legacy','legacy-two']);
      expect((await fetch(base+'/api/v1/pages',{headers:{cookie:'akh_session=review','x-space-id':'legacy-two'}})).status).toBe(200);
      expect(
        (
          await fetch(base + "/api/v1/pages", {
            headers: { cookie: "akh_session=review", "x-space-id": "other" },
          })
        ).status,
      ).toBe(403);
      const switchResponse=await fetch(base+'/api/v1/access/switch',{method:'POST',headers:{cookie:'akh_session=review',origin:'http://localhost','x-csrf-token':'csrf','content-type':'application/json'},body:JSON.stringify({spaceId:'legacy-two'})});
      expect(switchResponse.status).toBe(200);
      const switched=await (await fetch(base+'/api/v1/me',{headers:{cookie:'akh_session=review'}})).json() as {workspaceId:string;csrfToken:string};
      expect(switched.workspaceId).toBe('legacy-two');
      const switchBack=await fetch(base+'/api/v1/access/switch',{method:'POST',headers:{cookie:'akh_session=review',origin:'http://localhost','x-csrf-token':switched.csrfToken,'content-type':'application/json'},body:JSON.stringify({spaceId:'legacy'})});
      expect(switchBack.status).toBe(200);
      const reviewerAfterSwitch = await ctx('review');
      await pool.query(
        "UPDATE memberships SET role='reader' WHERE workspace_id='legacy' AND principal_id=$1",
        [pid("edit")],
      );
      await expect(
        core.publish(reviewerAfterSwitch, next.id, next.hash, "legacy-stale"),
      ).rejects.toThrow("FORBIDDEN");
      expect(
        (
          await fetch(base + "/api/v1/pages", {
            headers: { cookie: "akh_session=edit" },
          })
        ).status,
      ).toBe(404);
      await pool.query(
        "UPDATE memberships SET role='editor' WHERE workspace_id='legacy' AND principal_id=$1",
        [pid("edit")],
      );
      expect(
        (
          await fetch(base + "/api/v1/pages", {
            headers: { cookie: "akh_session=edit" },
          })
        ).status,
      ).toBe(404);
      const login=await fetch(base+'/auth/login',{redirect:'manual'});
      const authorization=new URL(login.headers.get('location')!);nonce=authorization.searchParams.get('nonce')!;
      const callback=await fetch(base+'/auth/callback?code=valid&state='+encodeURIComponent(authorization.searchParams.get('state')!),{redirect:'manual',headers:{cookie:login.headers.get('set-cookie')!.split(';')[0]}});
      expect(callback.status).toBe(302);
      const freshCookie=callback.headers.get('set-cookie')!.split(';')[0];
      expect((await fetch(base+'/api/v1/pages',{headers:{cookie:freshCookie,'x-space-id':'legacy'}})).status).toBe(404);

      await pool.query(
        "UPDATE access_principals SET active=false WHERE id=$1",
        [pid("review")],
      );
      expect(
        (
          await fetch(base + "/api/v1/pages", {
            headers: { cookie: "akh_session=review" },
          })
        ).status,
      ).toBe(401);
      await pool.query("UPDATE access_principals SET active=true WHERE id=$1", [
        pid("review"),
      ]);
      await pool.query(
        "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,'legacy',$2,'csrf','review','review',now()+interval '1 hour')",
        [sessionHash("review2"), pid("review")],
      );
      const newDb = await pool.connect();
      try {
        await initializeSessionPolicy(newDb, {
          sessionId: sessionHash("review2"),
          workspaceId: "legacy",
          principalId: pid("review"),
        });
      } finally {
        newDb.release();
      }
      expect(
        (
          await fetch(base + "/api/v1/pages", {
            headers: { cookie: "akh_session=review2" },
          })
        ).status,
      ).toBe(200);
      await pool.query(
        "INSERT INTO access_namespaces(id,kind,slug,name) VALUES('adopted','team','adopted','Adopted')",
      );
      await pool.query(
        "INSERT INTO access_spaces(workspace_id,namespace_id,slug) VALUES('legacy','adopted','legacy')",
      );
      expect(
        (
          await fetch(base + "/api/v1/pages", {
            headers: { cookie: "akh_session=review2" },
          })
        ).status,
      ).toBe(404);
    } finally {
      await jobs.stop();
      await new Promise<void>((r) => app.close(() => r()));
      await new Promise<void>((r) => provider.close(() => r()));
    }
    await pool.query(
      "UPDATE memberships SET role='reader' WHERE workspace_id='legacy' AND principal_id=$1",
      [pid("edit")],
    );
    await pool.query(
      "UPDATE memberships SET role='editor' WHERE workspace_id='legacy' AND principal_id=$1",
      [pid("edit")],
    );
    expect(
      (
        await pool.query(
          "SELECT revoked FROM legacy_compat_memberships WHERE workspace_id='legacy' AND principal_id=$1",
          [pid("edit")],
        )
      ).rows[0].revoked,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legacy_compat_memberships WHERE workspace_id='legacy' AND NOT revoked",
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
}, 20000);

test("a database already past 010 never reconstructs historical membership from its mutable current rows", async () => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "legacy_old_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(
      "CREATE TABLE schema_migrations(version integer PRIMARY KEY,hash text NOT NULL)",
    );
    const dir = new URL("../migrations/", import.meta.url),
      names = (await readdir(dir))
        .filter((n) => /^\d+-.*\.sql$/.test(n) && Number(n.split("-")[0]) < 113)
        .sort();
    for (const name of names) {
      const version = Number(name.split("-")[0]);
      if (version === 10) {
        const id = createHash("sha256")
          .update("https://old.example.test\0person")
          .digest("hex");
        await pool.query("INSERT INTO workspaces VALUES('old')");
        await pool.query(
          "INSERT INTO memberships VALUES('old',$1,'reviewer')",
          [id],
        );
        await pool.query(
          "INSERT INTO access_principals(id,display_name) VALUES($1,'person')",
          [id],
        );
        await pool.query(
          "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES('old-session','old',$1,'csrf','person','synthetic',now()+interval '1 hour')",
          [id],
        );
      }
      const sql = await readFile(new URL(name, dir), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations VALUES($1,$2)", [
        version,
        createHash("sha256").update(sql).digest("hex"),
      ]);
    }
    await migrate(pool);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legacy_compat_memberships",
        )
      ).rows[0].n,
    ).toBe(0);
    const importer = await import("./legacy-compat");
    const recover = (importer as unknown as { importLegacyManifest?: Function })
      .importLegacyManifest;
    expect(recover).toBeTypeOf("function");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const id = createHash("sha256")
      .update("https://old.example.test\0person")
      .digest("hex");
    const installationId = (
      await pool.query("SELECT installation_id FROM legacy_compat_installation")
    ).rows[0].installation_id;
    const now = Date.now();
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        statement: "pre-010-backup",
        installationId,
        backupHash: "a".repeat(64),
        capturedAt: new Date(now - 86400000).toISOString(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(),
        entries: [
          {
            workspaceId: "old",
            principalId: id,
            role: "reviewer",
            issuer: "https://old.example.test",
            subject: "person",
          },
        ],
      }),
    );
    const signature = sign(null, bytes, privateKey),
      key = publicKey.export({ type: "spki", format: "pem" }).toString();
    await expect(
      recover!(pool, bytes, Buffer.alloc(64), key, installationId),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legacy_compat_memberships",
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      recover!(pool, bytes, signature, key, randomUUID()),
    ).rejects.toThrow();
    const expired = Buffer.from(
      JSON.stringify({
        ...JSON.parse(bytes.toString()),
        issuedAt: new Date(now - 7200000).toISOString(),
        expiresAt: new Date(now - 3600000).toISOString(),
      }),
    );
    await expect(
      recover!(
        pool,
        expired,
        sign(null, expired, privateKey),
        key,
        installationId,
      ),
    ).rejects.toThrow();
    expect(await recover!(pool, bytes, signature, key, installationId)).toEqual(
      { imported: 1 },
    );
    expect(await recover!(pool, bytes, signature, key, installationId)).toEqual(
      { imported: 0 },
    );
    const second = generateKeyPairSync("ed25519"),
      secondKey = second.publicKey
        .export({ type: "spki", format: "pem" })
        .toString();
    await expect(
      recover!(
        pool,
        bytes,
        sign(null, bytes, second.privateKey),
        secondKey,
        installationId,
      ),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT workspace_id,principal_id,role,subject,revoked FROM legacy_compat_memberships",
        )
      ).rows,
    ).toEqual([
      {
        workspace_id: "old",
        principal_id: id,
        role: "reviewer",
        subject: "person",
        revoked: false,
      },
    ]);
    await pool.query(
      "UPDATE memberships SET role='reader' WHERE workspace_id='old' AND principal_id=$1",
      [id],
    );
    await pool.query(
      "UPDATE memberships SET role='reviewer' WHERE workspace_id='old' AND principal_id=$1",
      [id],
    );
    await expect(
      recover!(pool, bytes, signature, key, installationId),
    ).rejects.toThrow();
    expect(
      (await pool.query("SELECT revoked FROM legacy_compat_memberships"))
        .rows[0].revoked,
    ).toBe(true);
  } finally {
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
