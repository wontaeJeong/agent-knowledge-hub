import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Source, Page } from "../src/domain/types";
import { migrate } from "./database";

export const source: Source = {
  id: "source-a", title: "실행 자료", tool: "fixture", project: "test",
  content: "## 지식: 재시도\n실패 시 재시도한다.", scope: "team", verification: "미검증",
  createdAt: "2026-10-29T00:00:00Z", processed: false, targetPageId: "topic",
};
export const page: Page = {
  id: "topic", title: "주제", summary: "시험 주제", category: "기술 설계", scope: "team",
  status: "미검증", owner: "team", tags: [], favorite: false, reused: 0, links: [], facts: [],
  versions: [{ id: "v1", number: 1, content: "기존 내용", author: "editor", reason: "fixture",
    at: "2026-10-29T00:00:00Z", sourceIds: [source.id] }],
};

export async function fixture() {
  if (!process.env.TEST_DATABASE_URL) throw Error("TEST_DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, connectionTimeoutMillis: 3000 });
  await migrate(pool);
  const workspaceId = randomUUID();
  await pool.query("INSERT INTO workspaces VALUES($1)", [workspaceId]);
  for (const [id, role] of [["editor", "editor"], ["reviewer", "reviewer"], ["reader", "reader"]]) {
    await pool.query("INSERT INTO memberships VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  for (const [kind, id] of [["source", source.id], ["page", page.id]]) {
    await pool.query("INSERT INTO resources VALUES($1,$2,$3)", [workspaceId, kind, id]);
    for (const who of ["editor", "reviewer", "reader"]) {
      await pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)", [workspaceId, kind, id, who]);
    }
  }
  await pool.query("INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)", [workspaceId, source.id, source]);
  const { versions, ...metadata } = page;
  await pool.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)", [workspaceId, page.id, metadata]);
  await pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [workspaceId, page.id, versions[0]]);
  return { pool, workspaceId, ctx: { workspaceId, principalId: "reviewer" },
    editor: { workspaceId, principalId: "editor" }, reader: { workspaceId, principalId: "reader" } };
}
