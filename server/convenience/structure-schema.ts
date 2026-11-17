import type { PoolClient } from "pg";
/** This page-linked product metadata is never an authority/control-table exemption. */
export async function assertDocumentOrderSchema(
  db: PoolClient,
  errorCode: string,
) {
  const columns = (
    await db.query(
      "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='workflow_document_order' ORDER BY column_name",
    )
  ).rows;
  if (!columns.length) return; // Pre-143 recovery can inspect older backups.
  const actual = columns.map(
    (c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`,
  );
  if (
    JSON.stringify(actual) !==
    JSON.stringify([
      "page_id:text:NO",
      "position:bigint:NO",
      "workspace_id:text:NO",
    ])
  )
    throw Error(errorCode);
}
