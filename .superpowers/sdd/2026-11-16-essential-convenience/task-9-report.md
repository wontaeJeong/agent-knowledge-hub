# C9 implementer report — 문서 읽기·목차·부분 공유

Status: DONE (implementation/local verification; independent controller reviews and exact-head CI remain pending; no merge).

Worktree: `/Users/wt.jeong/.codex/worktrees/2fb2/agent-knowledge-hub`
Branch: `feat/convenience-document-reader-20261118`
Base: `79a90cc9c06c476cd270dec2d17ce11faf11e7e3`
Commit/PR: recorded after creation below.

## Binding scope and decisions

Read task-9-brief/constraints first, repository AGENTS/North Star/architecture/UI/security/testing/PR workflow/spec UXC-08 and Global constraints. Applied subagent-driven-development implementer, test-driven-development, systematic-debugging and verification-before-completion. Existing native worktree reused; clean base and branch verified; controller preflight baseline was src494/Node48. No helper/reviewer agents and no root/other worktree edits. Impeccable context permitted narrow refinement of the incumbent Read surface; no PRODUCT.md redesign/interview was invented. The supplied approved brief replaces an interview in this implementer subagent. Craft floor and actual incumbent visual authority used.

- Ruling: reuse DocumentBody by moving its DOM-based safe outline/search implementation into DocumentReader and keeping DocumentBody as its compatibility delegate. Same marked/DOMPurify renderer and image/diagram/math handlers; text-node marks and textContent controls never synthesize unsafe HTML. Rendering decorates canonical top-level token fragments with source ranges. Search/outline 1000 cap; search Enter/Shift+Enter and prior buttons retained; code copy has selectable plaintext fallback on denied API.
- Ruling: use existing version_metadata.anchors only. captureBlockReferences takes a workspace-bound `{client,workspaceId}` DB argument so a pooled connection never implies a workspace; same four planned logical arguments. New publication opts into top-level token boundaries through segmentAnchors, retaining exact-content stable matching and identical-duplicate fail-closed behavior. Default segmentation remains legacy, preserving metadata-free old IDs; existing stored metadata is never rewritten. Old coarse blocks navigate only their first precise visible position, never invented child IDs. Changed/deleted/missing/ambiguous anchors report unavailable, while moved unique content keeps its ID. No migration or parallel identity store.
- Ruling: C1 route codec already validates version/anchor/login return and legacy comment/share exclusion, so use it unchanged instead of editing it for the file list. Snapshot current/fixed routes and Workflow current rendering consume existing authorized reads; new `/versions/pages/{id}/latest` delegates to the same VersionService transaction and policy. Current title is used only for latest; fixed reads keep frozen/unknown historical title. Focus/60s revalidation clears protected content, rejects late responses; readyDocument guard does not change editor selection or interrupt an initial exact-draft admission. `visit=0` prevents background Workflow revalidation from changing recent visits; old no-query behavior remains.
- Ruling: current/fixed publication status, publication time, review time and official status are independent. Review/official data absent from this DTO is explicitly 미확인 rather than inferred from publication. This is a data availability limitation, not a claim of formal verification.
- Ruling approved by controller: raw HTML is hidden by canonical Markdown but old server extraction inferred hidden `<a>` relations. New extraction now applies html:()=>'' while retaining trusted deployment Origin/query/entity/absolute/network boundaries. Stored linkReferences/Page.links/provenance/approvals/history stay immutable. Existing raw-HTML security fixture cases now include visible Markdown to the same target and preserve every source/target/audience/restore assertion; separate tests assert HTML exclusion. Actual legacy explicit relation regression publishes frozen refs, checks byte preservation, exact origin-pin transitive copy authority and denial of copy/replay/fixed/read/restore after target revocation. No test criterion removed.

North Star: improves authorized human Query/inspection/version-and-position reuse; does not automatically change knowledge, infer source truth, bypass review, widen ACL or claim knowledge/agent performance improvement. UXC-08 maps EDT-001/010, SHR-001~003, UX-005/006. All 251 original criteria remain unchanged.

## TDD and failures (logs preserved)

1. `c9-reader-red.log`: missing new module, no tests collected (scaffold gap, not an assertion pass).
2. `c9-reader-red-assertions.log`: stub helpers and existing DocumentBody delegate, **4 failed / 1 passed**: Korean outline, rendered bounded search, code-copy fallback, missing/ambiguous anchor. Implementation then `c9-reader-green-initial.log`: **3 files / 19 passed** including old navigation and Markdown.
3. `c9-anchors-red.log`: native PostgreSQL **2 failed / 2 passed**: adjacent heading/paragraph single coarse block and invisible raw HTML references. `c9-anchors-green.log`: **2 files / 10 passed** (new anchors4 plus existing version6).
4. `c9-lineage.log`: new legacy fixture failed at `INSERT INTO pages VALUES` because schema has added columns; fixed explicit columns. Existing lineage32 and HTTP1 passed. `c9-legacy-green.log`: fixture expected target directly in dependencyVersions but canonical duplicate retains exact origin pin; verified implementation and corrected fixture to actual `{topic:2}` contract plus explicit target revocation across copy/read/restore. `c9-legacy-green-2.log`: anchors6 pass. No unsafe product workaround.
5. `c9-check-first.log`: src501/Node48/import16/evaluation41/251 passed, then server TS implicit-any in new test callback failed. Added explicit type; later full checks passed. One extra activity-table name assumption was corrected against activity.ts before executing that test. Initial stale file-name probes and a sandbox-denied non-escalated ps read were harmless discovery failures; actual paths/process commands were verified before proceeding.
6. `c9-browser-first.log`: first four-condition capture passed. Subsequent self-review improvements changed production bytes, so restarted own runtime/frontend and recaptured all PNGs against final fingerprint; do not present earlier capture as final evidence.
7. `c9-check-final-source.log`: final production source full check exit0. Test-only latest/current-title assertions were strengthened afterward: `c9-focused-final-source.log` **4 files / 58 passed**, then `c9-check-packaging.log` full check exit0 on the final test sources.

## Final verification commands and exact results

All commands ran in the isolated worktree, Node `24.22.2` via `PATH=/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH`. Native tests use the supplied loopback PostgreSQL17 TEST_DATABASE_URL only; repository runner creates and drops a disposable database per file, never migrates/drops parent knowledge_test.

- `npm run check` → `c9-check-packaging.log`: **71 frontend files / 501 tests**, **48 Node**, **16 imports**, **41 evaluation**, all **251 requirements**, server TypeScript, TypeScript/Vite build and static HTTP smoke pass (exit0). Existing >500kB Mermaid/ELK bundle warning remains.
- `vitest run src/operational/convenience/reader.test.tsx src/operational/convenience/search.test.tsx src/operational/document-navigation.test.tsx src/operational/versions.test.tsx` → `c9-focused-final-source.log`: **4 files / 58 pass**. Includes latest vs pinned URL/login, code/table/Korean search, repeat headings/XSS, missing/ambiguous target, Clipboard denied exact URL/code fallback, revoked current reads and late-response discard, fixed metadata/current-title distinction, old search/navigation/version behavior.
- `node scripts/test-server.mjs` with the following exact 15 filters → `c9-native-release.log`: **15 files / 115 pass, exit0**. This is focused native coverage, not all server files:
  - `server/convenience/anchors.test.ts` 8
  - `server/convenience/links.test.ts` 13
  - `server/convenience/links-http.test.ts` 1
  - `server/convenience/structure.test.ts` 20
  - `server/convenience/structure-final.test.ts` 10
  - `server/convenience/structure-http.test.ts` 2
  - `server/workflows/versions/versions.test.ts` 6
  - `server/workflows/versions/publication-integration.test.ts` 11
  - `server/workflows/versions/visit-http.test.ts` 1
  - `server/workflows/lineage-closure.test.ts` 32
  - `server/workflows/navigation-http.test.ts` 1
  - `server/runtime/versions-host.test.ts` 5
  - `server/runtime/search-mcp.test.ts` 1
  - `server/agents/mcp.test.ts` 1
  - `server/operations/links-erasure.test.ts` 3
- These cover publication immutability, moved/changed/deleted/duplicate block matching, legacy fallback IDs, old relation origin pin/copy/restore/approval authority, target/source/ancestor and current permission checks in existing suites, actual source erasure blocking latest/fixed snapshots, HTTP and issued MCP transports, existing share/version/comment semantics, no-visit refresh, transaction fences and trusted origins.
- `git diff --check` passed. UI manifest verification is recorded after final packaging below.

## Actual browser evidence

`docs/ui-validation/2026-11-18-document-reader/` contains harness, PNG16, browser-results, cleanup and source manifest. `reader-runtime.ts` uses an explicit synthetic actor adapter with actual createRuntimeHandler/Workflow/Version/PG services, actual independent reviewer approval/publication and current ACL revocation; no fake UI response bodies.

Commands: `AKH_C9_SYNTHETIC_CAPTURE=1 TEST_DATABASE_URL=<supplied loopback test> tsx docs/ui-validation/2026-11-18-document-reader/reader-runtime.ts`; `node .../manifest.mjs --frontend-start`; `vite --host 127.0.0.1 --port 5199 --strictPort`; `AKH_C9_SYNTHETIC_CAPTURE=1 TEST_DATABASE_URL=<same parent> PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node .../capture.mjs`.

Final `c9-browser-final-source.log`: Chromium **158.0.8127.18**, **1440×1000 / 390×844 × light/dark**, all four pass. Exact block focus, distinct repeated Korean TOC headings by keyboard, Korean4 matches Enter/Shift+Enter, source code escaping/no script, denied Clipboard selected fallback/no false success, exact latest vs fixed URLs, new publication removing latest target with no silent jump, fixed old target still correct, raw source revocation clears both historical reader and current Workflow body, no horizontal overflow, pageErrors[] each. Actual 390-light final and prior desktop/dark screenshots visually inspected. No OS IME/physical device/full assistive-technology claim.

Cleanup: only own processes on4399/5199 were verified and terminated; runtime dropped its own DB. cleanup.json confirms own DBs0, profiles0, both ports closed and parent `knowledge_test` alive. Parent PG and root/other worktrees unchanged.

## Limitations and remaining controller work

- No semantic LLM quality, company IdP, production release, load/restore/real-user acceptance, full accessibility or real-device/OS IME evidence. These are synthetic safety/usability regressions.
- Identical duplicate content and bounded tails cannot offer stable partial sharing. Unsupported/legacy coarse subpositions have no fabricated ID; users can use a whole/fixed document link. New block boundaries can make a formerly coarse latest location unavailable, which is explicit and preserves old fixed metadata.
- Review time/official document designation lack independently confirmed DTO values and remain 미확인. Publication time is not substituted as review time.
- Search cap1000 and block cap1000 are visible/bounded. Existing big-bundle warning remains.
- Controller owns independent task review + whole-branch review and exact-head CI; draft PR only, never merged here.

## Packaging

Manifest verification before commit: **336 production / 3 harness / 4 regression / 18 artifacts (16 PNG + 2 JSON)** hashes verified. Execution logs are included; final count updated during packaging. Final commit/PR metadata follows. No production code will change during packaging; source manifest binds exact final production bytes to runtime/frontend starts and browser results.
