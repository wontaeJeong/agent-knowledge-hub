import { productionFailures } from "./release.mjs";
import { tsImport } from "tsx/esm/api";
const immutable = (image) =>
  typeof image === "string" && /^\S+@sha256:[a-f0-9]{64}$/.test(image);
/** Read-only evidence gate. Deployment still uses the existing release/migration functions; no fake deploy result. */
export async function releaseGate({
  resources,
  image,
  backup,
  pool,
  maxBackupAgeMs = 900000,
}) {
  if (!immutable(image)) throw Error("IMMUTABLE_IMAGE_REQUIRED");
  const failures = productionFailures(resources);
  if (failures.length) throw Error(`PRODUCTION_GATE: ${failures.join(", ")}`);
  const age = Date.now() - Date.parse(backup?.verifiedAt);
  if (
    !/^[a-f0-9]{64}$/.test(backup?.checksum ?? "") ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > maxBackupAgeMs
  )
    throw Error("RECENT_VERIFIED_BACKUP_REQUIRED");
  if (!pool) throw Error("SCHEMA_DATABASE_REQUIRED");
  const { assertSchemaCurrent } = await tsImport(
    "../../server/database.ts",
    import.meta.url,
  );
  await assertSchemaCurrent(pool);
  const { assertOperationalStartup } = await tsImport(
    "../../server/operations/recovery.ts",
    import.meta.url,
  );
  await assertOperationalStartup(pool);
  const app = resources.find(
    (r) => r.kind === "Deployment" && r.metadata?.name === "knowledge-app",
  );
  if (!app?.spec?.template?.spec?.containers?.some((c) => c.image === image))
    throw Error("IMAGE_MANIFEST_MISMATCH");
  return { allowed: true, image, databaseRollback: false };
}
export function rollbackGate({ image, current, compatible }) {
  if (!immutable(image)) throw Error("IMMUTABLE_IMAGE_REQUIRED");
  if (
    !Array.isArray(current) ||
    !current.length ||
    !Array.isArray(compatible) ||
    current.length !== compatible.length ||
    current.some(
      (row) =>
        !compatible.some(
          (c) => c.version === row.version && c.hash === row.hash,
        ),
    )
  )
    throw Error("ROLLBACK_SCHEMA_INCOMPATIBLE_RESTORE_REQUIRED");
  return { allowed: true, image, databaseRollback: false };
}
