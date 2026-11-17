import { test, expect } from "vitest";
import { selectErasureRows, scrubProductValue } from "./erasure";
test("actual lineage propagates source→page→draft→answer→claim/review; text mentions cannot select unrelated pages", () => {
  const rows = [
    {
      table: "sources",
      locator: "(0,1)",
      data: { id: "s", content: "original" },
    },
    {
      table: "versions",
      locator: "(0,2)",
      data: { page_id: "p", data: { sourceIds: ["s"], content: "copy" } },
    },
    {
      table: "workflow_drafts",
      locator: "(0,3)",
      data: { id: "d", data: { pageId: "p", content: "draft copy" } },
    },
    {
      table: "runtime_answers",
      locator: "(0,4)",
      data: { id: "a", data: { pageIds: ["p"], answer: "answer copy" } },
    },
    {
      table: "refinement_claims",
      locator: "(0,5)",
      data: { id: "c", data: { answerId: "a", claim: "claim copy" } },
    },
    {
      table: "refinement_reviews",
      locator: "(0,6)",
      data: { id: "r", claim_id: "c", data: { comment: "review copy" } },
    },
    {
      table: "pages",
      locator: "(0,7)",
      data: {
        id: "unrelated",
        data: { summary: "s is mentioned but not ancestry" },
      },
    },
  ];
  const selected = selectErasureRows(rows, { kind: "source", id: "s" });
  expect(selected.map((r) => r.table)).toEqual(
    rows.slice(0, 6).map((r) => r.table),
  );
  const scrubbed = scrubProductValue({
    sourceIds: ["s"],
    content: "secret",
    conditions: { description: "secret" },
    title: "secret",
    sha256: "a".repeat(64),
  });
  expect(JSON.stringify(scrubbed)).not.toContain("secret");
  expect(scrubbed).toMatchObject({ sourceIds: ["s"], sha256: "a".repeat(64) });
});
test("publication event follows its originating batch into source erasure without a selected page", () => {
  const rows = [
    {
      table: "batches",
      locator: "(0,1)",
      data: { id: "batch", data: { snapshots: [{ sourceId: "source" }] } },
    },
    {
      table: "collaboration_events",
      locator: "(0,2)",
      data: {
        id: "publication:batch:other-page",
        kind: "publication",
        page_id: "other-page",
        resource_id: "batch",
        revision: "1",
      },
    },
    {
      table: "workflow_notifications",
      locator: "(0,3)",
      data: { id: "notice", data: { eventId: "publication:batch:other-page" } },
    },
    {
      table: "pages",
      locator: "(0,4)",
      data: { id: "other-page", data: { title: "Independent page" } },
    },
  ];
  expect(
    selectErasureRows(rows, { kind: "source", id: "source" }).map(
      (r) => r.table,
    ),
  ).toEqual(["batches", "collaboration_events", "workflow_notifications"]);
});
test("only the persisted disclosure registration carries an affected owned draft into its source and publication descendants", () => {
  const row = (table: string, id: string, data: Record<string, unknown>) => ({
    table,
    locator: id,
    data: { id, ...data },
  });
  const rows = [
    row("sources", "origin", {}),
    row("workflow_draft_disclosures", "origin-review", {
      owner_id: "owner",
      draft_id: "origin-draft",
      source_id: "origin",
    }),
    row("workflow_templates", "template", {
      owner_id: "owner",
      data: { sourceDraftId: "origin-draft" },
    }),
    row("workflow_drafts", "copy", {
      owner_id: "owner",
      data: { templateId: "template" },
    }),
    row("workflow_draft_disclosures", "copy-review", {
      owner_id: "owner",
      draft_id: "copy",
      source_id: "copy-source",
    }),
    row("sources", "copy-source", {}),
    row("batches", "copy-batch", {
      data: { snapshots: [{ sourceId: "copy-source" }] },
    }),
    row("versions", "v", {
      page_id: "copy-page",
      data: { sourceIds: ["copy-source"] },
    }),
    row("workflow_draft_disclosures", "other-owner", {
      owner_id: "other",
      draft_id: "copy",
      source_id: "unrelated-source",
    }),
    row("sources", "unrelated-source", {}),
    row("sources", "forged", {
      data: {
        manualOwnerId: "owner",
        manualDraftId: "copy",
        source_id: "unrelated-source",
      },
    }),
  ];
  expect(
    selectErasureRows(rows, { kind: "source", id: "origin" }).map(
      (r) => r.data.id,
    ),
  ).toEqual([
    "origin",
    "origin-review",
    "template",
    "copy",
    "copy-review",
    "copy-source",
    "copy-batch",
    "v",
  ]);
});
