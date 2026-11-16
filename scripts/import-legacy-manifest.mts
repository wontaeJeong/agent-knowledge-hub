import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { assertSchemaCurrent } from "../server/database.ts";
import { importLegacyManifest } from "../server/access/legacy-compat.ts";

const {
  DATABASE_URL,
  LEGACY_MANIFEST_PATH,
  LEGACY_SIGNATURE_PATH,
  LEGACY_IMPORT_TRUSTED_ED25519_KEY,
  LEGACY_INSTALLATION_ID,
} = process.env;
if (
  !DATABASE_URL ||
  !LEGACY_MANIFEST_PATH ||
  !LEGACY_SIGNATURE_PATH ||
  !LEGACY_IMPORT_TRUSTED_ED25519_KEY ||
  !LEGACY_INSTALLATION_ID
) {
  console.error(
    "Legacy manifest import requires explicit database, manifest, signature, pinned public key and installation ID.",
  );
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const [manifest, signature] = await Promise.all([
      readFile(LEGACY_MANIFEST_PATH),
      readFile(LEGACY_SIGNATURE_PATH),
    ]);
    await assertSchemaCurrent(pool);
    const result = await importLegacyManifest(
      pool,
      manifest,
      signature,
      LEGACY_IMPORT_TRUSTED_ED25519_KEY,
      LEGACY_INSTALLATION_ID,
    );
    console.log(
      `Legacy manifest verified: ${result.imported} bindings imported.`,
    );
  } catch {
    console.error("Legacy manifest import rejected; no changes committed.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
