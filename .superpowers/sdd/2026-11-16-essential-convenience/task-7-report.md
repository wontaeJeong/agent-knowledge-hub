# Task 7 — document tree, move and private duplicate

Status: **DONE_WITH_CONCERNS** (local implementation and evidence complete; independent review/integration remain controller-owned).

Base: `de4e150b7a37003ec23a885fb32205b49d107a7f`. Worktree: `/Users/wt.jeong/.codex/worktrees/31d9/agent-knowledge-hub`. Branch: `feat/convenience-document-structure-20261118`. Feature commit: `5b36d3a4e04d2038a70d9abe3be14624bf515493`. Evidence follow-up: the documentation commit containing the final feature hash. No push, PR, merge or subagent was performed. Root checkout remains main; unrelated peer work/migrations131–139 were preserved. C4 predecessor PR72 is merged at base; controller supplied final `5f4d593`, CI `44115841741`, all8 required checks. Older C4 local evidence in the plan remains historical, not final-head evidence.

## Implemented contract

UXC-06 / EDT-004 / SHR-001 / ACL-006 / ACL-008. New strict `DocumentStructureService` delegates to canonical `WorkflowService` transactions, with HTTP and cookie/session MCP adapters. Existing public workflows APIs/MCP and stable document IDs/URLs remain. `PageTree`, `Breadcrumbs`, move/placement controls, child creation and private duplication are connected in the existing document workflow UI. Existing Composer/exact draft URL, unsaved navigation, identity reset and recovery remain in use; App.tsx needed no change.

Children return at most25 authorized nodes, scanning at most100 raw candidates plus lookahead. Hidden scan position is encrypted inside a real continuation cursor; actor/space/parent/limit/current data and authority bind continuation. `partial` distinguishes a bounded scan from successful empty. Stable ID breaks equal-position ties. `hasChildren` only reflects authorized children. Path/title use canonical current data and inherited ancestor/source ACL: a hidden ancestor is never bypassed to make its descendant visible. No hidden title/count placeholder or cross-space move is added.

Move verifies current page and parent authority, expected page revision, lifecycle/source/history/provenance/erasure policy and parent/cycle fences. Canonical parent change, sibling ordering, audit and mutation receipt share one workspace-locked transaction. C7 rejects effective reader widening and rolls back parent/order/audit together. Legacy state API retains its audience-clamping behavior. Neighbor placement additionally uses the approved opaque `expectedStructureRevision`; same-key replay is authorized before returning the original result and occurs before stale token/CAS revalidation.

Duplicate retains exact original page version, source IDs, inherited provenance and dependency version through the existing private page-less draft path. It creates no page or independent evidence. The canonical save primitive checks lineage/source/parent and erasure even on replay; title rename does not change normalized user input identity. Another payload under the same key rejects, another actor's same UUID is a separate owner-scoped draft. Original private result is replayed without a second draft only after current policy checks.

New migration143 creates separate page-linked order metadata with unique workspace/page identity, nonnegative bigint rank, FK cascade and stable ID tiebreak. Backfill inserts batches of500; missing new-page rank falls back to0. Exact3-column schema inventory fails closed on unknown columns, and legal erasure deletes order in the same page/workspace transaction. Existing legal holds and private draft lineage deletion remain binding.

Changed production groups: `server/convenience/{structure.ts,structure-schema.ts,http.ts}`, `server/workflows/{service.ts,manual-disclosure.ts}`, `server/runtime/{http.ts,mcp.ts}`, `server/{retention/inventory.ts,operations/erasure.ts,migrations/143-document-order.sql}`, `src/operational/{workflows.tsx,convenience/PageTree.tsx,convenience/Breadcrumbs.tsx,convenience/structure.css}`. Four regression files, API contract, handoff, plan, mistakes and UI evidence accompany them. Dependencies and requirements classifications are unchanged.

## Rulings (what / why / cost)

1. **Canonical transaction extraction.** Share existing private `setDocumentStateInTransaction` and `saveDraftInTransaction` bodies instead of committing move and ordering separately. Why: current authorization, CAS, source/version, mutation gate and erasure must cover one atomic result. Cost: an internal helper extraction in a large existing service; legacy regression coverage is carried and scoped changes rerun.
2. **Effective reader comparison.** Only C7's canonical state call rejects audience widening after recomputing actual source/ancestor/effective reader restrictions under the same locks. Why: role/audience labels are insufficient and the legacy API must keep its clamp semantics. Cost: conservative rejection/retry and an additional policy comparison; regression checks no parent/order/audit partial write.
3. **Approved neighbor token extension.** Preserve listed move fields and add optional `expectedStructureRevision`, mandatory for non-null beforeId, from destination tree. Bind actor/space/parent/order+authority; same mutation replay precedes stale revalidation after current authorization. Why: page CAS alone cannot detect another actor reordering/deleting an unchanged neighbor. Cost: explicit client token and refetch after data/authority changes,15-minute/process-restart expiration. Actual queued reorder/trash races and cross-actor/parent rejection pass.
4. **Canonical private copy.** Preserve exact origin version/dependencies and reuse original normalized input+actor/space receipt identity rather than mutable title/body. Why: rename retries must not make a second draft or lose lineage/current revocation. Cost: retained private mutation result and current lineage revalidation; copied text never qualifies as independent proof or direct publication.
5. **Narrow erasure classification.** Order is page-linked product metadata with exact schema-shape checking, not a general control-table exemption. Why: initial native erasure failed closed on this new table; hiding it from inventory would undermine erasure. Cost: explicit inventory maintenance for any future schema extension. Actual source-derived draft/order erasure, page/workspace deletion and hold regressions pass.
6. **Scoped agent transport stays unavailable.** Cookie/session MCP invokes the same service/current capabilities. Existing machine-key issuance supports only read/write scope and its fixed tool allowlist excludes C7; it cannot issue explicit C7 permissions. Separate `/api/v1/agent/mcp` exposes fixed wiki_* tools and likewise lacks C7. Why: inserting names into broad lists silently grants old keys new authority. Cost: C7 is deliberately unavailable to these credentials pending explicit admission design/spec review. SDK regressions prove cookie capability permit/deny and existing read/write scoped deny; no issued-scope permit claim is made because issuance cannot express it. Parent explicitly directed this preservation; it is not a North Star/production waiver.
7. **Bounded delivery, existing policy cost.** Limit result/SQL scan and preserve encrypted continuation while reusing canonical full-state ACL and digest calculation; moving rewrites destination sibling ranks. Why: authorization must remain authoritative, deterministic and race-safe. Cost: full policy/digest and sibling updates are not a scalable-performance claim; large workspace performance remains unverified.
8. **Reuse existing document route.** Connect tree/breadcrumb/controls in workflows.tsx; no cosmetic App hunk/new URL, and child/duplicate use existing private Composer. Why: C1 stable links and C4/C6 resume/recovery/identity behavior already exist. Cost: tree lives within the document workbench rather than a separate global navigation system; desktop captures show that actual context.
9. **Migration number and evidence timing.** Use free143 after actual142, preserve existing migrations/peer ownership. Why:119 was only a plan placeholder. Cost: supplemental1002-row rollback/backfill/new-pool restart test was added after initial migration implementation; it is verification, not a retroactively claimed migration-specific preimplementation RED.
10. **Synthetic honest browser boundary.** Reuse C4 harness approach, own DB/ports/profiles, unchanged canonical HTTP responses; rename through actual existing trash→restoreTitle. Why: no production IdP or new rename endpoint is authorized/available. Cost: four captures prove local deterministic flows, not company IdP, physical touch/OS IME/screen reader or deployment acceptance. Drag selection is a UI regression, keyboard equivalent is a real browser flow.

## RED/GREEN execution ledger

All commands ran in this worktree using `PATH=/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH` (Node24.22.2). Native commands inherited the provided local synthetic `TEST_DATABASE_URL` at127.0.0.1:32769; `scripts/test-server.mjs` creates/drops its own UUID DB. No production data/IdP was used. Logs live in `.superpowers/sdd/2026-11-16-essential-convenience/logs/`; copied logs only strip ANSI/trailing whitespace, retaining failures and counts.

Exact command abbreviations below:

```sh
# N
node scripts/test-server.mjs server/convenience/structure.test.ts
# U
npx vitest run src/operational/convenience/structure.test.tsx
# M
node scripts/test-server.mjs server/convenience/structure.test.ts server/convenience/structure-migration.test.ts
# H
node scripts/test-server.mjs server/convenience/structure-http.test.ts
# E
node scripts/test-server.mjs server/convenience/structure.test.ts server/operations/erasure-db.test.ts server/operations/product-erasure.test.ts server/retention/retention.test.ts server/workflows/new-document.test.ts
# F (final native)
node scripts/test-server.mjs server/convenience/structure.test.ts server/convenience/structure-http.test.ts
# R (broad affected native)
node scripts/test-server.mjs server/convenience/structure.test.ts server/convenience/structure-http.test.ts server/convenience/structure-migration.test.ts server/workflows/workflows.test.ts server/workflows/bulk.test.ts server/workflows/trash-auth.test.ts server/workflows/manual-disclosure.test.ts server/workflows/new-document.test.ts server/workflows/lineage-closure.test.ts server/workflows/navigation-http.test.ts server/workflows/versions/versions.test.ts server/workflows/versions/publication-integration.test.ts server/runtime/search-mcp.test.ts server/agents/mcp.test.ts
```

The runner sorts file execution; the log's file labels are authoritative. Final versus prior evidence is distinguished below.

| Command | Log stem (`c7-*.log`) | Observed result / exit |
| --- | --- | --- |
| N | red-db | missing structure module;0 executed /1 |
| N | red-db-behavior |6 failures:5 fixture column mismatch and1 NOT_IMPLEMENTED; invalid fixture RED not behavior proof /1 |
| N | red-db-behavior2 | corrected fixture;5 meaningful missing-behavior failures,1 rejection control pass /1 |
| N | green-db |5 pass,1 erroneous expectation that revoked private list throws (canonical returns empty) /1 |
| N | green-db2 |6 pass /0 |
| U | red-ui | missing PageTree module;0 executed /1 |
| U | green-ui |4 pass /0 |
| N | red-retry |11 pass,1 rename retry IDEMPOTENCY_CONFLICT /1 |
| M | green-race-migration | structure12 + migration1 pass /0 |
| H | native-http |2 pass /0 |
| U | red-ui-race-drag |4 pass,2 fail: late parent placement response and absent drag selection /1 |
| U | green-ui-race-drag |6 pass /0 |
| R | native-regression |147 pass,1 C6 transitive erasure RETENTION_GRAPH_UNSUPPORTED,14 files /1 |
| N | red-erasure |13 pass,1 focused order inventory/source-derived body erasure fail /1 |
| E | green-erasure | structure16 + erasure28 + product-erasure18 + retention30 + new-document30 =122 pass /0 |
| N | final-neighbors |18 pass including queued neighbor reorder/trash /0 |
| U | red-visible-label |6 pass,1 duplicate visible expand text /1 |
| U | green-visible-label |7 pass /0 |
| U | red-duplicate-keys |7 pass,1 React tree/personal sibling identity collision /1 |
| U | green-duplicate-keys |8 pass /0 |
| N | red-actor-receipt |18 pass,1 second actor same mutation UUID workflow_events PK collision /1 |
| F | final-actor-receipt | final structure19 + actual HTTP/MCP2 =21 pass /0 |
| npm run check | final-check-complete | **final frontend479/Node48/import16/evaluation41/requirements251/server types/build/static HTTP smoke; exit0** |

`check` and `final-check` logs are intermediate477 passes, `final-visual-check`478 and `final-key-check`479 are also earlier source states; none substitutes for `final-check-complete` after receipt fix. `type-ui` records cleanup returning boolean TS2345 (fixed void return); `type` and `server-types2` record successful server checks. Exact type commands were `npm run typecheck` (tsc -b --pretty) and `npm run check:server` (tsc -p tsconfig.server.json); final check validates both final source configurations. Baseline supplied by controller is `c7-baseline.log`471frontend/48Node and is preserved separately.

Current native **2files21** on final receipt bytes plus unchanged erasure/product-erasure/retention/C6 **4files106** from green-erasure and other **11files104** from native-regression = unique **17files231** covered. The carried11 are agents/mcp1, migration1, runtime/search-mcp1, bulk7, lineage-closure32, manual-disclosure9, navigation-http1, trash-authorization2, publication-integration8, versions6, workflows36. Their exercised production boundaries did not change after those passing runs; native-regression's failed new-document result is replaced by green-erasure30. **There was no single current17file231 run.** No unaffected rerun was performed solely to inflate current counts.

Migration regression checks1002 rows across500-sized backfill batches, rollback leaves no table, unique page identity, fresh pool migration restart/no second application. This is a new DB connection/re-run proof, not a claim that every production crash point has been exercised. Structure native also covers self/cycle/trash parent, hidden ancestors/children, actual waiting revision/ACL/trash/retention races, stale neighbor move/order, token actor/parent confusion, duplicate source revoke/lineage/body replacement/private publication rejection, actor receipt isolation, legal hold and exact schema drift.

## Browser source binding, captures and cleanup

Harness: `docs/ui-validation/2026-11-18-document-structure/{structure-runtime.ts,capture.mjs,manifest.mjs}`. Sources/captures/JSON/37 logs are bound in source-manifest. Product fingerprint:

`42e9eec1ce202ce7bfe859968d3e7089a0ed9652e5ab9611f2eac497d5284860`

Frontend startup `2026-11-17T16:26:10.083Z`, runtime startup `2026-11-17T16:26:11.367Z`, final capture completed `2026-11-17T16:28:43.006Z` (2026-11-18 KST). All final production source hashes match the freshly started runtime/frontend. Chromium headless/macOS/Asia-Seoul;1440×1000 and390×844, light/dark. Loopback synthetic reviewer actor adapter is explicit; API request forwarding uses real canonical HTTP/PG responses unchanged. Separate HTTP regression uses a real local OIDC test provider, session cookie/CSRF and SDK MCP.

Commands with the same Node PATH and test DB environment:

```sh
AKH_C7_SYNTHETIC_CAPTURE=1 npx tsx docs/ui-validation/2026-11-18-document-structure/structure-runtime.ts
node docs/ui-validation/2026-11-18-document-structure/manifest.mjs --frontend-start
npx vite --host 127.0.0.1 --port 5197 --strictPort
AKH_C7_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-18-document-structure/capture.mjs
node docs/ui-validation/2026-11-18-document-structure/manifest.mjs
node docs/ui-validation/2026-11-18-document-structure/manifest.mjs --verify
```

`c7-browser-final.log` exit0 and browser-results record all4 conditions:3-level authorized path, no hidden title, keyboard move before root neighbor with DB-confirmed parent, same old link after move and canonical trash→restoreTitle rename, page-less owner-only duplicate draft with original dependency, source ACL revoke removing tree/draft disclosure.390 additionally verifies dialog Escape and heading focus.174/176 requests per condition; pageErrors empty including React duplicate-key errors. All four final PNGs visually inspected. `before-fix-390-light.png` is explicitly old failure evidence. No successful DTO was fabricated. No physical drag/touch, production IdP or quality claim.

Earlier browser logs are preserved: browser1 disposal error masked initial async failure; browser2 observed path before fetch completion; browser3 composer locator used incorrect label; browser4 functional success still had visual label/CSS and React key defects. The final run occurred after those product/harness fixes and final actor-receipt change. Each mutating failed attempt used a fresh owned DB on restart.

Cleanup: owned final runtime session18318 and Vite9279 stopped; DB0/profile0/ownedChromium0,4397/5197 closed, parent PostgreSQL alive at `2026-11-17T16:33:38.875Z`. First cleanup check found one leftover own profile and removed that exact path; second ps filter mistakenly counted its own shell text; executable/PID filtering corrected the observation. `cleanup.json` records the final check and deviations. Parent PG and other services were not stopped.

## Mistakes, self-review and limits

MISTAKE_LOG preserves fixture positional INSERT mismatch, incorrect revoked-list expectation, TypeScript cleanup return, late placement race, duplicate retry title dependence, order inventory omission, browser locator/timing/disposal assumptions, visible aria helper/CSS specificity, React sibling-key collision, actor receipt collision and cleanup assumptions. Initial failures remain in logs; green filenames with failures are explicitly marked in this report. Broad147/148 is not presented as success.

Self-review inspected final service extraction/atomicity, opaque token binding/current authorization, canonical duplicate replay, adapter admission, migration/schema erasure, UI generation isolation and final screenshots. Meaningful RED preceded the fixes for observed product failures. Full final check and affected native passed on final source; docs-only updates afterwards do not change the source fingerprint. `git diff --cached --check` passed before the feature commit; manifest verification passed for328 production,3 harness,4 regression sources,7 artifacts and37 logs. The documentation-only follow-up records the feature hash and completed plan checkbox. Independent spec/quality review, exact-head remote CI, PR and merge are controller-owned and not claimed.

North Star: improves human Query discovery/organization and safe private re-authoring of existing approved knowledge without erasing source/version relationships. It does not replace Ingest→Query→Lint, answer reintegration, review/approval or independent evidence. Invariants: no widened source/ancestor readers; current authorization on mutation/replay; source/version lineage survives copy/body edits; retry does not duplicate; stable links survive structure/title changes; legal hold/erasure apply to derived private material. Evaluation here is boundary/function verification; knowledge/agent effectiveness requires EVALUATION controlled experiments. Existing251 criteria and North Star meaning remain unchanged.

Outstanding concerns are explicit scoped-agent C7 unavailability pending admission design; full-state policy/digest/sibling update scale unmeasured; cursor restart expiration; existing large Vite chunk warning; real enterprise IdP/data/model quality, device/IME/accessibility and production operation unverified. No criterion is waived or reduced by this local completion status.
