# Authoritative round1 final result: DONE_WITH_CONCERNS

I1/I2 and observed final-refresh races fixed locally. Legacy version identities remain unchanged; restore effective relations are disclosed and hash-bound; final preview writes one receipt only. Final fullcheck494/48/16/41/251/types/build/smoke and current native6files50 pass. Preceding8files134 explicitly carried. Final4config20PNG, source/artifact manifest and cleanup verified. Controller rereview/CI/integration pending. Subsequent sections preserve historical attempts and the full task review; later authoritative entries supersede earlier current/implementation descriptions.

# Current status: round1 fixes verified; see appended FIX ROUND1/5. Earlier round0 acceptance and backfill-invalidation ruling are superseded.

# Task 8 report: internal links and backlinks

Status: **DONE_WITH_CONCERNS** (local implementation/verification complete; independent controller review, remote CI and integration pending). Base3b8f310c4ecc2b8966471c3fe99e3ef8bd461e15; branch feat/convenience-internal-links-20261118; native worktree /Users/wt.jeong/.codex/worktrees/411f/agent-knowledge-hub. Root checkout verified clean main...origin/main. No push, PR, merge, helper/reviewer, duplicate worktree or CodeGraph indexing.

Implementation commit: **4e0954828e1ed37d5e4aef78c47a7ee788f6ea2b** (`feat: connect internal document links and backlinks`), 90 files including code/tests/hand-off/evidence. This report is the subsequent documentation-only commit; its identity is available with `git log -1 -- .superpowers/sdd/2026-11-16-essential-convenience/task-8-report.md`. No product bytes changed after final verification.

## Scope and spec mapping

Authoritative task-8-brief/constraints/interface-notes followed. UXC-07 / EDT-001 (portable Markdown) / EDT-007 (internal link completion/backlinks and permission exclusion). No251 criteria/classification, North Star or C9 block requirement changed.

| Contract | Files and behavior |
| --- | --- |
| Stable refs/publication | src/domain/types.ts, server/workflows/references.ts, server/publication.ts, server/workflows/new-document.ts: parse actual rendered local links, store canonical version refs, hash-covered trusted origin, atomically replace ID index with publication. Same mutation replays existing publication. |
| Rebuild/erasure | server/convenience/links.ts, migration144, scripts/rebuild-links.ts; server/operations/erasure.ts, server/retention/inventory.ts: bounded100/resumable latest-version rebuild under shared transaction/erasure gates, stale writes rejected, registered index/JSON reference tokens deleted, schema drift rejected. Existing product-erasure helper reused without cosmetic direct edits. |
| Authorized reads | server/workflows/service.ts extends existing navigation/linkSearch. resolveLinkSuggestions default10, legacy linkSearch default20 preserved. backlinks default/max25, encrypted identity/revision-bound ten-minute cursor. Stale/missing index falls back to canonical version refs. Current source/target/raw-source/ancestor ACL/erasure checked; final identity refresh triggers fresh read projection. Explicit10000 scan bound. |
| API | server/convenience/http.ts and runtime/http.ts add GET /api/v1/convenience/pages/:id/backlinks with existing auth/CSRF/admission stack. Duplicate/unknown query keys and invalid bounds rejected. Existing workflows routes and navigation DTO remain compatible. |
| UI | LinkAutocomplete.tsx wraps the existing LinkCompletion in document-navigation.tsx; DocumentComposer.tsx and workflows.tsx share it. Explicit duplicate-title choice, keyboard/focus/IME suppression/Escape, portable ID URL, target dependency version pin. Backlinks.tsx supplies identity-isolated paging, failure vs empty, focus/60s refresh in existing RelatedDocuments. |
| Discovery prerequisite | server/runtime/knowledge.ts assigns only NEW answer.at from DB clock inside existing atomic save. New runtime/discovery-clock.test.ts; original discovery.test.ts unchanged. |
| Tests | links.test.ts(13), links-http.test.ts(1), links-migration.test.ts(2), discovery-clock.test.ts(2), frontend links.test.tsx(5), existing document-navigation.test.tsx endpoint compatibility fixture. |
| Evidence/docs | docs/ui-validation/2026-11-18-internal-links/*,42 c8 logs, this report, AGENT_HANDOFF, MISTAKE_LOG, essential-convenience plan. |

## Rulings: what, why, cost

1. Version metadata is canonical and the new table stores only derived endpoint IDs, not titles. This preserves current canonical authorization and permits rolling repair. Backfill enriches latest legacy version metadata without changing original body/title/time, but can invalidate prior approval fingerprints/cursors and require rereview. It never regresses a concurrently published version because the same workspace/erasure gate and current-version equality guard are used.
2. Keep rendered Markdown parsing and trusted configured origin from C7. Relative stable URLs are local; absolute/network paths require exact trusted origin; Host is not trusted and external URLs/code blocks do not create local refs. Plain [[title]] remains unresolved. sourceBlockId:null explicitly means unknown; no fabricated block ID or C9 acceptance.
3. Existing semantic Page.links remains the published discovery graph. Manual edits remove old body-derived edges before recomputing current ones; prior provenance remains an access ceiling. No parallel citation/privacy/relationship engine.
4. Index read candidates and navigation are bounded10000 with explicit failure. Full canonical state/revision scans and a second read projection after async identity refresh prioritize correctness; scale/latency of this cost is unmeasured. Cursor invalidation is conservative on authority/data changes.
5. Controller authorized the narrowly scoped pre-existing discovery clock repair because required C8 ranking regressions exposed it. No fixture timestamp normalization, sleeps/retries, report-bound widening, historical row rewrite or queryAsOf change. New persistence at uses DB clock; durable replay returns its existing result. Additional DB clock query is the cost.
6. Synthetic actors and local model HTTP prove functional integration only. No production IdP, OS IME, semantic/model quality, load or deployment acceptance. Existing large Vite chunk warning remains.

North Star loop/invariants: authored connections enter Query/navigation/maintenance only after review/publication; drafts stay out of public graph/rank. Preserve current source ceilings, approval/version equality and replay idempotency. Evaluation here is functional/security with synthetic data; knowledge/agent performance remains a goal until EVALUATION controlled experiments.

## RED, GREEN and historical failures

All log paths below are relative to .superpowers/sdd/2026-11-16-essential-convenience/. Commands ran in the isolated worktree using Node24 via PATH=/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH. Native commands additionally used TEST_DATABASE_URL=postgres://knowledge_test:test-only-convenience@127.0.0.1:32769/knowledge_test and scripts/test-server.mjs, which creates/drops UUID test DBs.

| Exact command (with above environment) | Log | Observed output/exit |
| --- | --- | --- |
| node scripts/test-server.mjs server/convenience/links.test.ts | c8-links-red2.log |8failed/8, exit1: missing service/canonical metadata |
| same | c8-links-green3.log |8passed, exit0 |
| same | c8-links-red3.log |3failed/8passed, exit1: replacement and erasure behavior |
| same | c8-links-green4.log |11passed, exit0 |
| same | c8-final-acl-red.log |1failed/11passed, exit1: async final identity refresh revoked source |
| same | c8-final-acl-green.log |12passed, exit0 |
| same | c8-order-red.log |13passed, exit0; filename misleading, characterization not RED |
| node node_modules/vitest/vitest.mjs run src/operational/convenience/links.test.tsx | c8-ui-red2.log |4failed, exit1 behavioral RED |
| same | c8-ui-green3.log |4passed, exit0 |
| same | c8-ui-identity.log |5passed, exit0 including late old-identity response |
| node scripts/test-server.mjs server/convenience/links-migration.test.ts | c8-migration2.log |2passed, exit0; supplemental upgrade/restart/drift evidence, not all implementation-before RED |
| node scripts/test-server.mjs server/runtime/discovery-clock.test.ts | c8-clock-red2.log |2failed, exit1: real DB timestamp assertion with host5min ahead, offline/model |
| node scripts/test-server.mjs server/runtime/discovery-clock.test.ts server/discovery.test.ts | c8-clock-green.log |2+15passed, exit0 |
| npm run check | c8-check1.log |4frontendfailed/488passed, exit1; legacy button/mock compatibility |
| npm run check | c8-check2.log |492frontend and all remaining stages passed, exit0; intermediate |
| npm run check | c8-final-check.log |493frontend/48Node/16import/41evaluation/251criteria/servertypes/build/smoke, exit0 |

Initial links-red was a NOT NULL fixture error; green1 still8failed, green2 false STALE_VERSION6failed from JSONB key order. ui-red/green1 collected no tests due module/JSX errors; green2 had2fixture failures. Migration first run1failed for missing resources FK. HTTP first run1failed because assertion expected error rather than actual code. Browser1 incorrect autosave-label wait failed; browser2 passed intermediate source. Full details and correction in MISTAKE_LOG; all original logs retained.

First native wave c8-native1.log exit1: discovery2 real failures and one C6 new-document5s timeout. c8-native-diagnosis.log exit1: original discovery1failed/14passed; C6 isolated30passed without timeout increase. Final wave passes both unchanged existing suites.

### Pre-existing clock diagnosis

The exact probe is preserved as docs/ui-validation/2026-11-18-internal-links/discovery-clock-probe.mts. Executed with node --import tsx /private/tmp/akh_c8_discovery_probe.mts and the above environment; c8-discovery-probe4.log exit0 records8 baseline +8 C8 actual new answers, alternating one citation/oversized envelope. All16 were ahead of the report upper bound and incorrectly omitted. Baseline sample answer.at18:57:02.798Z, report.to18:57:02.779Z, DB observed18:57:02.780Z; C8 answer.at18:57:03.878Z > report.to18:57:03.856Z.

Both discovery source hashes were0ee6ae0317383ccd13c12a968c5ad0647c639916a54103291207c403edd2671b. Baseline runtime hash6e90315e6c0b3438d60e193e5ef312cfd3ddc47eadb72c5936c2c81977194e03. Baseline code was a read-only git archive of3b8f310 under /private/tmp, not root checkout development. Probe import/dependency attempts1-3 failed before valid comparative evidence; one own orphan DB explicitly cleaned. Withdrawn fixture patch preserved; original discovery.test.ts remains byte-identical to base.

## Current final native verification

Exact command:
```sh
node scripts/test-server.mjs server/convenience/links.test.ts server/convenience/links-http.test.ts server/convenience/links-migration.test.ts server/runtime/discovery-clock.test.ts server/runtime/runtime.test.ts server/runtime/model.test.ts server/jobs/runtime.test.ts server/runtime/durable-mcp.test.ts server/convenience/structure-http.test.ts server/convenience/structure-final.test.ts server/discovery.test.ts server/workflows/navigation-http.test.ts server/workflows/lineage-closure.test.ts server/workflows/new-document.test.ts server/workflows/manual-disclosure.test.ts server/operations/erasure-db.test.ts server/operations/product-erasure.test.ts server/workflows/versions/publication-integration.test.ts server/workflows/workflows.test.ts server/service.test.ts
```
c8-final-native.log: **20files302passed, exit0**. Counts in runner order:1,2,13,10,2,15,52,28,18,2,1,5,12,25,32,9,1,30,8,36. Includes old exact MCP inventory, trusted-origin HTTP/MCP C7 parity, model/job/durable replay, publication/discovery/erasure/current access. Migration144 upgrade/103legacy-link backfill bounded100+4, restart, version-stale refusal, missing-index repair, drift and real erasure are exercised. No carried results are added to these current counts. Earlier baseline488frontend/48Node is controller-provided context, not current verification.

## Final browser and cleanup

See docs/ui-validation/2026-11-18-internal-links/README.md. Fresh runtime19:06:39.302Z/frontend19:06:49.999Z; completed2026-11-17T19:07:37.590Z. Production fingerprint c42ec27c1a0794ad068379d7eaf9bdddbae43a875b0af7f3bb5d95c50bd72891.

Command: AKH_C8_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-18-internal-links/capture.mjs (with above PG/Node environment). c8-final-browser.log exit0; four configurations1440x1000/390x844 times light/dark,12PNG. Actual canonical responses, no fabricated success DTOs. Duplicate-choice keyboard + synthetic composition + focus + stable URL/dependency pin + draft-no-edges + review/publication + renamed target navigation + revoked source backlink removal, no overflow/errors. Visually inspected one final image per configuration.

Only owned runtime21422/frontend21491 stopped. cleanup.json confirms own akh_c8_ DBs0, browser profiles0, ports4398/5198 closed, parent knowledge_test alive. ps absence query exits1 by its normal no-process convention; cleanup Node assertions exited0. No parentPG destruction or unrelated process cleanup.

Manifest generation/--verify exit0:333production,4harness,6regression sources,15artifacts,42logs, all SHA256. Runtime and frontend source fingerprints match final capture; scripts/rebuild-links.ts included. Manifest SHA256:7c94877fadc526cc86ae38cb361d472cc743e8c8b9ae4efd3dd6989b02d6b4cb; docs-only report changes do not change production fingerprint.

## Self-review and limits

Self-review checked canonical refs vs disposable index; same publication transaction/replay; erasure graph/schema classification; current source/target/raw/ancestor controls and final async revoke; cursor identity/ordering; configured origin parity; UI old actor response rejection, portable selection and target version capture; migration/rebuild/restart path; unchanged original discovery tests. Found and fixed the final identity refresh gap with meaningful RED before GREEN. Product/document diff --check passed. The staged raw-log diff check reports original tool trailing whitespace/blank EOF; those immutable logs are preserved. git diff --cached --check -- . :!*.log exits0. C4 recovery and C6 lineage regression remain green. No unresolved known functional failure in required local checks.

Remaining: conservative full-state/revision scan and double-read costs; explicit scan bound; legacy latest metadata enrichment can invalidate review/cursor snapshots; unverified production IdP/load/OS IME/accessibility/semantic quality; large Vite chunk warning; independent review/CI/integration pending. C9 verified block anchors remain future work, not silently implemented. No claims about genuine model synthesis quality or production readiness.


## FIX ROUND1/5 — current result (supersedes round0 acceptance claims)

Status: DONE_WITH_CONCERNS. FIX_BASE add8b4a3eadb9a506200c612d5beade1f93e4868. Both Important findings corrected and verified locally; controller scoped rereview/remote CI/integration pending. No helpers/reviewers, push, PR, merge, new worktree or root modification. Round1 implementation/evidence commit **7742f70fdf365dc570215d13c5f9808cc8a8048b** (`fix: preserve published identity and reviewed restore links`). This report is finalized by the following documentation-only commit; no product bytes changed after the recorded final checks/capture.

### Findings, decisions and exact scope

I1 is a real preservation regression, not merely an acceptable rereview cost. Existing versions.data participates in baseSnapshots and answer envelopes. Rebuild now derives legacy references from existing canonical current version/body/relations and replaces only version-keyed published_page_links under the existing transaction/erasure gate. replacePublishedLinks checks both latest version and the canonically recomputed refs. No UPDATE versions, approval rewrite, envelope rewrite or fake reapproval. NEW publication versions still store structured refs. No SQL migration change. Cost: legacy reads/rebuild parse existing body when canonical structured metadata is absent.

I2 shares effectiveReferenceIds across proposal normalization and restore preview. The explicit selected content and selected metadata relation set remain the inputs; required body targets are unioned before dependency capture/hash, never silently treated as historical relation selection. Plan stores before/selected/effective/induced sets. Canonical target/source/ancestor access is checked before admitting/returning each effective target, and current target versions enter the preview. Proposal captures envelopes; independent approval/publication retain exact plan/draft/hash and current-access checks. Configured origin flows through VersionService; no Host trust. Old plans without optional relationChanges retain the old hash shape. Transient old previews can fail stale and must be regenerated; historical approvals/envelopes are not rewritten.

The requester preview and independent reviewer list/exact detail receive explicit induced-ID disclosure. Reviewer DTO exposes only authorized induced IDs, not internal metadata/auth fingerprints. Shared RestoreRelationChanges renders the same message in VersionsPanel and App review. Existing metadata-only and selected-decision tests remain green.

Changed product files this round: server/convenience/links.ts; server/workflows/references.ts; server/workflows/versions/service.ts and metadata.ts; server/publication.ts; server/runtime/http.ts and knowledge.ts (DTO projection only, DB-clock assignment unchanged); src/operational/versions.tsx and App.tsx. Regression additions: links-migration.test.ts, versions/publication-integration.test.ts, frontend versions.test.tsx. Updated API/handoff/mistakes/plan plus current capture/evidence.

North Star: repair of derived navigation must preserve already reviewed knowledge identity and answer feedback eligibility. Restoration remains a newly reviewed version with retained current source ceilings. UXC-07 unchanged; EDT-001 whole export roundtrip, KNO-007 precedence and KNO-010 merged-document redirects/reason are cross-feature/unverified by C8. All251 criteria/classifications and C12 operational acceptance tracking remain unchanged. No operating IdP/OS IME/accessibility/load/model-quality assertions.

### Exact RED/GREEN evidence

Same Node24 PATH, localhost synthetic TEST_DATABASE_URL and worktree as the original report. Logs in this report's directory; no timeouts changed or fixture timestamps normalized.

| Command | Log | Result/exit |
| --- | --- | --- |
| node scripts/test-server.mjs server/convenience/links-migration.test.ts | c8-r1-i1-red.log |2failed/2passed, exit1: changed exact version bytes/hash and omitted prior citation |
| same | c8-r1-i1-green.log |4passed, exit0: approved batch/hash unchanged, pending publication succeeds; prior answer remains ranked and actually refiles |
| node scripts/test-server.mjs server/workflows/versions/publication-integration.test.ts | c8-r1-i2-red.log |2failed/8passed, exit1: relative/trusted-absolute content-only preview relations incorrectly empty |
| same | c8-r1-i2-green.log |10passed, exit0: preview/proposal/independent approval/publish and backlinks |
| same after actual reviewer DTO assertion | c8-r1-review-dto-red.log |2failed/8passed, exit1: stored disclosure absent in exact response |
| same after list-only projection attempt | c8-r1-review-dto-green.log |2failed/8passed, exit1 despite filename: exact-detail omission remained |
| same after list+exact projection and target revoke checks | c8-r1-review-dto-green2.log |10passed, exit0 |
| node node_modules/vitest/vitest.mjs run src/operational/versions.test.tsx | c8-r1-ui-red.log |1failed/2passed, exit1: no rendered induced-ID disclosure |
| same | c8-r1-ui-green.log |3passed, exit0 |
| npm run check | c8-r1-final-check.log |494frontend/48Node/16import/41evaluation/251criteria/types/build/static-smoke, exit0; existing chunk warning remains |

Current native command:
```sh
node scripts/test-server.mjs server/convenience/links-migration.test.ts server/convenience/links.test.ts server/convenience/links-http.test.ts server/workflows/versions/publication-integration.test.ts server/workflows/versions/versions.test.ts server/discovery.test.ts server/runtime/runtime.test.ts server/runtime/discovery-clock.test.ts server/convenience/structure-final.test.ts server/convenience/structure-http.test.ts server/workflows/lineage-closure.test.ts server/operations/erasure-db.test.ts server/operations/product-erasure.test.ts server/retention/retention.test.ts
```
c8-r1-final-native.log:14files183passed, exit0, runner-order counts1/4/13/10/2/15/28/18/30/2/12/32/10/6. Includes actual migration upgrade/bounded repair/restart/current-version refusal/schema drift; approved-work/answer preservation; restore and original metadata-only selections; hidden/revoked endpoints/raw sources, final authorization and erasure/legal-hold/retention; original discovery and old exact MCP inventory; C7 configured-origin HTTP/MCP; DB-clock offline/model/asOf assertions. Original discovery.test.ts is unchanged.

Current versus carried: round0 twenty-file302 is prior-head evidence, not current verification or an added total. Eight round0 native files (jobs/runtime52, runtime/durable-mcp1, runtime/model5, service25, workflows/manual-disclosure9, navigation-http1, new-document30, workflows36) were not rerun this round; their159 prior passes are historical, not promoted to current-head passes. New runtime projection does not alter the clock write/replay path; current clock2 and runtime12 cover the directly affected runtime contracts. No combined current-plus-historical count is claimed.

### Fresh current browser, source binding and cleanup

Command: AKH_C8_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-18-internal-links/capture.mjs with the same Node/PG environment. c8-r1-browser.log exit0. Fresh backend2026-11-17T19:28:24.224Z, frontend19:28:35.223Z, capture finished19:29:33.828Z.

Four real Chromium configurations1440x1000/390x844 times light/dark,20PNG. Actual canonical HTTP/PG responses (synthetic actor adapter, no fabricated successful DTOs): explicit duplicate selection/composition/keyboard/focus, saved dependency, draft-no-edges, publication, link removal, author selects only content and explicit merged body, preview shows induced leaf, exact independent reviewer screen shows same ID, UI approve/publish createsv4, stable-ID rename navigation and source revocation. No overflow/page errors. Visually inspected one final restore screenshot per configuration. Synthetic dispatched composition is not OS IME acceptance.

Production fingerprint ba73936b62a1e5384cd2155b43b76c1d944a3aa6a7d0bcdfcde8eb36954b7a8d. Manifest SHA25617dde3a9a523c9d64e2279d09b2eed0a6696da5e287c68de252bec6b880f75a3. Generation and --verify exit0:333production/4harness/8regression/23artifact/56log hashes. Prior source-manifest/browser-results/cleanup preserved in round0/ as historical evidence.

Owned runtime27770/frontend27835 stopped; cleanup assertions exit0 confirm own akh_c8_ DB/profile0, processes absent,4398/5198 closed, parent knowledge_test PG alive. No unrelated cleanup. Root remains clean main...origin/main.

### Self-review and remaining constraints

Checked no existing-version write remains in rebuild; old JSON/hash/envelopes/approved records preserved; current-version/refs guards retained. Checked effective refs before preview return/dependency capture, target version pins and current visibility; exact plan/proposal equality, origin propagation, independent review, optional legacy plan hash compatibility. Traced actual list and exact reviewer DTOs and corrected the initial missing exact projection. Checked author and reviewer UI rendering through actual browser requests and approval/publication. No unresolved known local functional failure remains in requested checks.

Minor existing Vite chunk warning stays deferred; candidate/full-state scan and final projection costs remain unmeasured. Cross-feature export/authority/redirect and C12 operations acceptance are not claimed complete. Controller owns rereview/CI/PR/integration. The original review follows verbatim to preserve precise findings and evidence calibration.

---

### Original task review (verbatim)

## Spec Compliance

- ❌ Issues found: two Important regressions prevent task acceptance: the rebuild changes already published version identities and invalidates dependent work (`server/convenience/links.ts:115`), and shared proposal normalization breaks valid content-only version restoration (`server/publication.ts:308`). UXC-07's main authoring/read behavior is implemented, but the preservation requirements are not fully met.
- ⚠️ Cannot verify full EDT-001 export round trips, KNO-007 authority precedence, or KNO-010 merged-document redirect/reason behavior from this task diff. Their acceptance text remains unchanged in `docs/requirements/requirements.json:837`, `:1789`, and `:1843`; the C8 changes and supplied execution evidence do not establish those whole-product criteria. They must not be marked complete based on C8 alone.
- ⚠️ Browser evidence demonstrates synthetic composition, local HTTP/PostgreSQL and keyboard behavior, not real OS IME, production IdP, assistive technology, load, deployment or semantic/model quality (`docs/ui-validation/2026-11-18-internal-links/capture.mjs:23`, `links-runtime.ts:123`, `README.md:1`). These remain acceptance limitations, not waived criteria.

## Strengths

- Published references retain stable page IDs, labels and explicitly unknown `sourceBlockId:null`; publication inserts the version and replaces derived edges in the same transaction (`server/publication.ts:1181`, `:1209`, `server/convenience/links.ts:33`). Draft storage does not write this index. C9 verified block identity is not fabricated (`src/domain/types.ts:12`).
- Canonical reference checks defeat stale/missing index results; current source/target/ancestor/raw-source permissions and erasure fences are checked, and the read projection is rerun after asynchronous identity refresh (`server/workflows/service.ts:125`, `:717`, `server/convenience/links.ts:136`). The meaningful final-refresh RED→GREEN evidence addresses a real race (`server/convenience/links.test.ts:248`).
- Existing completion, navigation, publication, provenance and discovery services are reused. Explicit same-title selection inserts an ID URL, rechecks the selected target, and preserves portable Markdown; unresolved title text is not resolved speculatively (`src/operational/convenience/LinkAutocomplete.tsx:96`, `src/operational/document-navigation.tsx:391`, `server/convenience/links.test.ts:59`).
- New native tests exercise actual publication/replay, ACL revocation, erasure, stale derived edges, migration/backfill/restart and bounded paging rather than asserting only mock DTOs (`server/convenience/links.test.ts:67`, `:109`, `:145`, `:182`, `:205`, `server/convenience/links-migration.test.ts:8`).

## Issues

### Critical

- None identified in the reviewed task scope.

### Important

1. **Rebuild mutates previously published version data and invalidates unchanged knowledge/work.** `server/convenience/links.ts:115` updates the latest legacy `versions.data` in place whenever `linkReferences` is absent, including writing an empty array for a page with no links. `src/domain/wiki.ts:103` includes the entire current version in `baseSnapshots`; `:388` checks those snapshots during both approval and publication. `server/provenance.ts:120` hashes the whole page, including its versions, into input envelopes; `:146` rejects a changed envelope. Consequently, an otherwise unchanged approved proposal becomes a conflict after index maintenance; merely approving it again cannot repair its old base snapshot. Existing answers also become stale for re-filing (`server/runtime/knowledge.ts:1176`) and are silently excluded from citation rankings (`server/discovery.ts:306`, `:324`). This is a real alteration of a reviewed/published version's hashed identity without a new version, not just disposable-index work. The report's description of possible re-review does not cover these consequences.

   **Focused verification:** one in-memory Node/tsx probe used the actual seed/createBatch/enqueueBatch/decideBatch functions, approved an ordinary proposal, then made only the proposed legacy enrichment (`current(p).linkReferences=[]`). Output: `before:"approved", after:"conflict", pageFingerprintChanged:true`. No database or suite rerun was used. Existing migration tests do not exercise an approved proposal or historical answer around rebuild (`server/convenience/links-migration.test.ts:8`).

   **Calibration:** this does **not** demonstrate approval bypass or corruption of `version_metadata.snapshot_hash`. That immutable metadata snapshot hashes body, relations and selected attribution, not `linkReferences` (`server/workflows/versions/metadata.ts:31`, `:39`). Erasure preview hashes deliberately include current selected rows (`server/operations/erasure.ts:675`), so rejecting a preview changed by rebuild is fail-closed, not an erasure bypass. The concrete defect is destructive invalidation of published-version identity and dependent work/metrics during derived-index maintenance.

   **Fix:** preserve existing version JSON/hash identity during repair. Reconstruct legacy index entries from canonical existing data, or use explicitly derived version-keyed sidecar metadata, while storing structured references in new versions at publication. Do not rewrite old approvals or captured envelopes to hide the change. Add regression coverage proving legacy rebuild preserves approved work and unchanged prior-answer discovery/refiling, plus the existing stale-index/erasure checks.

2. **Automatic link normalization breaks content-only restoration of a linked historical version.** `server/publication.ts:308` now unions parsed Markdown targets into every `Draft.links` before checking a trusted version restore plan. The unchanged guard at `server/publication.ts:354` requires exact equality with `plan.next.relations`. `server/workflows/versions/service.ts:126` starts `next` from current metadata, and `:133` restores only the selected historical body; `:150` sends `links:plan.next.relations`. Reproduction: publish a body containing a relative stable link, publish a subsequent edit removing that link, then select **content-only** restoration of the first version. The valid restore plan keeps current relations `[]`, while new normalization changes the proposal links to `[target]`; proposal creation throws `VALIDATION_FAILED` before review. Previously this exact plan/draft equality held. The current version integration tests cover metadata restoration but not this link-bearing content-only case (`server/workflows/versions/publication-integration.test.ts:29`).

   **Focused verification:** a small actual-parser probe used the restore-shaped content `[Target](/?app=1&space=space&document=target)` and `next.relations=[]`; `internalReferenceIds` plus the new proposal normalization yielded `proposalRelations:["target"]`, `passesExistingPlanEquality:false`. This is a call-site/guard proof, not a claim of an end-to-end database reproduction.

   **Fix:** make restore preview, dependency capture, approved plan and proposal normalization use the same effective relation set before hashing/authorization. Preserve the content/relations selection contract and show any induced relation change in the reviewable preview; do not simply weaken the equality gate. Add a real content-only linked-body restore regression through preview→proposal→approval→publication.

### Minor

- **Existing, nonblocking build warning remains:** `.superpowers/sdd/2026-11-16-essential-convenience/c8-final-check.log:285` reports chunks over 500 kB (629.09/1499.04 kB at `:281`). The report honestly calls this deferred; this review does not attribute those existing chunks to C8 or require unrelated bundling work. It does mean final output was not warning-free.

## Checks and named-risk inspections

- **Scope/read discipline:** reviewed the supplied `review-3b8f310..add8b4a.diff` in passes, including all production/test hunks, documentation, harness, final logs and structured evidence; parsed repetitive historical log outcomes and artifact/manifest data. BASE `3b8f310c4ecc2b8966471c3fe99e3ef8bd461e15`, HEAD `add8b4a3eadb9a506200c612d5beade1f93e4868`. No regenerated git diff, git mutation, product/index edit, helper agent or broad test rerun. No `.codegraph` directory was present in the inspected worktree. Only this review artifact is written under `/private/tmp`.
- **Cut-off hunk completion:** inspected surrounding `WorkflowService.page`, publication approval/publish guards, runtime query write/replay paths and the LinkCompletion insertion promise because their relevant functions were cut off by the supplied hunks (`server/workflows/service.ts:141`, `server/publication.ts:925`, `:1000`, `server/runtime/knowledge.ts:831`, `src/operational/document-navigation.tsx:391`).
- **Named risk — immutable/backfill identity:** checked existing domain base snapshots, input-envelope fingerprints, immutable version metadata, answer refiling and discovery envelope checks (`src/domain/wiki.ts:103`, `:388`, `server/provenance.ts:120`, `:146`, `server/workflows/versions/metadata.ts:31`, `server/runtime/knowledge.ts:1176`, `server/discovery.ts:306`). Findings are precisely bounded in issue 1. Current page relations are not proven to have changed historically by this diff; no unsupported claim of rewritten historical relationship snapshots is made.
- **Named risk — shared proposal contract:** checked the sole relevant version restore construction and exact-plan validation path after the new global normalization (`server/workflows/versions/service.ts:126`, `:150`, `server/publication.ts:354`). Issue 2 follows without widening this into a whole-repository review.
- **Named risk — current ACL/lineage/ancestor ceiling:** checked `visiblePageIds`, `readers` and `requireRead` as dependencies of the new source/target reads. `server/provenance.ts:49` intersects current/historical raw lineage and relation visibility; `server/repository.ts:39` handles ancestor readers, trash, cycles and ancestor raw sources; `server/workflows/service.ts:141` adds current flags and the new tombstone check. Backlinks apply this to both endpoints and recheck the returned page (`:719`, `:746`). No new bypass found in these paths.
- **Named risk — asynchronous identity refresh:** `server/workflows/service.ts:125` revalidates, performs the gated query, revalidates again, then reconstructs read results with fresh membership/session/authorization. Only explicitly read-only navigation/search/backlinks opt into the second projection (`:748`, `:770`, `:805`). The test injects revocation during that second revalidation (`server/convenience/links.test.ts:248`).
- **Pagination/no hidden counts:** backlink items are authorized before page slicing; opaque binding includes actor/workspace/session/credential/target/limit/visible items and current revision. ASCII sorting and continuation use the same order; next cursor exists only for additional visible results (`server/workflows/service.ts:734`, `:741`, `server/convenience/links.test.ts:145`, `:277`). HTTP duplicate/unknown/oversized inputs fail explicitly (`server/convenience/http.ts:145`, `links-http.test.ts:9`). Conservative 10,000-item failure and full-state/digest costs are real documented limits, not tested load capacity.
- **Published-only/no duplicate engine:** version refs/index are written only after approved canonical version insertion (`server/publication.ts:1209`); existing publication replay returns before insertion (`:1009`). Navigation uses canonical refs, and discovery still consumes published `Page.links` (`server/workflows/service.ts:711`, `server/discovery.ts:268`). Draft save has no index write. Removal of old body-derived links is handled by the manual-edit path (`server/workflows/service.ts:537`); no independent citation/privacy/ranking engine was introduced.
- **Stale index/rebuild/concurrency:** `replacePublishedLinks` rejects noncurrent versions and unequal canonical refs before replacing entries (`server/convenience/links.ts:44`). Rebuild uses the same shared erasure/workspace transaction as publication (`:86`; `server/database.ts:93`); read candidates are revalidated against canonical current refs (`server/workflows/service.ts:721`). Migration tests cover outdated repair refusal and missing-index repair (`server/convenience/links-migration.test.ts:61`, `:95`). Their pass does not answer issue 1.
- **Migration144/erasure:** schema adds only ID endpoints/version with PK/FK/index, uses unused 144, and leaves applied SQL unchanged (`server/migrations/144-published-page-links.sql:1`). Test performs transaction rollback, migration reapply, 100+4 bounded backfill, new pool restart, stale-version refusal and schema drift rejection (`links-migration.test.ts:8`, `:113`). This is local PostgreSQL upgrade/restart evidence, not a production rollback/deploy drill.
- **Named risk — omitted product-erasure file:** the brief names `server/operations/product-erasure.ts`, but no cosmetic hunk is needed: `server/convenience/links.ts:44`, `:106` actually call its existing gate/fence helper (`server/operations/product-erasure.ts:44`); `server/operations/erasure.ts:29`, `:50`, `:513` register the table, both target token spellings and physical deletion; `server/retention/inventory.ts:9`, `:65` registers/validates it. The actual erasure test asserts removal and subsequent empty canonical backlink read (`server/convenience/links.test.ts:205`). No functional omission identified from retaining the helper unchanged.
- **Trusted origin/HTTP-MCP parity:** `server/workflows/references.ts:34` accepts only configured origins, excludes code containers and requires local workspace paths (`:61`, `:69`). New document/manual proposal paths pass trusted origin (`server/workflows/new-document.ts:89`, `server/workflows/service.ts:552`); runtime HTTP passes deployment origin (`server/runtime/http.ts:578`). Existing MCP construction uses `structureOrigin` (`server/runtime/mcp.ts:50`), and supplied native execution includes actual existing HTTP/MCP parity tests (`server/convenience/structure-final.test.ts:279`). Host headers are not made trust sources.
- **Safe Markdown/unchanged limitation:** UI continues using existing sanitized Markdown (`src/ui/Markdown.tsx:89`), and completion escapes link label brackets/backslashes (`src/operational/document-navigation.tsx:409`). The server's inherited C7 parser accepts raw HTML anchors while the UI renderer suppresses raw HTML (`server/workflows/references.ts:58`, `src/ui/Markdown.tsx:51`); existing C7 tests explicitly cover that lineage behavior (`server/workflows/lineage-closure.test.ts:113`). Therefore exact equivalence between all server-recognized links and visible rendered anchors is not established; it is not represented here as a newly introduced sanitizer/XSS regression.
- **UI integration/identity:** composer and existing editor retain their autosave handlers and add version pinning (`DocumentComposer.tsx:790`, `workflows.tsx:1126`). Completion uses sequence invalidation and final target lookup; Backlinks keys by personal identity, clears pending results and distinguishes error from authorized-empty (`Backlinks.tsx:19`, `:35`, `:74`; `links.test.tsx:139`, `:191`). Keyboard/IME guards have synthetic tests (`LinkAutocomplete.tsx:53`, `links.test.tsx:73`). Visually inspected final `390-light-suggestions.png` and `1440-dark-backlinks.png`: distinct IDs are visible, controls fit narrow width, published backlink is readable. No claim of real OS IME or screen-reader acceptance.
- **Named risk — DB-clock repair:** assignment is inside the new-answer write closure immediately before persistence; scope/asOf stay separately assigned from the original selection (`server/runtime/knowledge.ts:843`, `:1048`, `:1096`). Durable completed execution returns its stored answer before reaching this code (`:848`), and `commitEffect` returns an existing checkpoint before invoking the write closure (`server/jobs/service.ts:823`). Thus replay and historic records are not retimestamped; both offline/model new writes use DB persistence time. This is appropriate to discovery's DB-clock window (`server/discovery.ts:252`), with existing host-based query selection/asOf semantics unchanged. The actual offline/model five-minute skew tests check persisted/returned time and asOf separately (`server/runtime/discovery-clock.test.ts:12`, `:89`); unchanged original discovery15 passes. No clock-fix defect identified.
- **Evidence inspected, not rerun:** final full check records 493 frontend, 48 Node, 16 import, 41 evaluation, 251 requirement mappings, server types/build/smoke (`c8-final-check.log:20`, `:155`); final native log records 20 files/302 tests in one execution (`c8-final-native.log:1`). Earlier failures are retained rather than counted as current passes. The manifest records 333 production/4 harness/6 regression/15 artifacts/42 logs and fingerprint `c42ec27c1a0794ad068379d7eaf9bdddbae43a875b0af7f3bb5d95c50bd72891` (`docs/ui-validation/2026-11-18-internal-links/source-manifest.json:1`); controller supplied an independent successful `--verify`. Four browser records each include duplicate choice, keyboard, synthetic composition, pinning, draft-no-edges, publication, rename and revocation with empty errors (`browser-results.json:1`, `capture.mjs:23`). These broad passes do not cover the two identified scenarios.

## Assessment

- **Task quality: Needs fixes.** Count: 0 Critical, 2 Important, 1 Minor (pre-existing deferred build warning).
- **Reasoning:** the principal C8 authorization/publication/read flow is well defended and the DB-clock change is narrowly sound, but index backfill must not change existing knowledge identity, and canonical link normalization must remain compatible with reviewed restoration. Both issues need focused regressions before this task is accepted.


### Round1 final-release self-review correction

An actual-PG race assertion reproduced stale disclosure during the final asynchronous identity refresh in both the restore preview and exact reviewer detail. c8-r1-preview-refresh-red.log and c8-r1-detail-refresh-red.log each record2failed/8passed, exit1, using the same publication-integration command. Preview now opts into a second canonical projection after refresh; its transient preview upsert is idempotent. Other VersionService business mutations do not opt in. RuntimeService.changeset re-reads exact detail after refresh. Current source/target denial replaces stale induced-ID DTOs. Cost: an extra authorized preview/detail read (and idempotent preview upsert), not weakened checks or re-executed publication.

Final command after these two source edits:
```sh
node scripts/test-server.mjs server/workflows/versions/publication-integration.test.ts server/workflows/versions/versions.test.ts server/runtime/runtime.test.ts server/convenience/links-migration.test.ts server/discovery.test.ts server/runtime/discovery-clock.test.ts
```
c8-r1-final-release-native.log:6files49passed, exit0 (4/15/2/12/10/6 in runner order). npm run check: c8-r1-final-release-check.log494frontend/48Node/16import/41evaluation/251criteria/types/build/smoke, exit0 with pre-existing chunk warning.

Current-versus-carried supersession: the preceding round1 fourteen-file183 run is before the final-release fix. Its remaining eight files134 (links-http1, links13, structure-final10, structure-http2, erasure-db28, product-erasure18, retention30, lineage32) are explicitly carried, not rerun/current49. Those final two edits affect only restore preview and exact reviewer read release; the affected six were freshly run. No combined183 current execution is claimed. Earlier round0 evidence remains historical.

Final capture is c8-r1-final-browser.log; the prior c8-r1-browser run and its source manifest are intermediate and preserved under round1-before-release/. Current final source/times/cleanup/manifest identities are recorded below.


### Round1 final one-write preview correction (authoritative)

Controller noted that an idempotent INSERT is still a write. Actual PG changed-summary-during-final-refresh regression c8-r1-preview-write-red.log failed1/10passed, exit1: two preview receipts existed. This demonstrates avoidable intermediate persistence, not an authorization bypass; proposeRestoreSelection still recomputed the current plan/hash. The final design removes that intermediate receipt entirely: existing VersionService.run performs only a pure authorized restorePlan projection across identity refresh; afterward one final canonical gated projection inserts the returned receipt exactly once. Generic run is restored unchanged, with no replay flag. Exact reviewer detail remains a read-only re-projection after final refresh. Business writes do not repeat.

The same changed-data test now verifies fresh returned summary, exactly one matching receipt/hash/payload and successful proposal/independent approval/publication. Existing preview/detail final-refresh revocation tests also pass. c8-r1-single-write-native.log (same six-file command in final-release section):6files50passed, exit0, counts4/15/2/12/11/6. c8-r1-single-write-check.log: npm run check,494frontend/48Node/16import/41evaluation/251criteria/types/build/smoke, exit0. Pre-existing bundle warning remains. The preceding8files134 are carried as explicitly described above, not promoted to current50.

The current browser run is c8-r1-single-write-browser.log; earlier c8-r1-browser and c8-r1-final-browser are intermediate. The previous receipt-replay wording is historical and superseded. Current evidence identities/cleanup follow.


### Authoritative final evidence identities and cleanup

Current c8-r1-single-write-browser.log exit0:1440x1000/390x844 times light/dark,20PNG, all actual canonical HTTP/PG assertions passed, no overflow/page errors. Final screenshots visually inspected in all four configurations. Runtime2026-11-17T19:38:51.359Z, frontend19:38:58.940Z, capture complete19:40:07.314Z. Production fingerprint bf630d140e7eb34bd0c6c85d3c6fad82bf5ae58efca7311c4e7e94eff2d61399. Manifest SHA25699eb42cab3192962e0929155f1229a9eee1f94df37de8d5dbed855b401848744; --verify exit0:333production/4harness/8regression/23artifact/69log hashes.

Owned processes30999/31044 absent, own akh_c8_ DB/profile0, ports4398/5198 closed; parent knowledge_test alive. Prior owned29826/29860 were also terminated before the final start; no own DB/profile remained in final assertions. Root clean main...origin/main. Product/docs diff --check exit0; preserved raw tool logs retain original tool whitespace. No push/PR/merge performed by this implementer.

Round1 final implementation commit:7742f70fdf365dc570215d13c5f9808cc8a8048b. Manifest verification repeated after commit and passed333/4/8/23/69 hashes. This report-only commit does not alter product sources or execution evidence.
