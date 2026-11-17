import { afterEach, beforeEach, expect, test } from "vitest";
import { fixture, adoptFixture, page, source } from "../test-support";
import { WorkflowService } from "./service";
import { RuntimeService } from "../runtime/knowledge";
import { DraftRecoveryService } from "../retention/recovery";
let f: Awaited<ReturnType<typeof fixture>>, service: WorkflowService;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  service = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    async () => {},
  );
});
afterEach(async () => {
  await f?.pool.end();
});
async function target(id = "target") {
  await f.pool.query(
    "INSERT INTO resources VALUES($1,'page',$2),($1,'source','target-source')",
    [f.workspaceId, id],
  );
  for (const who of ["editor", "reviewer"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page',$2,$3),($1,'source','target-source',$3)",
      [f.workspaceId, id, who],
    );
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,'target-source',$2)",
    [f.workspaceId, { ...source, id: "target-source" }],
  );
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, id, { ...page, id, links: [] }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
    f.workspaceId,
    id,
    { ...page.versions[0], sourceIds: ["target-source"] },
  ]);
  return `/?app=1&space=${f.workspaceId}&document=${id}`;
}
const draft = (content: string, expectedRevision = 0) => ({
  id: "closure-draft",
  title: "A",
  pageId: "topic",
  baseVersion: 1,
  content,
  expectedRevision,
});
async function revoke(kind: "page" | "source", id = "target") {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3 AND principal_id='editor'",
    [f.workspaceId, kind, kind === "page" ? id : "target-source"],
  );
}

test("incoming conflicting pins cannot replace the original stored version", async () => {
  await target();
  await service.saveDraft(f.editor, {
    ...draft("Copied text"),
    dependencyVersions: { target: 1 },
  });
  await f.pool.query("INSERT INTO versions VALUES($1,'target',2,$2)", [
    f.workspaceId,
    { ...page.versions[0], number: 2, sourceIds: ["target-source"] },
  ]);
  await expect(
    service.saveDraft(f.editor, {
      ...draft("Copied text", 1),
      dependencyVersions: { target: 2 },
    }),
  ).rejects.toThrow("STALE_VERSION");
  expect((await service.drafts(f.editor)).items[0]).toMatchObject({
    dependencyVersions: { target: 1 },
  });
});

test("__proto__ URL binding survives omission, URL removal, proposal and recovery validation", async () => {
  const href = await target("__proto__");
  await service.saveDraft(f.editor, draft(`[B](${href})`));
  const saved = await service.saveDraft(f.editor, draft("Copied text", 1));
  expect(Object.entries(saved.dependencyVersions ?? {})).toEqual([
    ["__proto__", 1],
  ]);
  await expect(
    service.submitDraft(f.editor, "closure-draft", 2, "review"),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  await f.pool.query(
    "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false),($1,'target-source',true,false)",
    [f.workspaceId],
  );
  const recovery = new DraftRecoveryService(f.pool);
  const binding = await recovery.permission(f.editor, {
    id: "closure-draft",
    pageId: "topic",
    baseVersion: 1,
    expectedRevision: 2,
    dependencyVersions: JSON.parse('{"__proto__":1}'),
  });
  expect(Object.entries(binding.dependencyVersions)).toEqual([
    ["__proto__", 1],
  ]);
  expect(await recovery.validate(f.editor, { binding })).toMatchObject({
    status: "ready",
  });
  await revoke("source");
  await expect(recovery.validate(f.editor, { binding })).rejects.toThrow();
});

for (const form of ["query", "html", "html-entity"]) {
  const content = (href: string) =>
    form === "query"
      ? `[B](${href.slice(1)})`
      : form === "html"
        ? `<a href="${href}">B</a>\n\n[B](${href})`
        : `<a HREF='${href.replaceAll("&", "&#38;")}'>B</a>\n\n[B](${href.replaceAll("&", "&#38;")})`;
  test(`${form} visible Markdown beside excluded HTML href captures the target and cannot exceed its audience`, async () => {
    const body = content(await target());
    expect(await service.saveDraft(f.editor, draft(body))).toMatchObject({
      dependencyVersions: { target: 1 },
    });
    await expect(
      service.submitDraft(f.editor, "closure-draft", 1, "review"),
    ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
    await expect(
      service.proposeEdit(f.editor, "topic", {
        baseVersion: 1,
        content: body,
        reason: "direct",
      }),
    ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  });
  for (const kind of ["page", "source"] as const)
    test(`${form} href rejects ${kind} revocation at save and submit`, async () => {
      const body = content(await target());
      await service.saveDraft(f.editor, draft(body));
      await revoke(kind);
      await expect(
        service.saveDraft(f.editor, { ...draft(body), id: "revoked-save" }),
      ).rejects.toThrow("NOT_FOUND");
      await expect(
        service.submitDraft(f.editor, "closure-draft", 1, "review"),
      ).rejects.toThrow("NOT_FOUND");
    });
}

test("rendered parser still excludes code, genuinely external links and other spaces", async () => {
  const href = await target();
  const body = `\`[B](${href.slice(1)})\`\n\n\`\`\`html\n<a href="${href}">B</a>\n\`\`\`\n[B](?app=1&space=other&document=target)\n<a href="${href.replace(f.workspaceId, "other")}">other</a>\n<a href="https://example.test${href}">external</a>\n<a href="https://workspace.invalid${href}">external reserved host</a>`;
  expect(await service.saveDraft(f.editor, draft(body))).not.toHaveProperty(
    "dependencyVersions",
  );
  expect(
    (
      await service.proposeEdit(f.editor, "topic", {
        baseVersion: 1,
        content: body,
        reason: "examples",
      })
    ).id,
  ).toBeTruthy();
});

async function legacyDraft(content: string) {
  const { expectedRevision: _, ...data } = draft(content);
  await f.pool.query(
    "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','closure-draft',1,$2)",
    [f.workspaceId, data],
  );
}
test("pre-upgrade stored URL evidence is retained before the next save removes the URL", async () => {
  await legacyDraft(`[B](${await target()})`);
  expect((await service.drafts(f.editor)).items[0]).toMatchObject({
    dependencyVersions: { target: 1 },
  });
  expect(
    await service.saveDraft(f.editor, draft("Copied text", 1)),
  ).toMatchObject({ dependencyVersions: { target: 1 } });
  await expect(
    service.submitDraft(f.editor, "closure-draft", 2, "review"),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
});
for (const kind of ["page", "source"] as const)
  test(`legacy stored URL refuses ${kind} revocation before listing, URL removal, submit or recovery`, async () => {
    await legacyDraft(`[B](${await target()})`);
    await f.pool.query(
      "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false),($1,'target-source',true,false)",
      [f.workspaceId],
    );
    await revoke(kind);
    expect((await service.drafts(f.editor)).items).toEqual([]);
    await expect(
      service.saveDraft(f.editor, draft("Copied title", 1)),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      service.submitDraft(f.editor, "closure-draft", 1, "review"),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      new DraftRecoveryService(f.pool).permission(f.editor, {
        id: "closure-draft",
        pageId: "topic",
        baseVersion: 1,
        expectedRevision: 1,
      }),
    ).rejects.toThrow();
  });

test("a template cannot discard additional stored draft lineage after URL and metadata removal", async () => {
  const content = `[B](${await target()})`;
  await service.saveDraft(f.editor, draft(content));
  await service.saveDraft(f.editor, draft("Copied title", 1));
  await expect(
    service.saveTemplate(f.editor, {
      id: "unsafe-template",
      expectedRevision: 0,
      title: "Copied",
      originPageId: "topic",
      content: "Copied title",
    }),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  await expect(
    service.saveTemplate(f.editor, {
      id: "unsafe-template-bound",
      expectedRevision: 0,
      title: "Copied",
      originPageId: "topic",
      content: "Copied title",
      sourceDraftId: "closure-draft",
      sourceDraftRevision: 2,
    }),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  expect((await service.templates(f.editor)).items).toEqual([]);
});
for (const kind of ["page", "source"] as const)
  test(`legacy derived templates are excluded from listing/reuse after ${kind} revocation`, async () => {
    await target();
    await f.pool.query(
      "INSERT INTO workflow_templates(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','legacy-template',1,$2)",
      [
        f.workspaceId,
        {
          id: "legacy-template",
          title: "Copied",
          content: "Copied title",
          originPageId: "topic",
          originVersion: 1,
          dependencyVersions: { target: 1 },
        },
      ],
    );
    await revoke(kind);
    expect((await service.templates(f.editor)).items).toEqual([]);
  });
test("ordinary plain and origin templates remain available without additional draft lineage", async () => {
  await service.saveTemplate(f.editor, {
    id: "plain-template",
    expectedRevision: 0,
    title: "Plain",
    content: "Ordinary outline",
  });
  await service.saveDraft(f.editor, draft("Own outline"));
  await service.saveTemplate(f.editor, {
    id: "origin-template",
    expectedRevision: 0,
    title: "Origin",
    content: "Own outline",
    originPageId: "topic",
    sourceDraftId: "closure-draft",
    sourceDraftRevision: 1,
  });
  expect(
    (await service.templates(f.editor)).items.map((t) => t.id).sort(),
  ).toEqual(["origin-template", "plain-template"]);
});

test("pre-upgrade template URL cannot be removed to manufacture an ordinary template", async () => {
  const content = `[B](${await target()})`;
  await f.pool.query(
    "INSERT INTO workflow_templates(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','legacy-url-template',1,$2)",
    [
      f.workspaceId,
      {
        id: "legacy-url-template",
        title: "Copied",
        content,
        originPageId: "topic",
        originVersion: 1,
      },
    ],
  );
  expect((await service.templates(f.editor)).items).toEqual([]);
  await expect(
    service.saveTemplate(f.editor, {
      id: "legacy-url-template",
      expectedRevision: 1,
      title: "Copied",
      content: "Copied title",
      originPageId: "topic",
    }),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  await revoke("source");
  expect((await service.templates(f.editor)).items).toEqual([]);
});

test("legal __proto__ reference remains an own fingerprint key in the ordinary publication envelope", async () => {
  const href = await target("__proto__");
  await f.pool.query("INSERT INTO resources VALUES($1,'source','__proto__')", [
    f.workspaceId,
  ]);
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,'__proto__',$2)",
    [f.workspaceId, { ...source, id: "__proto__" }],
  );
  for (const who of ["editor", "reviewer"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','__proto__',$2)",
      [f.workspaceId, who],
    );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{sourceIds}','[\"__proto__\"]') WHERE workspace_id=$1 AND page_id='__proto__'",
    [f.workspaceId],
  );
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND principal_id='reader'",
    [f.workspaceId],
  );
  await service.saveDraft(f.editor, draft(`[B](${href})`));
  const proposal = await service.submitDraft(
    f.editor,
    "closure-draft",
    1,
    "review",
  );
  const data = (
    await f.pool.query(
      "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, proposal.id],
    )
  ).rows[0].data;
  expect(Object.hasOwn(data.inputEnvelope.pages, "__proto__")).toBe(true);
  expect(data.inputEnvelope.pages["__proto__"]).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.hasOwn(data.inputEnvelope.sources, "__proto__")).toBe(true);
  expect(data.inputEnvelope.sources["__proto__"]).toMatch(/^[a-f0-9]{64}$/);
});

for (const form of [
  "absolute-markdown",
  "network-markdown",
  "absolute-html",
  "network-html",
]) {
  test(`trusted deployment ${form} href retains lineage while external and cross-space controls do not`, async () => {
    const relative = await target();
    const origin = "https://wiki.example.test";
    const trusted = new WorkflowService(
      f.pool,
      new RuntimeService(f.pool),
      async () => {},
      origin,
    );
    const body = (href: string) =>
      form.endsWith("html") ? `<a href="${href}">B</a>\n\n[B](${href})` : `[B](${href})`;
    const href = `${form.startsWith("network") ? "//wiki.example.test" : origin}${relative}`;
    const content = body(href);
    expect(await trusted.saveDraft(f.editor, draft(content))).toMatchObject({
      dependencyVersions: { target: 1 },
    });
    await expect(
      trusted.submitDraft(f.editor, "closure-draft", 1, "review"),
    ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
    for (const [id, external] of [
      ["outside", href.replace("wiki.example.test", "external.example.test")],
      ["other-space", href.replace(f.workspaceId, "another-space")],
    ]) {
      expect(
        await trusted.saveDraft(f.editor, { ...draft(body(external)), id }),
      ).not.toHaveProperty("dependencyVersions");
    }
    await revoke("source");
    await expect(
      trusted.saveDraft(f.editor, { ...draft(content), id: "after-revoke" }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      trusted.submitDraft(f.editor, "closure-draft", 1, "review"),
    ).rejects.toThrow("NOT_FOUND");
  });
}

test("verified template binding excludes an independent derived sibling and future unrelated drafts", async () => {
  const link = `[B](${await target()})`;
  await service.saveDraft(f.editor, { ...draft(link), id: "derived-sibling" });
  await service.saveDraft(f.editor, {
    ...draft("Plain body"),
    id: "plain-sibling",
  });
  const plain = {
    id: "safe-template",
    title: "Plain",
    content: "Plain body",
    originPageId: "topic",
    sourceDraftId: "plain-sibling",
    sourceDraftRevision: 1,
    expectedRevision: 0,
  };
  expect(await service.saveTemplate(f.editor, plain)).toMatchObject({
    id: "safe-template",
  });
  await expect(
    service.saveTemplate(f.editor, {
      ...plain,
      id: "unsafe-template",
      content: link,
      sourceDraftId: "derived-sibling",
    }),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  await service.saveDraft(f.editor, { ...draft(link), id: "future-derived" });
  // Even a later change to the exact source draft must not replace its immutable revision1 evidence.
  await service.saveDraft(f.editor, { ...draft(link, 1), id: "plain-sibling" });
  await revoke("source");
  expect((await service.templates(f.editor)).items.map((t) => t.id)).toEqual([
    "safe-template",
  ]);
});

test("a verified safe template is not poisoned by future conflicting legacy drafts on its origin", async () => {
  await service.saveDraft(f.editor, {
    ...draft("Plain source"),
    id: "template-source",
  });
  await service.saveTemplate(f.editor, {
    id: "safe-before",
    title: "Plain",
    content: "Plain source",
    originPageId: "topic",
    sourceDraftId: "template-source",
    sourceDraftRevision: 1,
    expectedRevision: 0,
  });
  await target();
  await f.pool.query("INSERT INTO versions VALUES($1,'target',2,$2)", [
    f.workspaceId,
    { ...page.versions[0], number: 2, sourceIds: ["target-source"] },
  ]);
  const legacy = {
    ...draft("Unrelated body"),
    id: "conflicting-legacy",
    dependencyVersions: { target: 2 },
  };
  await f.pool.query(
    "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','conflicting-legacy',2,$2)",
    [f.workspaceId, legacy],
  );
  await f.pool.query(
    "INSERT INTO workflow_draft_revision_history(workspace_id,owner_id,draft_id,revision,data) VALUES($1,'editor','conflicting-legacy',1,$2)",
    [f.workspaceId, { ...legacy, dependencyVersions: { target: 1 } }],
  );
  expect((await service.templates(f.editor)).items.map((t) => t.id)).toEqual([
    "safe-before",
  ]);
});

test("an irreconcilable legacy draft is isolated while healthy unrelated drafts remain readable", async () => {
  await target();
  await f.pool.query("INSERT INTO versions VALUES($1,'target',2,$2)", [
    f.workspaceId,
    { ...page.versions[0], number: 2, sourceIds: ["target-source"] },
  ]);
  const legacy = {
    ...draft("Protected incompatible body"),
    id: "conflicting-legacy",
    dependencyVersions: { target: 2 },
  };
  await f.pool.query(
    "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','conflicting-legacy',2,$2)",
    [f.workspaceId, legacy],
  );
  await f.pool.query(
    "INSERT INTO workflow_draft_revision_history(workspace_id,owner_id,draft_id,revision,data) VALUES($1,'editor','conflicting-legacy',1,$2)",
    [f.workspaceId, { ...legacy, dependencyVersions: { target: 1 } }],
  );
  await service.saveDraft(f.editor, {
    ...draft("Healthy draft"),
    id: "healthy-draft",
  });
  expect((await service.drafts(f.editor)).items.map((d) => d.id)).toEqual([
    "healthy-draft",
  ]);
  await expect(
    service.submitDraft(f.editor, "conflicting-legacy", 2, "review"),
  ).rejects.toThrow("STALE_VERSION");
});

test("all explicit historical pins are collected before unbound legacy URLs infer today's version", async () => {
  const content = `[B](${await target()})`;
  await f.pool.query("INSERT INTO versions VALUES($1,'target',2,$2)", [
    f.workspaceId,
    { ...page.versions[0], number: 2, sourceIds: ["target-source"] },
  ]);
  const data = { ...draft(content), dependencyVersions: { target: 1 } };
  await f.pool.query(
    "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','closure-draft',3,$2)",
    [f.workspaceId, data],
  );
  // The unbound URL row is physically inserted before its recorded explicit pin.
  await f.pool.query(
    "INSERT INTO workflow_draft_revision_history(workspace_id,owner_id,draft_id,revision,data) VALUES($1,'editor','closure-draft',1,$2),($1,'editor','closure-draft',2,$3)",
    [f.workspaceId, draft(content), data],
  );
  expect((await service.drafts(f.editor)).items[0]).toMatchObject({
    dependencyVersions: { target: 1 },
  });
  expect(
    await service.saveDraft(f.editor, draft("Copied title", 3)),
  ).toMatchObject({ dependencyVersions: { target: 1 } });
  await expect(
    service.submitDraft(f.editor, "closure-draft", 4, "review"),
  ).rejects.toThrow("STALE_VERSION");
});

test("trusted origin also binds legacy absolute URL evidence in recovery without caller origin metadata", async () => {
  const origin = "https://wiki.example.test";
  await legacyDraft(`[B](${origin}${await target()})`);
  await f.pool.query(
    "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false),($1,'target-source',true,false)",
    [f.workspaceId],
  );
  const recovery = new DraftRecoveryService(f.pool, Date.now, origin);
  const binding = await recovery.permission(f.editor, {
    id: "closure-draft",
    pageId: "topic",
    baseVersion: 1,
    expectedRevision: 1,
  });
  expect(binding.dependencyVersions).toEqual({ target: 1 });
  await revoke("source");
  await expect(recovery.validate(f.editor, { binding })).rejects.toThrow();
});

for (const lineage of ["source", "page"] as const)
  test(`template replacement cannot drop its retained ${lineage} ceiling`, async () => {
    await target();
    await service.saveDraft(f.editor, {
      id: "bound-producer",
      expectedRevision: 0,
      title: "생산 초안",
      content: "bound text",
      ...(lineage === "source"
        ? { sourceIds: ["target-source"] }
        : { dependencyVersions: { target: 1 } }),
    });
    await service.saveTemplate(f.editor, {
      id: "bound-template",
      expectedRevision: 0,
      title: "계보 템플릿",
      content: "bound text",
      sourceDraftId: "bound-producer",
      sourceDraftRevision: 1,
      retainLineage: true,
    });
    await expect(
      service.saveTemplate(f.editor, {
        id: "bound-template",
        expectedRevision: 1,
        title: "갱신",
        content: "edited text",
      }),
    ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
    await revoke(lineage);
    await expect(
      service.saveDraft(f.editor, {
        id: "blocked-copy",
        expectedRevision: 0,
        title: "복사",
        content: "bound text",
        templateId: "bound-template",
        templateRevision: 1,
      }),
    ).rejects.toThrow();
  });
