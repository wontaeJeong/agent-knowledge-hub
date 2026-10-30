import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { tsImport } from "tsx/esm/api";
import {
  coordinatedBackup,
  openBundle,
  restoreFiles,
  FileTarget,
  MUTATION_GATE,
} from "./operations-backup.mjs";
import { releaseGate } from "./operations-release.mjs";
const base = [
  "--context",
  "kind-knowledge-hub-dev",
  "-n",
  "agent-knowledge-hub-local",
  "exec",
  "-i",
  "knowledge-db-0",
  "--",
];
const run = (args, input) =>
  execFileSync("kubectl", [...base, ...args], {
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
test("actual PostgreSQL dump + filesystem, quiescence blocks concurrent mutation, restore & fault", async () => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes("/akh_operations_test"));
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 4,
  });
  const { MUTATION_GATE: serverGate, acquireSharedMutationGate } =
    await tsImport("../../server/operations/gate.ts", import.meta.url);
  assert.equal(serverGate, MUTATION_GATE);
  const root = await mkdtemp(join(await realpath(tmpdir()), "akh-db-backup-")),
    content = join(root, "content");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(content);
  const bytes = Buffer.from("private real blob"),
    sha = createHash("sha256").update(bytes).digest("hex"),
    ws = randomUUID();
  const target = new FileTarget(
      join(root, "independent-mount-fixture"),
      content,
    ),
    key = "backup-key".repeat(6);
  const restore = "akh_ops_restore_" + randomUUID().replaceAll("-", "");
  let created = false;
  try {
    await pool.query("INSERT INTO workspaces VALUES($1)", [ws]);
    await pool.query("INSERT INTO resources VALUES($1,'source','s')", [ws]);
    await pool.query(
      "INSERT INTO sources(workspace_id,id,data) VALUES($1,'s',$2)",
      [ws, { id: "s", content: "real source" }],
    );
    await pool.query(
      "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,'b','source','s',$2,$3,'text/plain','a.txt','clean','test')",
      [ws, sha, bytes.length],
    );
    await writeFile(join(content, sha), bytes);
    let writer;
    let wrote = false;
    const result = await coordinatedBackup({
      pool,
      contentDirectory: content,
      target,
      key,
      keyId: "v1",
      gateConfirmed: true,
      dumpDatabase: async () => {
        writer = (async () => {
          const db = await pool.connect();
          try {
            await db.query("BEGIN");
            await acquireSharedMutationGate(db);
            await db.query(
              "UPDATE sources SET data=jsonb_set(data,'{content}','\"later\"') WHERE workspace_id=$1",
              [ws],
            );
            await db.query("COMMIT");
            wrote = true;
          } finally {
            db.release();
          }
        })();
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(wrote, false);
        return run([
          "pg_dump",
          "-U",
          "knowledge",
          "-d",
          "akh_operations_test",
          "-Fc",
        ]);
      },
    });
    await writer;
    assert.equal(wrote, true);
    const image = "registry.example/akh@sha256:" + "a".repeat(64);
    const release = {
      image,
      pool,
      backup: {
        verifiedAt: new Date().toISOString(),
        checksum: result.checksum,
      },
      resources: [
        {
          kind: "Deployment",
          metadata: { name: "knowledge-app" },
          spec: {
            template: { spec: { containers: [{ name: "app", image }] } },
          },
        },
        {
          kind: "Ingress",
          spec: {
            tls: [{ secretName: "tls", hosts: ["knowledge.example.com"] }],
          },
        },
        { kind: "NetworkPolicy", metadata: { name: "default-deny" } },
        {
          kind: "ConfigMap",
          metadata: { name: "knowledge-config" },
          data: {
            NODE_ENV: "production",
            APP_ORIGIN: "https://knowledge.example.com",
            OIDC_ISSUER: "https://idp.example.com",
          },
        },
      ],
    };
    assert.equal((await releaseGate(release)).allowed, true);
    const expected = (
      await pool.query("SELECT hash FROM schema_migrations WHERE version=25")
    ).rows[0].hash;
    try {
      await pool.query(
        "UPDATE schema_migrations SET hash='tampered' WHERE version=25",
      );
      await assert.rejects(releaseGate(release), /SCHEMA_NOT_CURRENT/);
    } finally {
      await pool.query(
        "UPDATE schema_migrations SET hash=$1 WHERE version=25",
        [expected],
      );
    }
    const bundle = openBundle(await target.get(result.name), { v1: key });
    await restoreFiles(bundle, join(root, "restored"), []);
    assert.deepEqual(await readFile(join(root, "restored", sha)), bytes);
    run(["createdb", "-U", "knowledge", restore]);
    created = true;
    run(
      [
        "pg_restore",
        "-U",
        "knowledge",
        "--exit-on-error",
        "--no-owner",
        "-d",
        restore,
      ],
      bundle.dump,
    );
    const restoredUrl = new URL(process.env.TEST_DATABASE_URL);
    restoredUrl.pathname = "/" + restore;
    const restored = new pg.Pool({ connectionString: restoredUrl.href });
    try {
      assert.equal(
        (
          await restored.query(
            "SELECT data->>'content' AS content FROM sources WHERE workspace_id=$1",
            [ws],
          )
        ).rows[0].content,
        "real source",
      );
      assert.equal(
        (
          await restored.query(
            "SELECT sha256 FROM storage_blobs WHERE workspace_id=$1",
            [ws],
          )
        ).rows[0].sha256,
        sha,
      );
      const {
        secureRestoredDatabase,
        readRecoveryLedger,
        assertOperationalStartup,
        captureRecoveryLedger,
      } = await tsImport(
        "../../server/operations/recovery.ts",
        import.meta.url,
      );
      const { sealExport, openExport } = await tsImport(
        "../../server/operations/service.ts",
        import.meta.url,
      );
      const signing = "independent-signing".repeat(4),
        ledger = {
          version: 1,
          at: new Date().toISOString(),
          readers: [],
          tombstones: [
            {
              workspace_id: ws,
              id: randomUUID(),
              resource_kind: "source",
              resource_id: "s",
              blob_hashes: [sha],
              allowed_readers: [],
              delete_content: true,
              approved_by: "fixture-admin",
            },
          ],
        };
      const current = readRecoveryLedger(
        sealExport(ledger, key, signing),
        key,
        signing,
      );
      const existing = openExport(
        await captureRecoveryLedger(pool, key, signing),
        key,
        signing,
      );
      const ledgerFile = join(root, "current-recovery-ledger");
      await writeFile(
        ledgerFile,
        sealExport(
          {
            ...ledger,
            tombstones: [...existing.tombstones, ...ledger.tombstones],
          },
          key,
          signing,
        ),
        { mode: 0o600 },
      );
      const cli = execFileSync(
        process.execPath,
        ["scripts/k8s/verify-restore.mjs", join(target.root, result.name)],
        {
          env: {
            ...process.env,
            DATABASE_URL: process.env.TEST_DATABASE_URL,
            RECOVERY_LEDGER_FILE: ledgerFile,
            AUDIT_EXPORT_KEY: key,
            AUDIT_SIGNING_KEY: signing,
            BACKUP_KEYS_JSON: JSON.stringify({ v1: key }),
          },
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      assert.match(cli, /삭제\/권한 제한 재적용 검증/);
      const secured = await secureRestoredDatabase(restored, current);
      assert.equal(secured.quarantined, true);
      await assert.rejects(assertOperationalStartup(restored), /QUARANTINED/);
      assert.equal(
        (
          await restored.query(
            "SELECT data->>'content' AS content FROM sources WHERE workspace_id=$1",
            [ws],
          )
        ).rows[0].content,
        "",
      );
      assert.equal(
        Number(
          (await restored.query("SELECT count(*) FROM resource_readers"))
            .rows[0].count,
        ),
        0,
      );
      const deletionRoot = join(root, "deleted-replay");
      await restoreFiles(bundle, deletionRoot, secured.deletedHashes);
      await assert.rejects(readFile(join(deletionRoot, sha)));
      assert.throws(
        () =>
          readRecoveryLedger(
            sealExport({ ...ledger, at: "2020-01-01T00:00:00Z" }, key, signing),
            key,
            signing,
          ),
        /STALE/,
      );
      await assert.rejects(secureRestoredDatabase(pool, current), /ISOLATED/);
    } finally {
      await restored.end();
    }
    const backupCli = execFileSync(
      process.execPath,
      [
        "scripts/k8s/backup.mjs",
        "kind-knowledge-hub-dev",
        "agent-knowledge-hub-local",
        target.root,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          CONTENT_DIRECTORY: content,
          AGENT_KNOWLEDGE_HUB_BACKUP_KEY: key,
          BACKUP_KEY_ID: "cli-v1",
          BACKUP_MUTATION_GATE_CONFIRMED: "true",
        },
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    assert.match(backupCli, /DB\+파일 백업 검증 완료/);
    await assert.rejects(
      coordinatedBackup({
        pool,
        contentDirectory: content,
        target,
        key,
        keyId: "v1",
        gateConfirmed: false,
        dumpDatabase: async () => Buffer.from("x"),
      }),
      /GATE/,
    );
    await assert.rejects(
      coordinatedBackup({
        pool,
        contentDirectory: content,
        target,
        key,
        keyId: "v1",
        gateConfirmed: true,
        dumpDatabase: async () => {
          throw Error("DUMP_FAULT");
        },
      }),
      /DUMP_FAULT/,
    );
    const failure = (
      await pool.query(
        "SELECT count(*) FROM operations_backups WHERE status='failed'",
      )
    ).rows[0].count;
    assert.ok(Number(failure) > 0);
  } finally {
    if (created) run(["dropdb", "-U", "knowledge", restore]);
    await pool.end();
  }
});
