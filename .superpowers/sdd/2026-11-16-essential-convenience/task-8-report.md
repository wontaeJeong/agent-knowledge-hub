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
