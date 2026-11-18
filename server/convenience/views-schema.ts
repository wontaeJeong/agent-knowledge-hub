import type { PoolClient } from "pg";

export const isPersonalViewTable = (table: string) =>
  table === "personal_saved_views" || table === "personal_saved_view_mutations";
export const savedViewProjection = `jsonb_build_object('workspace_id',t.workspace_id,
  'private_payload_sha256',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'))`;

export async function assertSavedViewsSchema(db: PoolClient, error: string) {
  const expected: Record<string, string[]> = {
    personal_saved_views: [
      "filters:jsonb",
      "id:uuid",
      "name:text",
      "owner_id:text",
      "position:integer",
      "revision:integer",
      "workspace_id:text",
    ],
    personal_saved_view_mutations: [
      "mutation_id:uuid",
      "owner_id:text",
      "payload_hash:text",
      "revision:integer",
      "view_id:uuid",
      "workspace_id:text",
    ],
  };
  const tables = Object.keys(expected);
  const columns = (
    await db.query(
      "SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY column_name",
      [tables],
    )
  ).rows;
  if (!columns.length) {
    if (
      (await db.query("SELECT 1 FROM schema_migrations WHERE version=146"))
        .rowCount
    )
      throw Error(error);
    return;
  }
  const audited = !!(
    await db.query("SELECT 1 FROM schema_migrations WHERE version=147")
  ).rowCount;
  if (audited)
    expected.personal_saved_view_mutations.push(
      "applied_at:timestamp with time zone",
      "operation:text",
    );
  for (const table of tables) {
    const actual = columns.filter((row) => row.table_name === table);
    if (
      actual.some(
        (row) =>
          row.is_nullable !==
          (table === "personal_saved_view_mutations" &&
          ["applied_at", "operation"].includes(row.column_name)
            ? "YES"
            : "NO"),
      ) ||
      actual.map((row) => row.column_name + ":" + row.data_type).join() !==
        expected[table].sort().join()
    )
      throw Error(error);
  }
  if (
    (await db.query("SELECT 1 FROM schema_migrations WHERE version=148"))
      .rowCount
  ) {
    const guard = (
      await db.query(
        "SELECT pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint WHERE conrelid='personal_saved_view_mutations'::regclass AND contype='c' AND conname='personal_saved_view_audit_required'",
      )
    ).rows[0];
    if (
      guard?.expression !==
      "((operation IS NOT NULL) AND (applied_at IS NOT NULL))"
    )
      throw Error(error);
  }
  const foreign = (
    await db.query(
      `SELECT con.conrelid::regclass::text AS name,pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con WHERE con.contype='f' AND con.conrelid=ANY($1::regclass[])`,
      [tables],
    )
  ).rows;
  if (
    tables.some(
      (table) => foreign.filter((row) => row.name === table).length !== 1,
    ) ||
    foreign.some(
      (row) =>
        row.definition !==
        "FOREIGN KEY (workspace_id) REFERENCES workspaces(id)",
    )
  )
    throw Error(error);
}
