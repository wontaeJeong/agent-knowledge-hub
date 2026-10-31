import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { sealExport } from "../../server/operations/service";
import { OperationsService } from "../../server/operations/service";
import { authorizeInTransaction } from "../../server/access";
import { PhysicalDeletionStore } from "../../server/operations/filesystem";
import {
  readRecoveryLedger,
  refreshRestoredLedger,
} from "../../server/operations/recovery";
import {
  previewErasure,
  executeErasure,
} from "../../server/operations/erasure";
import {
  readCurrentPolicy,
  previewCurrentPolicyRelease,
  releaseCurrentPolicy,
  verifiedRestoreIdentity,
} from "../../server/operations/current-policy";
const [command, file, outputOrPreviewId, previewHash] = process.argv.slice(2),
  env = process.env;
let pool: Pool | undefined;
try {
  if (command === "sign") {
    if (
      !env.CURRENT_POLICY_ENCRYPTION_KEY ||
      !env.CURRENT_POLICY_SIGNING_KEY ||
      !file ||
      !outputOrPreviewId
    )
      throw Error("CONFIG_REQUIRED");
    const input = JSON.parse(await readFile(file, "utf8")),
      encrypted = sealExport(
        input,
        env.CURRENT_POLICY_ENCRYPTION_KEY,
        env.CURRENT_POLICY_SIGNING_KEY,
      );
    readCurrentPolicy(
      encrypted,
      env.CURRENT_POLICY_ENCRYPTION_KEY,
      env.CURRENT_POLICY_SIGNING_KEY,
      { source: input.source, target: input.target, backup: input.backup },
    );
    await writeFile(outputOrPreviewId, encrypted, { mode: 0o600, flag: "wx" });
    console.log(
      "독립 현재 정책 서명·암호화 완료. 과거 reviewer에서 Owner를 추정하지 않았습니다.",
    );
  } else {
    if (!env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    if (command === "replay-ledger") {
      if (
        !file ||
        !env.AUDIT_EXPORT_KEY ||
        !env.AUDIT_SIGNING_KEY ||
        env.RECOVERY_RELEASE_CONFIRMATION !==
          "REFRESH_SIGNED_LEDGER_KEEP_QUARANTINE"
      )
        throw Error("CURRENT_LEDGER_REPLAY_CONFIRMATION_REQUIRED");
      console.log(
        JSON.stringify(
          await refreshRestoredLedger(
            pool,
            readRecoveryLedger(
              await readFile(file, "utf8"),
              env.AUDIT_EXPORT_KEY,
              env.AUDIT_SIGNING_KEY,
            ),
          ),
          null,
          2,
        ),
      );
    } else if (command === "identity")
      console.log(JSON.stringify(await verifiedRestoreIdentity(pool), null, 2));
    else {
      if (
        !file ||
        !env.CURRENT_POLICY_ENCRYPTION_KEY ||
        !env.CURRENT_POLICY_SIGNING_KEY ||
        !env.RECOVERY_OPERATOR_ID
      )
        throw Error("CONFIG_REQUIRED");
      const config = {
        encrypted: await readFile(file, "utf8"),
        key: env.CURRENT_POLICY_ENCRYPTION_KEY,
        signingKey: env.CURRENT_POLICY_SIGNING_KEY,
        operatorId: env.RECOVERY_OPERATOR_ID,
      };
      if (command === "preview")
        console.log(
          JSON.stringify(
            await previewCurrentPolicyRelease(pool, config),
            null,
            2,
          ),
        );
      else if (command === "release" || command === "import-policy")
        console.log(
          JSON.stringify(
            await releaseCurrentPolicy(pool, {
              ...config,
              previewId: outputOrPreviewId,
              previewHash,
              confirm: env.RECOVERY_RELEASE_CONFIRMATION ?? "",
              keepQuarantined: command === "import-policy",
            }),
            null,
            2,
          ),
        );
      else if (
        command === "erasure-preview" ||
        command === "erasure-execute" ||
        command === "erasure-purge"
      ) {
        const p = readCurrentPolicy(
          config.encrypted,
          config.key,
          config.signingKey,
          await verifiedRestoreIdentity(pool),
        );
        if (
          !p.operators.includes(config.operatorId) ||
          !p.spaces.some(
            (s) =>
              s.workspaceId === outputOrPreviewId &&
              s.owners.includes(config.operatorId),
          )
        )
          throw Error("EXPLICIT_CURRENT_OWNER_REQUIRED");
        const service = new OperationsService(pool, authorizeInTransaction, {
            physicalDeletionGateConfirmed:
              env.RECOVERY_PHYSICAL_DELETION_GATE_CONFIRMED === "true",
          }),
          ctx = {
            workspaceId: outputOrPreviewId,
            principalId: config.operatorId,
          };
        if (command === "erasure-purge") {
          if (
            env.RECOVERY_ERASURE_CONFIRMATION !==
              "PURGE_PREVIOUSLY_APPROVED_BLOBS" ||
            !service.options.physicalDeletionGateConfirmed
          )
            throw Error("EXPLICIT_PHYSICAL_PURGE_CONFIRMATION_REQUIRED");
          const deletion = new PhysicalDeletionStore(
            env.AKH_BLOB_ROOT ?? env.CONTENT_DIRECTORY ?? "",
          );
          if (
            !/\/akh-verified-restore-[a-zA-Z0-9]+\/content$/.test(deletion.root)
          )
            throw Error("ISOLATED_RESTORE_CONTENT_DIRECTORY_REQUIRED");
          console.log(
            JSON.stringify(
              await service.purgeApprovedBlobs(ctx, (h) => deletion.remove(h)),
              null,
              2,
            ),
          );
        } else
          console.log(
            JSON.stringify(
              command === "erasure-preview"
                ? await previewErasure(service, ctx, { scope: "workspace" })
                : await executeErasure(service, ctx, {
                    scope: "workspace",
                    previewHash,
                    confirm: env.RECOVERY_ERASURE_CONFIRMATION ?? "",
                  }),
              null,
              2,
            ),
          );
      } else throw Error("COMMAND_REQUIRED");
    }
  }
} catch (e) {
  console.error(
    e instanceof Error && /^[A-Z_]+$/.test(e.message)
      ? e.message
      : "CURRENT_POLICY_OPERATION_FAILED",
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
