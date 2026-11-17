# Task 7 — document tree, move and private duplicate

Status: **DONE_WITH_CONCERNS**. The original submission below is historical; **Round2 at the end is the current implementation/evidence**. I1–I4 and Round2 N1 fixes are locally complete; independent re-review/integration remain controller-owned.

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


# Task review fix Round1 / 5 — current evidence

FIX_BASE: `9e77efaccb7f6176cb0759418b29553f9ec1f2d0`. Status: **DONE_WITH_CONCERNS**, I1/I2/I3/I4 addressed locally; controller scoped review, CI and integration pending. Fix commit: `57a08eb3db8e06c05dc957d5d30183b9d845aa9a`. No helper/reviewer agent, push, PR mutation or merge performed by implementer. Parent created PR73 after the original submission; this report does not claim its final review/CI status. Original479/check/captures/fingerprint42e9... remain historical in original commits; they are not current Round1 evidence.

## Verbatim task review received

The following is the complete supplied `/private/tmp/akh-c7-task-review.md`, preserved verbatim. Parent additionally promoted its M1 to Important I4 in `progress.md` and directed the explicit opt-in I3 grant implementation; M2 remains deferred.

### Spec Compliance

- ❌ **Issues found.** UXC-06 is substantially implemented, but duplicate replay fails for linked documents (I1), the new move refresh can overwrite a different selected document (I2), and supported machine credentials cannot perform the promised C7 mutations (I3). **0 Critical / 3 Important / 2 Minor.**
- ✅ The missing cosmetic `App.tsx` hunk is not itself a defect under the controller's ruling: actual integration is present at `src/operational/workflows.tsx:920`, `:945`, `:953`; the existing stable URL is exercised after move and rename by `docs/ui-validation/2026-11-18-document-structure/capture.mjs:195` and `:224`. Migration 143 correctly replaces the provisional number; the diff does not change the 251 requirement definitions or North Star.
- ⚠️ **Cannot verify from supplied evidence:** mobile focus after *selecting a different document*, as opposed to Escape (M1); real enterprise IdP/data, physical touch/IME/screen reader, production scale and multi-process continuation. The browser proof at `docs/ui-validation/2026-11-18-document-structure/capture.mjs:136` checks Escape with the original heading still mounted. No operational or quality-effect acceptance is inferred from synthetic evidence.

### Strengths

- `server/workflows/service.ts:770`, `:810`, `:873`: tree/path reuse current canonical visibility; result size is capped at 25, raw scan at 100 plus lookahead, hidden scan positions are authenticated-encrypted, and continuation binds identity/space/parent/limit/data/authority. `hasChildren` uses visible children rather than raw counts. Canonical inherited ACLs prevent a hidden ancestor from being bypassed.
- `server/workflows/service.ts:914`, `:988`, `:1239`, `:1280`: move runs under the canonical transaction/mutation gate, checks current page and destination authority, validates page CAS and neighbor token, writes parent/rank/audit/receipt atomically, and rejects broadening with rollback. The new `rejectBroadening` branch leaves legacy `setDocumentState` clamping intact. Receipt IDs include workspace, actor and operation; replay occurs after current authorization and before stale CAS/token checks.
- `server/convenience/structure.test.ts:232`, `:432`: real queued ACL/trash/retention/revision and neighbor reorder/trash tests assert rejected mutations leave no partial state. `server/convenience/structure.test.ts:490` verifies actor-isolated duplicate receipts. These are meaningful native tests, not merely adapter mocks.
- `server/workflows/service.ts:1010`, `:1057`: exact-version duplication creates a private page-less draft through the existing save primitive, preserves origin/source lineage, and does not publish or invent independent evidence. Current source/lineage/parent/erasure checks precede receipt replay; I1 concerns input reconstruction, not a bypass of those checks.
- `server/migrations/143-document-order.sql:3`, `server/convenience/structure-schema.ts:3`, `server/retention/inventory.ts:60`, `server/operations/erasure.ts:504`: order is page-linked metadata with unique identity, FK cascade, nonnegative rank, 500-row inserts and exact-column fail-closed inventory. `server/convenience/structure-migration.test.ts:6` checks 1002-row backfill, rollback and new-pool restart; actual erasure/hold tests cover source-derived private copies and order rows.
- `src/operational/convenience/PageTree.tsx:279`, `:437`, `:482`: capability-driven actions, private child creation, a keyboard placement selector and drag placement share the same pending move; identity remounting and placement generation guards address several real stale-response cases. `Breadcrumbs.tsx:10` and tree links preserve stable IDs.

### Issues

#### Critical (Must Fix)

- None found in the reviewed scope.

#### Important (Should Fix)

1. **I1 — A successful duplicate of a linked page cannot be replayed.** `server/workflows/service.ts:1045` reconstructs the private-save input from `saved.result`, while `:1069` initially supplies only `{ [originPage]: originalVersion }`. The canonical save resolves rendered internal links (`:370` / `referenceDependencies` at `:197`), stores the expanded dependency map in the result, but stores the fingerprint of the original unexpanded input (`:431`). The identical duplicate request therefore re-enters save with a different input hash and fails `IDEMPOTENCY_CONFLICT` at `:390`. This breaks recovery after a lost success response for ordinary interlinked knowledge. Persist/replay the exact normalized original save input (separately from enriched result), or authorize and return the existing receipt without treating its enriched output as the original input. Preserve all present current-policy checks. Add a regression with an authorized rendered relative link, and repeat after title change.
   - **Confirmed with one focused actual PostgreSQL probe:** `/private/tmp/akh-c7-review-copy.mts` used a fresh UUID database, the real fixture and canonical `WorkflowService`. Output: `FIRST_DEPENDENCIES {"topic":1,"linked":1}`, `REPLAY_ERROR IDEMPOTENCY_CONFLICT`, `DRAFT_COUNT 1`. The owned database `akh_c7_review_3d1d135679d24ec59be99896ece3e3f9` was dropped in `finally`. No repository files were changed and no suite was rerun. Initial sandbox attempts failed before connecting; the narrow escalated invocation succeeded.

2. **I2 — A late post-move refresh can replace the newly selected document with the previous document.** `src/operational/workflows.tsx:953` adds `await api.get(...selected); setDetail(next)` without binding the response to the current selection/request generation. After move POST succeeds, the modal closes (`PageTree.tsx:366`) and its refresh remains pending. The user can select B through the tree/select; the normal selection effect loads B, then the older move refresh for A can finish last and set A's detail while `selected` is B. Subsequent controls combine B's ID with A's displayed version/revision. `alive.current` at `PageTree.tsx:363` is checked before invoking the callback and cannot guard the callback's later `setDetail`. Bind this refresh to the current API/identity/document generation and discard stale results; add a delayed A-refresh/B-selection regression. This is a new callback defect even though older refresh helpers have similar architectural debt.

3. **I3 — Agent C7 mutation transport is still unimplemented, not merely untested.** `server/runtime/mcp.ts:52` and `:166` expose the canonical mutation tools for session contexts, but no currently issuable machine credential can satisfy them. This leaves the task's explicit “에이전트 API/MCP도 같은 변경 서비스를 호출한다” contract incomplete; documentation of the limitation is honest but does not waive that requirement.
   - `akh_sk_` agent keys: `server/runtime/mcp.ts:141` retains the fixed read/write tool allowlist; `server/runtime/http.ts:430` also enforces the agent route allowlist. The new SDK test at `server/convenience/structure-http.test.ts:168` explicitly proves C7 rejection, not permission.
   - Separate agent MCP: `server/agents/mcp.ts:34` dispatches fixed `wiki_*` tools and has no C7 mutation; the new test at `server/convenience/structure-http.test.ts:179` confirms this absence.
   - `akh_` action credentials are a **distinct case**: `server/runtime/http.ts:255` authenticates them and binds `ctx.credentialId`; they can issue `knowledge.read` and reach tree/path via HTTP/runtime MCP. However `server/access/index.ts:49` excludes both `knowledge.protect` and `draft.write` from `delegated`. Human credential issuance (`:1901`) and service credential issuance (`:727`) reject these actions. Effective access (`:237` and `:245`) filters them out again even if an action row were inserted manually. Thus neither C7 move nor duplicate has a supported action-credential path. This is source-established unavailability, not a missing issued-key test alone.
   - Resolve with an explicit, bounded machine-admission contract and permit/deny/revoke evidence using actually issued credentials, or obtain a separate explicit product scope decision leaving this requirement unmet. Do **not** silently expand existing read/write keys, the delegated ceiling, or all `wiki_*` clients. The North Star remains unchanged; the missing agent-native mutation path must remain an actual gap until resolved.

#### Minor (Nice to Have)

1. **M1 — Selection-close focus is tied to a single animation frame, not the destination document becoming ready.** `src/operational/convenience/PageTree.tsx:233` schedules one query for `[data-document-heading]`, and `:255` invokes it immediately after selection. The selection effect at `src/operational/workflows.tsx:691` clears the existing detail while the new document loads, so under a delayed fetch there is no heading when that callback runs and no later focus attempt. The current browser test only exercises Escape. Move the focus intent into the destination-ready lifecycle and add a delayed selection focus check. Escape close/focus is supported by the supplied actual evidence; successful selection focus is not.
2. **M2 — Existing build warning remains.** `.superpowers/sdd/2026-11-16-essential-convenience/logs/c7-final-check-complete.log:282` reports chunks over 500 kB. This is pre-existing bundle debt, not a C7 blocker or a clean-output claim; retain it as measured follow-up rather than muting the warning.

### Checks and Scope

- Reviewed the supplied two-commit diff in production/schema, regression, UI/harness and evidence passes. No Git regeneration, checkout/index/HEAD mutation, helper agent or broad suite rerun was performed.
- Focused surrounding checks were limited to named risks: (a) extracted transaction methods were cut off in the diff, so their current bodies plus `run/page/requireVersion`, `database.transaction`, `readers/visiblePageIds` were checked for lock/current-ACL/legacy-clamp regressions; (b) `saveDraftInTransaction` and `references.internalReferenceIds` were checked for receipt input/output normalization (I1); (c) WorkflowPanel selection lifecycle was checked for the new refresh and mobile focus races (I2/M1); (d) runtime authentication, both MCP dispatchers and access-credential issuance/effective ceilings were checked to distinguish actual machine admission from session-only support (I3). The worktree has no `.codegraph/`, so no index was used or created.
- Inspected final check and native evidence: `c7-final-check-complete.log:20` records frontend 479; Node 48/import 16/evaluation 41/requirements 251/server types/build/static smoke also pass. `c7-final-actor-receipt.log:1` records current HTTP/MCP 2 + structure 19. `c7-green-erasure.log:11` records the carried 106; `c7-native-regression.log:1` supplies the other 104 passing cases and preserves the old erasure failure superseded by the later green run. This is 17 unique files/231 tests across source-compatible runs, **not** one final 231-test run.
- Inspected harness/capture assertions, browser JSON and the 1440-light/390-dark PNGs. Canonical HTTP forwarding is unchanged by the synthetic actor adapter. The proof covers three levels, hidden title absence, keyboard move, old ID after move/rename, private duplicate, source revoke and Escape focus in four viewport/theme conditions. It does not exercise linked-page duplicate replay, delayed move-refresh selection, or selection-close focus.
- No performance correctness finding is inferred solely from full-state policy/digest scans, sibling-rank rewrites, or process-local 15-minute cursor keys. These are explicitly disclosed scale/architecture/operational limits requiring separate acceptance, not proof of data leakage or a reason to rerun suites.

### Assessment

**Task quality: Needs fixes.** The canonical authorization, transaction, lineage and erasure reuse is strong, and the evidence distinguishes failures and carried results honestly. The confirmed replay defect and new UI response race prevent trusting retry/navigation behavior; machine mutation admission remains a separate substantive spec gap.


## Round1 changes and rulings

**Ruling I1 — preserve original input identity, reauthorize enriched lineage.** Outer duplicate receipt must match the exact normalized user request. It then loads the private mutation's original input hash and enriched result; canonical save rechecks draft history, current source/linked dependency/parent/erasure before comparing the original stored hash. It no longer fingerprints enriched output as though it were original input. The trusted optional hash is private to the canonical save method and never accepted in HTTP/MCP DTOs. Why: rendered relative links add dependencies and rename must not turn the same request into conflict. Cost: a tightly scoped internal replay parameter; no second draft, erased/private body leakage or independent-proof cloning is permitted. Actual DB regression checks link→expanded dependency map, exact replay, rename replay, changed payload reject, linked-page revoke and draft count1.

**Ruling I2 — bind refresh to document/API/actor/space generation.** The move callback captures current selection identity and applies its GET result only if still mounted/current and response page matches requested page. Normal selection loading also checks current generation after async boundaries, including identity changes. Why: a late A result cannot set detail underneath selected B or a new API/account/space. Cost: a small current-selection ref inside the existing workbench, without changing C4/C6 recovery or a broad editor rewrite. UI cases separately cover selection/API/actor/space changes; actual browser holds canonical A response, selects/loads B, then releases A and verifies B and outside selector focus stay intact.

**Ruling I4 — destination-ready mobile focus with cancellation.** Mobile selection registers an intent bound to the intended selection generation. A layout effect focuses that exact current heading after the new authorized detail is committed. Outside focus/pointer/key intent and account/API/space changes cancel it. Dialog trigger restoration is allowed without confusing it with explicit outside intent; same-selection requests trigger the readiness effect as well. Why: one animation frame can occur while destination heading is absent. Cost: scoped intent/ref/listener lifecycle and tests; unchanged Escape return behavior remains. Actual390 Enter-select with delayed canonical response verifies new heading focus, and an independent repetition intentionally focuses the outside selector before response and preserves it.

**Ruling I3 — explicit per-operation machine grant, no general delegation expansion.** Authenticated human session explicitly POSTs `{operation,input,expiresAt}` to `/api/v1/convenience/credentials`. The input is the full strict normalized move/duplicate request, so workspace/actor plus operation hash bind page, parent, exact version/CAS/order token, mutationId and reason. Expiry is at most15minutes and parent session must remain valid. Existing access_credentials stores a dedicated marker, exact input hash and parent-session snapshot with a hashed `akh_` secret. No SQL migration/new authority table, general delegated capability, existing key issuance, `akh_sk_` read/write list or wiki_* tool list changes. Issuance uses current canonical capability/source/version/parent/erasure and current human session. Cost: machine callers require a human-prepared exact operation and a short-lived valid parent session; this is not long-lived service-account delegation or a generic agent elevation.

**Ruling I3 transaction/fences.** The private structure dispatch alone creates the interactive context and immediately invokes the same canonical move/duplicate service; it returns no privileged context or authorization marker. Pre/post OIDC revalidation is supplemented inside the existing workspace transaction by credential row `FOR SHARE`, current expiry/revocation/input match, `assertInteractiveGrant`, session policy and canonical underlying current human capability/source/parent/lifecycle/erasure checks. The workspace mutation lock precedes current membership/principal and credential/session checks; existing revoke also serializes through that workspace transaction. Actual queued credential revoke/session-end/capability-removal tests observe the request waiting on `SELECT id FROM workspaces ... FOR UPDATE`, revoke before unlocking, and assert denial; session/capability cases also assert zero new draft/save receipt. Why: preflight proof alone cannot fence concurrent authority loss. Cost: conservative session snapshot rejection and current IdP lookup; restored roles do not bypass a currently ended session.

**Ruling I3 transport isolation.** C7 grant may enter only its one POST mutation route or POST `/mcp`; MCP advertises and admits only the corresponding knowledge_move or knowledge_duplicate. All other general HTTP/tool operations fail before canonical execution, and exact input is still checked by dispatch. Why: tool listing cannot substitute for authorization and even legacy API paths must gain no reusable rights. Cost: this key cannot read tree/path or prepare a changed operation itself; the issuer prepares the exact authorized input. Existing ordinary action credentials/read-write keys retain their current behavior. Both move and duplicate are proven through actually issued HTTP and SDK MCP paths, not by manually inserted grant rows or synthetic success responses.

**Ruling verification/current versus carried.** After final transport narrowing only those affected transport tests and fullcheck were rerun. Later authority-race and move-MCP test-only additions reran HTTP2 and server typecheck; production source did not change, so final runtime/capture/check stay valid. Why: repeat only newly affected boundaries. Cost: report exact compatible runs instead of calling the aggregate one final run.

## Exact Round1 commands, outcomes and logs

All commands use the same worktree and Node24 PATH as original ledger; native commands inherit the provided loopback synthetic TEST_DATABASE_URL. Every native run uses the script-owned UUID database. New logs are `logs/c7-f1-*.log` beside this report; output is preserved with ANSI/trailing whitespace normalization only. Exact command bodies:

```sh
# N (copy/core)
node scripts/test-server.mjs server/convenience/structure.test.ts
# H (actual issuance, HTTP and SDK MCP)
node scripts/test-server.mjs server/convenience/structure-http.test.ts
# U
npx vitest run src/operational/convenience/structure.test.tsx
# UN
npx vitest run src/operational/convenience/structure.test.tsx src/operational/convenience/Navigation.test.tsx
# UR
npx vitest run src/operational/convenience/structure.test.tsx src/operational/convenience/Navigation.test.tsx src/operational/convenience/exact-recovery.test.tsx
# Native7
node scripts/test-server.mjs server/convenience/structure.test.ts server/convenience/structure-http.test.ts server/access/access.test.ts server/agent-credentials.test.ts server/identity/native-integration.test.ts server/operations/credential-erasure-db.test.ts server/workflows/new-document.test.ts
# Transport3
node scripts/test-server.mjs server/convenience/structure-http.test.ts server/runtime/search-mcp.test.ts server/agents/mcp.test.ts
```

| Command | `c7-f1-*.log` suffix | Result / exit |
| --- | --- | --- |
| N | red-copy |19pass/1fail: unsupported `./linked.md` fixture did not resolve linked dependency; not valid behavior RED /1 |
| N | red-copy2 |19pass/1fail: actual supported relative document URL reproduces IDEMPOTENCY_CONFLICT /1 |
| N | green-copy |20pass /0 |
| U | red-ui |10pass/2fail: late A overwrite and missing destination-ready focus /1 |
| U | green-ui |12pass /0 |
| H | red-machine |1pass/1fail: issuance endpoint404 /1 |
| H | machine1 |1pass/1fail after new machine permit/retry passed: existing ordinary credential issuance actually201, fixture expected200 /1 |
| H | machine2 |2pass including current capability/session/source/trash/erasure checks /0 |
| H | machine3 |2pass including observed queued credential revocation /0 |
| npm run check:server | types |pass /0 |
| UN | ui-navigation |47pass /0 |
| UR | ui-final |63pass(structure15,Navigation35,exact-recovery13) /0 |
| Native7 | native |79pass across7 files /0 |
| npm run check | check |486/48/16/41/251/types/build/smoke pass; intermediate before final transport narrowing /0 |
| final harness command below | browser1 |four configurations passed; intermediate before final transport narrowing /0 |
| H | red-admission |1pass/1fail: C7 key advertised generic MCP tools; new isolation expectation RED /1 |
| Transport3 | admission-final |HTTP2 + existing agentMCP1/searchMCP1 =4pass /0 |
| npm run check | check-final |**final production**486frontend/48Node/16imports/41evaluation/251requirements/server types/build/static HTTP smoke /0 |
| H | queued-authority |2pass after adding observed queued session and capability removal; draft/save receipt0 /0 |
| npm run check:server | final-test-types |pass after test-only additions /0 |
| H | machine-final |**final HTTP test bytes**2pass, adding actual issued move SDK MCP permit/list/replay alongside duplicate SDK permit /0 |
| npm run check:server | machine-test-types |pass final test source /0 |
| final harness command below | browser-final |**final production**four configurations,10 current PNGs,errors[] /0 |

Native7 split: access/access10,agent-credentials3,structure20,structure-http2,identity/native-integration7,operations/credential-erasure-db7,new-document30 =79. Transport3 replaces HTTP2 and adds the two unchanged MCP files' current executions. Thus this round covers9 unique files81 tests across compatible runs (not a single9/81 execution). Final HTTP test-only additions replace its prior2 counts, not extra unique tests. Remaining earlier compatible12files178 are erasure-db28/product-erasure18/retention30 and migration1/bulk7/lineage-closure32/manual-disclosure9/navigation-http1/trash-auth2/publication-integration8/versions6/workflows36. Overall unique21files259 across carried/current evidence, **not one final259 run**. Initial failures remain preserved and are not counted as passing evidence.

## Final browser and manifest binding

Same exact startup/capture commands as original report, now revised harness. Final capture command:

```sh
AKH_C7_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-18-document-structure/capture.mjs
```

Runtime startup `2026-11-17T17:04:00.626Z`, frontend `2026-11-17T17:04:02.355Z`, captured `2026-11-17T17:05:14.388Z` (KST2026-11-18). Product SHA fingerprint `f7290771005c698cc5d68728057f372aaa2692d2a632f84746994397e4367100`. Node24.22.2/macOS/Chromium headless/Asia-Seoul;1440×1000/390×844×light/dark. Actor selection remains explicit synthetic loopback; added local OIDC provider uses real OidcAuth revalidation/assertion for C7 issued grants. This is not company IdP acceptance.

All four scenarios: original3-level/hidden-title/keyboard move/stable old ID after move/restoreTitle rename/private draft/source revoke plus linked duplicate before rename→same exact key after rename→same saved result/draft count1, actually issued machine key permit and source-revoked rejection, delayed A post-move GET→B ready→A response released without overwrite or outside focus theft.390 cases additionally delay a drawer-selected new page, confirm heading absent while pending, then Enter selection's focus lands on newly ready heading; second repetition intentionally focuses outside selector before release and preserves that focus. Real canonical responses are held/released unchanged, never fabricated. Existing Escape remains checked. Browser pageErrors includes React duplicate key errors and is empty. Ten current PNGs plus old failed PNG retained; representative final normal/dark tree and selection-focus/move-race PNGs visually inspected.

Final cleanup at `2026-11-17T17:06:58.545Z`: own DB/profile/Chromium0,4397/5197 closed,parent PG alive; own local OIDC provider closed with runtime. No unrelated resource stopped. Updated manifest binds328 production sources,3 harness files,4 regression sources,13 artifacts and all historical/new logs. Final production/source fingerprint still matches after test/doc-only additions. The original before-fix image and logs remain labelled historical.

## Self-review, mistakes and outstanding limits

I1/I2/I4 were reproduced with meaningful behavior RED; I3 endpoint absence and overly broad MCP listing had explicit RED. New canonical/transport/current-session locks were reviewed against actual existing functions and queued tests. Issuance/dispatch does not mutate delegated/actionRoles/global scopes. No machine key can mint another C7 grant, enter generic API/tool operations, swap payload/space/resource, continue after credential/session expiry/revoke/current capability or source loss, or bypass canonical trash/erasure fence in the tests. MCP tool listing is additional narrowing; callTool checks and canonical dispatch independently authorize.

Fixture mistakes were unsupported link syntax and a wrong201-status expectation; both failures are preserved and not attributed to production. Initial Round1 fullcheck/capture were superseded when transport narrowing changed source. No final browser failure was hidden; both intermediate and final executions passed their then-current source. MISTAKE_LOG records the initial spec gap and product races as actual defects, not waived limitations.

North Star/251 criteria unchanged. This round supplies the previously missing agent-native exact C7 operation path without weakening source/approval/evidence boundaries. Copy is still private, derived and version-aware; no claim of independent evidence, publication, semantic quality or improved agent outcomes. Remaining concerns: independent security/spec review of new explicit admission; short-lived parent-session-dependent grants (not durable unattended service authority), inherited full-state policy/digest/rank costs and process-local cursors, pre-existing M2 large bundles, real corporate IdP/data/operating retention/load/device/IME/screen reader/model-quality acceptance unverified. Controller owns remaining review/CI/merge; no product acceptance criterion is reduced.

Round1 packaging verification: fail-fast `git diff --cached --check` and manifest verification passed; all410 manifest paths plus this report were confirmed tracked in the index before the fix commit. This documentation-only follow-up records the fix hash; production/harness/test/artifact/log bytes are unchanged.


# Task review fix Round2 / 5 — N1

FIX_BASE `78c1974337c67650e58cf9b156ca8292f54896f9`. Status: **DONE_WITH_CONCERNS**; local N1 fix/verification complete, controller scoped re-review and CI/merge pending. Fix commit: `17c522e23dca7a7cdc6948e2c4ff6e16ccd2e395`. No backend/API/credential/schema changes, helpers, reviewer agents, push, PR or merge by implementer.

## Verbatim scoped Round1 review

### Finding Verdicts

- **I1 — Linked-page duplicate replay fails** — **ADDRESSED.** `server/workflows/service.ts:1051` now reads the original private-save `input_hash`; `:1071` passes it only through the private replay parameter. The exact outer normalized duplicate request is still matched before this path, and `saveDraftInTransaction` still performs current history/source/dependency/parent/erasure checks before receipt return (`:339`, `:390`). Enriched output is no longer fingerprinted as original input. `server/convenience/structure.test.ts:516` covers expanded linked dependency, identical replay, rename, changed input, linked-page revocation and one draft. The actual browser harness also uses linked content and replays the actually issued machine request after rename (`docs/ui-validation/2026-11-18-document-structure/capture.mjs:304`, `:347`).

- **I2 — Late post-move A refresh overwrites B/current identity** — **ADDRESSED for the reported defect.** `src/operational/workflows.tsx:380` binds the current selection to API/actor/space/document; the move refresh at `:999` checks mounted/current token and response page ID before applying data. The selection loader also rejects superseded responses at `:753` and `:783`. `src/operational/convenience/structure.test.tsx:317` separately covers selection/API/actor/space; `capture.mjs:265` holds canonical A refresh, loads B, then releases A and checks B and outside focus. The fix introduces the distinct same-selection regression N1 below.

- **I3 — No supported machine mutation transport** — **ADDRESSED.** `server/convenience/structure.ts:62` adds actual human-session issuance of a maximum-15-minute, one-operation/full-normalized-input-bound `akh_` credential. Its secret is hashed; workspace/principal are SQL-bound, operation/input fingerprint/session snapshot are stored server-side. `server/workflows/service.ts:913` requires current source/version/parent/erasure and canonical mutation capability before issuing. `structure.ts:147` confines credential-to-interactive-context conversion to exact C7 dispatch and immediately invokes the same canonical mutation; no elevated context is returned. At execution, `:162` checks credential binding/revocation/expiry, and `:201` repeats these under `FOR SHARE` and calls the current parent-session assertion inside the canonical workspace transaction. Existing current capability and lineage checks still run on that context. Pre/post OIDC revalidation is retained.
  - **Transport isolation:** `server/runtime/http.ts:262` restricts these keys to the exact operation POST or POST `/mcp`; `server/runtime/mcp.ts:155` restricts both tools/list and tools/call to the matching single C7 tool. Old broad `akh_sk_` keys, general delegated action ceilings and separate `wiki_*` tools are not expanded. The new grant is an explicit exact-operation delegation, not a durable unattended service account claim.
  - **Actual issuance evidence:** `server/convenience/structure-http.test.ts:104` issues through the real HTTP endpoint with OIDC session/CSRF. It exercises HTTP and SDK MCP move/duplicate, same-key replay, changed input/page/space/operation denial, generic endpoint/minting denial, old-key denial, expiry/revoke, ended session, lost capability, source/trash/erasure fences. The queued tests wait for the canonical workspace lock, change session/capability/credential authority before unlocking, and assert denial; fresh session/capability cases assert no draft or save receipt. `c7-f1-machine-final.log:1` records the final test bytes passing; no manually inserted permit marker substitutes for issued-key proof.

- **I4 — Mobile destination focus occurs before the destination is ready / may steal outside focus** — **ADDRESSED for the reported different-destination flow.** `src/operational/workflows.tsx:409` consumes a generation-bound focus intent only when the matching current detail/heading is committed; `:390` cancels on outside focus/pointer/key or identity changes. `PageTree.tsx:255` no longer schedules the old one-frame selection focus. `structure.test.tsx:347` covers delayed ready/outside/identity cases; `capture.mjs:197` holds the actual new destination response and checks focus after release plus an independent outside-focus-preservation flow. The 390-light selection-focus PNG visibly shows the destination heading focused. N1 also affects same-document selection while loading and must be fixed without reintroducing I2/I4.

### New Breakage in the Fix Diff

- **N1 — Important: selecting the already-selected document while its detail is loading permanently suppresses that load.** `src/operational/workflows.tsx:418` unconditionally replaces `selection.current`, including when API/identity/document are unchanged. The existing in-flight response at `:753` then sees a different token and returns without setting detail. The load effect dependency list at `:819` includes API/selected/fail/identity, not the replacement token; setting the same selected value does not schedule a replacement fetch. A user opening A from a stable link can click A in the already-loaded tree while A's detail request is pending; after the authorized response arrives the document remains blank. The desktop case does not even require the mobile focus state update. Preserve the existing token for an unchanged selection, or explicitly restart a cancelled load; keep mobile focus intent on the current valid token. Add pending same-document tree selection regression (desktop and mobile) alongside the existing different-document/identity cases.
  - **Focused proof:** `/private/tmp/akh-c7-same-selection.test.ts` mounts the real `WorkflowPanel`, holds its initial `/workflows/pages/A` response, clicks A in the desktop tree, then releases A's valid detail. Observed `DETAIL_CALLS 1 HEADING null`; final assertion fails with `expected null not to be null`. This is one targeted test against a concrete unanswered doubt; no package suite or product edits. The temporary config is `/private/tmp/akh-c7-review-vitest.config.mjs`. The first probe invocation used a less precise assertion on optional text and also observed the missing heading; only that assertion was changed to a direct non-null check for the second invocation.
- **Critical: 0. Important: 1 (N1). Minor newly introduced: 0.**

### Out-of-Scope Observations

- **Existing M2 remains non-blocking:** `.superpowers/sdd/2026-11-16-essential-convenience/logs/c7-f1-check-final.log:285` retains the pre-existing >500 kB chunk warning. No unrelated code was re-reviewed for new findings.
- **Operational limits remain unverified:** real corporate IdP/data, device/IME/screen reader, production scale, long-lived unattended machine authority and multi-process cursor behavior are not established by these local tests. The report preserves these limits and does not reduce North Star/251 requirements.

### Checks

- Read the original findings and fix report, then inspected only the supplied `9e77efa..78c1974` diff in production/credential, UI/test, and evidence passes. No Git regeneration, index/HEAD/checkout mutation or helper agent.
- Narrow surrounding checks for the newly introduced credential boundary: `OidcAuth.revalidateInteractiveGrant`/`assertInteractiveGrant` and `executionSession` (`server/runtime/auth.ts:233`, `:263`, `:315`) confirm active human/session expiry, snapshot and session policy checks; existing `identityTransaction`/`assertSessionPolicy`, `WorkflowService.run` and membership/access ceilings establish the reused lock/current-authority boundary. OIDC work remains outside the canonical write transaction; credential/session assertions remain inside. Checked `jobs.revalidateCredential` solely because runtime optionally invokes it before dispatch; it does not manufacture C7 rights. No new authority escape or silent old-key expansion was found.
- Inspected final check output: `c7-f1-check-final.log:21` frontend486, `:77` Node48, `:94` imports16, `:143` evaluation41, `:155` requirements251, server types/build/static smoke pass. `c7-f1-ui-final.log:5` records 63 targeted UI/navigation/recovery tests; `c7-f1-native.log:1`, `c7-f1-admission-final.log:1`, and `c7-f1-machine-final.log:1` support current/compatible native evidence. The reported 9files81 plus carried12files178 is **21 unique files/259 across compatible runs, not one final259 execution**.
- Inspected updated browser assertions/results, canonical response hold/release harness, local OIDC provider wiring, and selection-focus screenshot. Four configurations are bound to fingerprint `f7290771005c698cc5d68728057f372aaa2692d2a632f84746994397e4367100`. Existing passing scenarios do not cover the unchanged-selection pending-load case reproduced by N1. Parent manifest verification was supplied; no redundant manifest or suite rerun was performed.

### Verdict

**Fix round: Findings remain open — N1 (new Important regression).** Original I1/I2/I3/I4 are addressed in their reported scenarios. **Task quality: Needs fixes** until unchanged-selection loading is preserved and its focused regression passes.


## Round2 implementation and rulings

**Ruling N1 — unchanged selection preserves its token.** Both tree selection and the document select handler compare current document/API/actor/space before replacing the generation object. For identical selection, the sole in-flight authorized response keeps its valid token; mobile focus intent binds that same token and waits for destination ready. Different selection/API/actor/space still replaces it and rejects old responses. Why: replacing the token without changing effect dependencies discarded the only load without starting another. Cost: two small equality guards (production diff4 additions/2 deletions); no extra fetch/retry or weakened current-response check. Existing I2/I4 generation/no-outside-focus logic remains.

**Ruling evidence — current UI, carried backend.** Final fullcheck runs on the new UI bytes; focused tests exercise same-selection desktop/mobile and all previous different-document/API/actor/space/focus/recovery cases. `git diff -- server` is empty. Therefore prior Round1 native9files81 and earlier12files178 are carried unchanged (unique21files259 across compatible prior runs), with **zero new native executions in Round2**. Why: this fix only changes client selection identity. Cost: native evidence remains explicitly prior, not relabelled current.

**Ruling browser harness — isolate same-selection after App is initialized.** The first new browser attempt held the initial leaf GET and timed out while locating the nested child expand button before reaching the same-item assertion; no product failure/root cause was established from that timeout. The corrected actual proof first loads the App, selects root document review with its real canonical detail response held, then selects that same pending review from desktop/mobile tree and releases the response. It asserts exactly one detail GET for that transition, current heading appears, and mobile focus lands on it. Why: this targets N1 without depending on initial App/nested-tree bootstrap timing. Cost: real-browser proof covers initialized-App pending selection; separate real WorkflowPanel regression covers the initial A load directly. Failure log remains; product was not changed for this harness correction.

## Exact commands and results

Same worktree, Node24 PATH and loopback synthetic DB environment as prior sections. Log directory remains `logs/` beside this report.

- `npx vitest run src/operational/convenience/structure.test.tsx` → `c7-f2-red.log`, exit1:15pass/2fail, desktop and mobile authorized pending A response both left heading null; detail call count1.
- After the equality guards, `npx vitest run src/operational/convenience/structure.test.tsx src/operational/convenience/Navigation.test.tsx src/operational/convenience/exact-recovery.test.tsx` → `c7-f2-green.log`, exit0:3files65 (structure17/Navigation35/exact-recovery13). Same-item cases assert one GET before/after release; mobile heading focus and prior I2/I4 controls pass.
- `npm run check` → `c7-f2-check.log`, exit0: **final frontend488/Node48/import16/evaluation41/requirements251/server types/build/static HTTP smoke**. Existing large chunk warning retained. Harness/docs-only changes afterwards do not change product source; no unnecessary rerun.
- Runtime command: `AKH_C7_SYNTHETIC_CAPTURE=1 npx tsx docs/ui-validation/2026-11-18-document-structure/structure-runtime.ts`; frontend `node docs/ui-validation/2026-11-18-document-structure/manifest.mjs --frontend-start` then `npx vite --host 127.0.0.1 --port 5197 --strictPort`.
- Browser command: `AKH_C7_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-18-document-structure/capture.mjs` → `c7-f2-browser.log` exit1 for the pre-assertion locator timeout above; final `c7-f2-browser-final.log` is recorded below after completion.

Final `c7-f2-browser-final.log` exit0: all4 viewport/theme configurations passed pendingSameSelectionSingleFetch;390 also sameSelectionMobileFocus verified. Original3-level path/hidden title/keyboard move/old-link rename/linked duplicate replay/issued machine permit+source revoke/delayed move refresh/different-document ready focus/outside focus preservation remain passing; pageErrors empty. The browser holds actual canonical responses without replacing DTOs. Current14PNG include four added same-selection proofs; old before-fix PNG stays historical. Representative1440-light/390-dark same-selection images were visually inspected. Native initial-load test and initialized-App browser scope are distinguished above.

Final runtime `2026-11-17T17:23:40.983Z`, frontend `2026-11-17T17:23:42.778Z`, captured `2026-11-17T17:24:57.070Z` (KST2026-11-18); production fingerprint `feeb4aa18c5fa52721059d3efaa5bbfee268233d6d72299d0d51eaef31868ab6`. Node24.22.2/macOS/Chromium headless/Asia-Seoul,1440×1000/390×844×light/dark; explicit synthetic loopback actor+real canonical HTTP/PG/localOIDC grant checks, no enterprise IdP/quality claim. Fresh runtime followed the failed initial harness attempt.

Cleanup `2026-11-17T17:26:13.467Z`: owned DB/profile/Chromium0,4397/5197 closed,parentPG alive; owned localOIDC provider closed with runtime. Manifest binds328 production/3 harness/4 regression sources/17 artifacts and historical+new logs; final verify and tracked-path gate recorded at packaging. Product/backend bytes remain as tested, no new native run.

## Self-review and remaining limits

N1 was a real regression introduced by Round1's unconditional token replacement; it is recorded in MISTAKE_LOG without relabelling it as a test error. The new RED demonstrated both affected surfaces, and GREEN retains distinct-identity race protection and destination-ready focus. Review compared the tiny product diff, unchanged backend, test call count assertions and actual held canonical response harness. Previous Round1 486/f729... screenshots/check are historical after this UI change; native remains compatible because backend is unchanged. North Star and251 criteria remain unchanged. M2 bundles, full-state policy costs, short parent-session C7 grants, real corporate IdP/data/operational/IME/screen-reader/model-quality limits remain. Independent scoped re-review/CI/merge is controller-owned.

Round2 packaging: fail-fast cached diff check and manifest verification passed. All421 manifest paths and report were tracked in the index; explicit diff gate confirmed no server changes from FIX_BASE. This metadata-only follow-up records the fix hash without changing tested product/evidence bytes.


# Final combined fix wave — F1/F2

Status: **DONE_WITH_CONCERNS**. FIX_BASE `595358f469c86d33ad1ac9326414c4b8fc0662d8`. Both named findings are implemented and locally verified; controller owns the one scoped final re-review, exact-head CI and merge. This agent did not push/open/merge or delegate. No UI/backend-schema/API DTO changes beyond the two narrow server fixes; migration143/legacy ceilings remain unchanged. Scoped fix/evidence commit is recorded in the following metadata entry after commit.

## Complete final review, verbatim

# C7 whole-branch final review — PR #73

**Range:** `de4e150b7a37003ec23a885fb32205b49d107a7f..595358f469c86d33ad1ac9326414c4b8fc0662d8` (all six commits). **Verdict: With fixes / not ready to merge.** **0 Critical, 2 Important, 0 new Minor.** Existing deferred limitations are listed separately below.

Applied the supplied `requesting-code-review/code-reviewer.md` senior-review template. Reviewed the entire feature range, not only the latest UI fix, against task-7-brief, task-7-constraints, North Star, implementation report and controller rulings. The earlier I1–I4/N1 fixes work in their reported scenarios, but two untested cross-component integrations remain broken.

## Strengths

- **Canonical transaction reuse is substantive.** `server/workflows/service.ts:137`, `:933`, `:1118` keep structure changes under the existing mutation gate/workspace transaction and current authorization. Parent state, sibling rank, metadata event, audit and mutation receipt commit together. The C7 `rejectBroadening` path compares authoritative reader sets and rolls back expansion; the existing state API retains its prior clamp. No independent mutation engine or direct-publication shortcut was added.
- **Confidential navigation uses current policy.** `server/workflows/service.ts:810`, `:874` use canonical visibility, current titles and ancestor/source policy. Results are capped at 25, raw candidate scanning at 100 plus lookahead, `hasChildren` reflects authorized children, and encrypted continuation hides raw positions. Actor/space/parent/limit/data/authority binding and stale rejection are real, although the same conservative binding causes F1 when combined with credential issuance.
- **Private duplication preserves the intended workflow.** `server/workflows/service.ts:1029` creates a page-less private draft with exact origin version, source IDs and dependencies through the existing save primitive. Original I1's replay fix uses a trusted private original-input hash only after exact outer-request matching and current history/lineage checks. It does not accept that bypass parameter from a DTO, create independent evidence, or skip later disclosure/review/publication. F2 identifies an adapter configuration hole in those dependency checks, not an objection to the private-copy design.
- **The new delegation boundary is narrow.** `server/convenience/structure.ts:62`, `:147` require explicit authenticated-human issuance, strict normalized operation/input, workspace/actor binding, expiry no greater than 15 minutes and an active parent session. Only the private C7 dispatcher constructs the interactive context and immediately invokes C7; it returns no reusable elevated context. `server/runtime/http.ts:262` and `server/runtime/mcp.ts:155` independently narrow routes/tool listing/tool execution. Existing `akh_sk_` allowlists and general delegated action ceilings are unchanged. Actual issuance, legacy denial, wrong input/resource/operation/workspace, expiry, revocation, ended session and current-capability tests exist.
- **Concurrency and lifecycle checks are meaningful.** Queued tests observe workspace-lock waits, change authority before release, and assert rejected new drafts/receipts. `server/convenience/structure.test.ts:232`, `:432` exercise current ACL/trash/retention/revision and neighbor reorder/trash races. Migration 143 is a separate page-linked table; its 500-row inserts, unique identity, rollback/new-pool rerun, source/page/workspace erasure, legal hold and unknown-column fail-closed checks are covered. The order table is product metadata rather than a blanket erasure exemption.
- **The client fixes preserve existing behavior.** `src/operational/workflows.tsx:380`, `:418`, `:753`, `:999` bind detail responses to API/actor/space/document and preserve the token for an unchanged selection. Mobile focus waits for the actual destination heading and cancels on outside intent. `PageTree.tsx` provides the same pending placement form for keyboard and drag, current mutation identity on retries, and existing Composer/draft routes for copy/child creation. No cosmetic App.tsx hunk is needed: the actual workbench integration, stable URLs and mobile behavior are present.
- **Evidence is candid.** Failed fixtures, old passing source states, the retention omission, UI races and historical screenshots remain labeled. Final local check counts and compatible native coverage are not misrepresented as enterprise or production acceptance.

## Issues

### Critical (Must Fix)

None found in the reviewed range.

### Important (Should Fix)

#### F1 — Issuing the exact machine grant invalidates its own required placement token

**References:** `server/workflows/service.ts:783`; `server/workflows/manual-disclosure.ts:94` (`access_credentials` in the shared digest inputs); `server/convenience/structure.ts:119`; `server/workflows/service.ts:960` (before-neighbor token validation).

The issuer must first obtain a destination tree `revision` and include it in the exact move input whenever `beforeId` is non-null. `structureBinding()` includes `listRevision()`, whose scoped tables include every `access_credentials` row. `issueCredential()` then inserts the new grant into that table. At dispatch, the reconstructed interactive context has the original session/actor, but the freshly computed data/authority digest includes the new credential row and cannot match the token from before issuance. The operation therefore rejects itself as `STALE_VERSION` without any competing document/permission change.

The caller cannot repair this by fetching a newer token: the issued grant is bound to the full original normalized input, so replacing `expectedStructureRevision` fails its exact-input fingerprint. Issuing another grant repeats the invalidation. This blocks the machine equivalent of normal “place before this sibling” moves; it also blocks append requests that include the optional token. Existing issued-key move tests only append without a structure token, so their green result does not cover this path.

**Independent actual-path proof:** `/private/tmp/akh-c7-final-probe.mts` starts a local OIDC UserInfo provider and the real runtime handler against a fresh isolated PostgreSQL fixture. It reads the human tree token, issues the exact move through `/convenience/credentials` (201), then executes that grant through the real machine HTTP path. Result: `409 STALE_VERSION`. A fresh-token cookie request for the same reorder succeeds (200, page revision 1). There is no intervening competing mutation before the machine rejection. Both successful probe runs reproduce it.

**Required fix:** make structure authority/data binding and exact-grant issuance compatible without weakening current credential/session/source/parent checks or allowing the agent to replace the bound input. For example, avoid treating issuance of unrelated/exact C7 capability records as a structural policy change while independently validating the active credential, or use a deliberately reviewed issuance protocol that freezes/validates the structure snapshot consistently. Do not simply omit the before-neighbor guard or drop all authority binding. Add actual issued-key HTTP and MCP before-neighbor tests, including replay and a genuinely concurrent neighbor/ACL change that still rejects.

#### F2 — Runtime MCP omits the configured origin and loses absolute internal-link lineage/current revocation checks

**References:** `server/runtime/mcp.ts:49`; comparison `server/runtime/http.ts:585`; `server/workflows/service.ts:197`, `:319`, `:1067`; `server/workflows/references.ts:39`, `:71`.

The HTTP structure adapter constructs `WorkflowService(..., options.origin)`. The new runtime MCP structure adapter constructs it without the trusted deployment origin. `internalReferenceIds()` intentionally accepts absolute/network-path same-origin document links only when that origin is supplied. Consequently, an ordinary copied stable absolute link such as `http://localhost/?app=1&space=<space>&document=linked` is interpreted as an internal dependency over HTTP but ignored over MCP. Both initial save and receipt-history revalidation use that differently configured service.

This is more than an output formatting difference: the MCP copy fails to retain the linked page's version pin, and subsequent MCP replay does not enforce that link's current access restriction. Supplying the parent session and the same canonical class does not make these paths equivalent when the parser configuration differs.

**Independent actual-path proof:** in the same isolated probe, the canonical origin is `http://localhost`, the origin page contains a valid absolute stable link, and its metadata has no separately pre-populated link relation (as in the existing rendered-link regression pattern). HTTP duplication returns `dependencyVersions: {topic: 1, linked: 1}`. An actually issued C7 credential through the real MCP SDK returns success with only `{topic: 1}`. After removing the caller's reader row on `linked`, the HTTP same-key replay returns `404 NOT_FOUND`, while the MCP same-key replay still succeeds and returns the copied content with the incomplete dependency map. This demonstrates missing dependency/current-policy enforcement; it is not a claim that the probe read the linked page's body.

**Required fix:** supply the same trusted runtime-configured origin to the MCP workflow service (or inject the same fully configured service instance). Do not derive trusted origin from caller-controlled headers or accept all absolute URLs. Add actual HTTP/MCP parity tests for relative and same-origin absolute links, same-key replay and linked-page/source revocation; retain external-origin exclusion. Ensure current-history revalidation follows the same configuration after the fix.

### Minor (Nice to Have)

No new minor finding. The pre-existing large-bundle warning remains deferred; it is not a clean-build-output or production-performance claim.

## Checks and review scope

- Read the six-commit feature changes in passes: service/transport/admission; transaction extraction and canonical policy interactions; migration/erasure/retention; UI/navigation/focus; all four regression sources; harness, docs and evidence. Inspected historical failure/status summaries across all 69 packaged logs and the final fullcheck/affected-native output in detail. The source-manifest/hash verification was supplied by the controller; I did not rerun the full manifest or broad suites merely to repeat that evidence. No CodeGraph index exists in the worktree, and none was created.
- Concrete surrounding-code checks were limited to named cross-component risks: `WorkflowService.run/page/requireVersion/saveDraftInTransaction/draftHistoryAccess/referenceDependencies/setDocumentStateInTransaction`; `database.transaction` and the mutation gate; `repository.readers/requireRead` and `provenance.visiblePageIds/inheritedProvenance`; version metadata hooks for rollback/broadening; `OidcAuth.executionSession/revalidateInteractiveGrant/assertInteractiveGrant`; access credential issuance/authentication/revocation/effective ceilings; `jobs.revalidateCredential`; cursor encryption and digest inputs; runtime auth/CSRF/route/MCP dispatch; WorkflowPanel detail-load and draft-recovery lifecycle. These checks establish current session/credential assertions inside the canonical locked transaction and expose F1/F2 at the adapter/binding boundaries.
- Final `c7-f2-check.log` records frontend 488, Node 48, import 16, evaluation 41, all 251 requirement mappings, server types, build and static HTTP smoke passing. `c7-f2-green.log` records focused structure/navigation/exact-recovery 65. Backend evidence is carried: 9 unique files/81 plus 12 unique files/178 from compatible executions, totaling **21 unique files/259 across runs, not one final 259-test run**. These recorded passes do not cover F1/F2.
- Read the actual canonical-response hold/release browser harness, local OIDC/synthetic actor boundary, source startup binding, current JSON and cleanup records. Independently opened `1440-light.png`, `1440-dark.png`, `390-light-selection-focus.png`, and `390-dark-same-selection.png`. Current four-config evidence is bound to `feeb4aa18c5fa52721059d3efaa5bbfee268233d6d72299d0d51eaef31868ab6`; it demonstrates the recorded desktop/mobile flows, including current heading focus, but uses relative links and does not perform a token-bound machine reorder.
- Ran only the concrete targeted probe above, then extended it with the linked-page revocation assertion. Script: `/private/tmp/akh-c7-final-probe.mts`; final output: `/private/tmp/akh-c7-final-probe.log`. The first sandboxed `tsx` CLI invocation failed at IPC setup before connecting; the authorized `node --import tsx` probe succeeded. Both probe databases were fresh UUID names and dropped in `finally`; local HTTP/OIDC listeners were closed. No product, harness, tests, checkout, index, branch or parent database/container was changed. No helper/subreviewer or broad suite rerun was used.

## Recommendations

Address F1 and F2 together in the controller's one combined final fix wave, then perform the single scoped re-review of those fixes and their interactions. Keep the existing authority/atomicity and UI regression evidence, and add the missing actual-issued reorder and transport-origin parity scenarios rather than increasing repeated unrelated test counts. Update task/handoff evidence so current counts and any carried runs remain distinct. Exact-head required CI remains a separate controller gate; no final CI or production acceptance is asserted here.

## Declined to judge

- **Large-workspace throughput/latency of full-state visibility, SQL digest scans and sibling-rank rewrites:** reviewed as explicit architectural costs, but no production-sized workload evidence exists; no scalability acceptance inferred from bounded output sizes.
- **Cursor/structure-token survival across process restart or multiple replicas:** process-local encryption deliberately invalidates tokens and the report discloses restart behavior; shared-key/multi-replica operation is outside this local C7 implementation and remains operational follow-up.
- **Existing >500 kB chunks and complete app loading performance:** the warning predates C7 and remains recorded; optimization was not part of this fix, and no end-user loading performance was measured here.
- **Real corporate IdP/directory/network/session-policy operation and enterprise security acceptance:** local OIDC plus native authority races prove local code paths only; corporate deployment evidence is absent.
- **Physical drag/touch, real Korean OS IME, screen-reader and full device accessibility acceptance:** keyboard/browser focus and React tests cover the named C7 interactions, but they do not provide those broader operating-environment proofs.
- **All production migration crash points, live deployment rollback, backup retention and operational erasure certification:** the migration test proves rollback and a new-pool rerun plus synthetic hold/erasure behavior; it does not establish those production procedures.
- **Long-lived unattended service-account C7 authority:** the explicitly approved new contract is a maximum-15-minute exact operation dependent on a live human parent session; durable unattended authority would require a separate reviewed product/security contract.
- **Knowledge quality or downstream agent effectiveness improvement:** C7 improves navigation and safe private reuse; no controlled EVALUATION experiment was provided, so no semantic/agent-performance outcome is claimed.

## Assessment

**Ready to merge? With fixes.** The branch substantially meets C7's human navigation, canonical mutation, lifecycle and bounded-delegation design, and the earlier UI/replay fixes are supported. F1 prevents the promised machine placement operation, and F2 makes MCP copy/replay lineage authorization differ from HTTP; both are independently reproduced in real local transport/database paths and should be fixed before merging. **Final counts: 0 Critical / 2 Important / 0 new Minor.**


## Implementation, judgments and costs

**Ruling F1 — exclude only exact C7-only stored grants from structure authority digest.** `listRevision` has a server-only `credentialBinding` option whose default remains `all`; only `WorkflowService.structureBinding` passes `structure`. The SQL exclusion requires exactly five action-array entries, the fixed marker, move/duplicate, two 64-hex bindings and the exact serialized role/identityRole/csrfHash/subjectHash snapshot shape. Mixed, ordinary, unknown, malformed and SQL-null payloads stay in the digest (`IS NOT TRUE`, rather than nullable NOT). No client DTO selects this behavior and no marker grants authority. Why: issuance itself otherwise invalidates the immutable expectedStructureRevision it authorizes. Cost: a narrowly format-coupled C7 predicate; future formats remain conservatively bound and need deliberate review. Full actor/session/space/parent/order/source/effective policy/erasure inputs remain bound, while the executing grant's expiry/revocation and parent session/current capability remain independently checked under existing canonical transaction locks. Replayed mutation still rechecks authorization before returning its original receipt. No generic credential/old key rights changed.

**Ruling F2 — configure runtime MCP with the same trusted origin.** Runtime passes `options.origin` to `handleMcp`, which supplies it to the canonical WorkflowService. Why: rendered stable absolute same-origin links must create the same dependency pins and current-history checks over HTTP/MCP. Cost: one optional internal adapter argument; direct internal callers without deployment origin retain conservative absolute-link behavior. Caller Host/Origin headers never configure the parser; actual tests connect through a random loopback HTTP address while trusted origin is http://localhost. Relative and same-origin absolute links pin linked version1 in both transports; external origins remain excluded. Revoked linked/source access rejects same-key replay without returning copied content or creating another draft.

**Ruling evidence — new final server paths and current UI runtime, named carry.** Current native is 11 unique files/97 tests across two final commands, not one97-test invocation. Prior compatible coverage carried is13files183: erasure-db28, product-erasure18, retention30, migration1, bulk7, lineage-closure32, navigation-http1, trashauth2, publicationintegration8, versions6, workflows36, identity/native7, credential-erasure7. Total distinct known coverage24files280 is an aggregate across executions, not a current280 run. Why: final affected structure/credential/HTTP/MCP/C6/Home paths are rerun, while unchanged lifecycle implementation retains earlier evidence. Cost: carried tests are explicitly not certified as newly executed. Earlier259/check/captures remain historical; current check and browser bind final production bytes.

## Exact commands, outputs and failure distinction

All commands ran in `/Users/wt.jeong/.codex/worktrees/31d9/agent-knowledge-hub`, Node PATH `/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH`, and native/browser used `TEST_DATABASE_URL=postgres://knowledge_test:test-only-convenience@127.0.0.1:32769/knowledge_test`. scripts/test-server.mjs owns UUID databases; the parent DB remains alive. Logs below are in `logs/` beside this report, terminal ANSI/trailing whitespace only normalized.

1. `node scripts/test-server.mjs server/convenience/structure-final.test.ts` before product changes: `c7-finalwave-red.log` exit1, first HTTP409 product failure plus9 fixture failures from a globally keyed reused session ID. Fix fixture to UUID per test, same command → `c7-finalwave-red2.log` exit1,6pass/4fail, including invalid negative order fixture and its pending fetch cleanup rejection. Change rank to allowed positive100; same command → **`c7-finalwave-red3.log` exit1,7pass/3fail**: actual issued HTTP before-neighbor409; actual MCP call rejects (test adapter normalizes SDK thrown denial to status403, not a claimed raw HTTP status); same-origin absolute MCP copy lacks linked pin. This is the clean RED for F1/F2.
2. After narrow product fix, same command → `c7-finalwave-green.log` exit0,10/10. Then add malformed/null-row conservative assertions and use `IS NOT TRUE`, plus regex character classes to avoid JS brace escaping ambiguity; final affected command below is the final-byte GREEN. `npx prettier --write server/convenience/structure-final.test.ts` → format log exit0.
3. Initial nine-file command mistakenly named nonexistent `server/agents/credentials.test.ts` → `c7-finalwave-native.log` exit1 `INVALID_SERVER_TEST_FILTER` before tests/database. Correct canonical paths, no product change.
4. `node scripts/test-server.mjs server/convenience/structure-final.test.ts server/convenience/structure.test.ts server/convenience/structure-http.test.ts server/convenience/home.test.ts server/convenience/home-http.test.ts server/workflows/manual-disclosure.test.ts server/workflows/new-document.test.ts server/access/access.test.ts server/agent-credentials.test.ts` → **`c7-finalwave-native2.log` exit0,9files95** (access10/agent-credentials3/HomeHTTP1/Home10/new-final10/structureHTTP2/structure20/manual9/new-document30).
5. `node scripts/test-server.mjs server/agents/mcp.test.ts server/runtime/search-mcp.test.ts` → **`c7-finalwave-mcp.log` exit0,2files2** existing separate MCP transports. No broad allowlist/ceiling changes.
6. `npm run check` → **`c7-finalwave-check.log` exit0: frontend488, Node48, import16, evaluation41,251 requirement mappings, server types, build, static HTTP smoke.** Existing >500kB chunk warning remains. This is the single final fullcheck after final product bytes; no further product changes.
7. `AKH_C7_SYNTHETIC_CAPTURE=1 npx tsx docs/ui-validation/2026-11-18-document-structure/structure-runtime.ts` → runtime log; `node docs/ui-validation/2026-11-18-document-structure/manifest.mjs --frontend-start` then `npx vite --host 127.0.0.1 --port 5197 --strictPort` → frontend log. `AKH_C7_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-18-document-structure/capture.mjs` → **`c7-finalwave-browser.log` exit0**,4configs/all asserted flags true or appropriate not-applicable, errors[]. Runtime stop exit0, Vite intentional SIGINT exit1 is cleanup rather than check failure. No browser failure in this wave.

New10 native cases use actual OIDC UserInfo/session/CSRF, actual human issuance and real HTTP/MCP SDK: initial before-neighbor execution + same input replay in each transport; queued neighbor rank/linked ACL/key revoke while blocked on canonical workspace lock with no moved state/receipt; ordinary/mixed/malformed/null credential invalidation; relative/absolute/external copy parity/replay and linked/source current revoke with two drafts only/no content on denial; actual issuance invalidates C6 disclosure/Home cursors. Prior current structureHTTP2 also verifies expired/revoked grants, ended and queued-revoked session, queued/current capability removal, wrong operation/input/resource/workspace/general endpoint/old key denial. Current structure20 retains cycle/self/trash/current authority/retention/order/erasure/idempotency regressions.

The independent reviewer reproduction is preserved as `task-7-final-review-probe.mts` and `logs/c7-finalwave-review-probe.log`, explicitly historical pre-fix evidence. It is not rerun or presented as final success. Its same-origin absolute probe returned incomplete MCP dependency and content after linked revoke; the new final actual SDK regressions close that exact gap.

## Browser, cleanup and source binding

Fresh runtime `2026-11-17T17:48:01.059Z`, frontend `2026-11-17T17:48:12.311Z`, capture `2026-11-17T17:49:25.724Z`. Production fingerprint `cf4d6daf5b633d4273adbf688a137024c08e943be7ffcc6577b1695707b0331e`. macOS/Node24.22.2/Chromium headless/Asia-Seoul,1440×1000 and390×844 light/dark. Browser actor adapter is explicitly synthetic loopback; all successful DTOs are canonical HTTP/PostgreSQL unchanged. Local OIDC grants are actual runtime admission tests, not corporate IdP evidence.

Four configs preserve same-pending-item singleGET/mobile ready-heading focus, different-selection delayed A response rejection, outside-focus intent, Escape, three-level authorized path/hidden title omission, keyboard human move, stable old URL after move/real trash→restoreTitle rename, private copy and source revocation. Each now obtains the human tree token, issues an exact before-leaf move for review, executes/replays the unchanged machine payload and asserts real root order. Fixture rendered link is now trusted same-origin absolute and machine copy retains review/leaf version pins through rename replay, then rejects source revoke. HTTP+SDK relative/absolute/external transport parity and queued server races are native evidence; no claim those events have separate screenshots. Current14PNG+historical failedPNG remain, with two representative desktop/mobile images visually inspected; unchanged byte-identical PNGs were freshly overwritten by the run.

Cleanup `2026-11-17T17:50:06.023Z`: owned DB/profile/Chromium0,4397/5197 closed,parentPG alive; runtime closed its own local OIDC provider. `c7-finalwave-cleanup.log` records actual assertions. Manifest binds328 production files,3 harness,5 dedicated regression sources,17 artifacts and all preserved C7 logs. Final manifest/checked fail-fast tracking gate is recorded in the following packaging entry.

## Self-review / North Star / remaining concerns

Reviewed the complete four-file product diff and new actual-path regressions. The digest exception is server-only, narrow and NULL-safe; no underlying authority predicate or canonical lock removed. MCP origin comes from deployment configuration, not request headers. No schema, UI, generic delegated capability, legacy credential, source/parent/hold or erasure bypass was introduced. Exact receipt input and current linked/source history remain enforced in both transports.

F1/F2 were actual missed cross-component product defects in earlier passing evidence; the clean RED separates them from test-fixture mistakes. They are recorded without rewriting history. C7 improves current-authority navigation/private reuse within Ingest→Query→Lint and reviewed publication, preserving copied-vs-independent evidence, source restrictions, current approval versions and no duplicate writes. No North Star or251 acceptance reduction, model-quality/agent-effectiveness or production claim. Remaining concerns: controller scoped final review/CI/merge, full-state visibility/digest/rank costs without large-workspace performance proof, process-local token restart/multi-replica limits,15-minute parent-session machine grants, existing large chunks, real corporate IdP/device/OS IME/screen-reader/operational erasure/migration/quality acceptance. No known F1/F2 blocker remains locally.

Final-wave packaging gate: `git diff --cached --check` and manifest `--verify` passed. All436 manifest paths plus report/reviewer-probe source (438) were present in the index, including ignored logs/report. Exact FIX_BASE/isolated branch were asserted before commit. Historical reviewer probe SHA256 `a0f03e38f53bcfc3389d02ef35666301ac496e0d4ff3da6551b3171d2ceaa558`; verbatim original final review SHA256 `538d20c0e468df49c2a59cc1a11fe2d190b2fbc013b6cd32820fc130b3fce77f`. Root checkout was clean main tracking origin/main. Only documentation is appended after tested product/evidence bytes; no redundant checks or claim of controller acceptance.
