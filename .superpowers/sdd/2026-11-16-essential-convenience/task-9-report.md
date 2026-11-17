# C9 implementer report — 문서 읽기·목차·부분 공유

Status: DONE (implementation/local verification; independent controller reviews and exact-head CI remain pending; no merge).

Worktree: `/Users/wt.jeong/.codex/worktrees/2fb2/agent-knowledge-hub`
Branch: `feat/convenience-document-reader-20261118`
Base: `79a90cc9c06c476cd270dec2d17ce11faf11e7e3`
Commit/PR: recorded after creation below.

## Binding scope and decisions

Read task-9-brief/constraints first, repository AGENTS/North Star/architecture/UI/security/testing/PR workflow/spec UXC-08 and Global constraints. Applied subagent-driven-development implementer, test-driven-development, systematic-debugging and verification-before-completion. Existing native worktree reused; clean base and branch verified; controller preflight baseline was src494/Node48. No helper/reviewer agents and no root/other worktree edits. Impeccable context permitted narrow refinement of the incumbent Read surface; no PRODUCT.md redesign/interview was invented. The supplied approved brief replaces an interview in this implementer subagent. Craft floor and actual incumbent visual authority used.

- Ruling: reuse DocumentBody by moving its DOM-based safe outline/search implementation into DocumentReader and keeping DocumentBody as its compatibility delegate. Same marked/DOMPurify renderer and image/diagram/math handlers; text-node marks and textContent controls never synthesize unsafe HTML. Rendering decorates canonical top-level token fragments with source ranges. Search/outline 1000 cap; search Enter/Shift+Enter and prior buttons retained; code copy has selectable plaintext fallback on denied API.
- Ruling: use existing version_metadata.anchors only. captureBlockReferences takes a workspace-bound `{client,workspaceId}` DB argument so a pooled connection never implies a workspace; same four planned logical arguments. New publication opts into top-level token boundaries through segmentAnchors, retaining exact-content stable matching and identical-duplicate fail-closed behavior. Default segmentation remains legacy, preserving metadata-free old IDs; existing stored metadata is never rewritten. Final review tightened coarse mapping: only an exact one-to-one rendered range is shareable; old multi-node coarse identities remain stored but are explicitly unavailable in the Reader, never guessed. Changed/deleted/missing/ambiguous anchors report unavailable, while moved unique content keeps its ID. No migration or parallel identity store.
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

Implementation/evidence commit: `4c67586d11738a40ecbe23ddb6c008a9abe95011`.
Draft PR: https://github.com/wontaeJeong/agent-knowledge-hub/pull/75 (open, draft, unmerged; base remains79a90cc).
Final source fingerprint: `41b26860c702219d80d27ef603b884e579d546dfdedd1a43323149aab826dce6`.
Runtime started `2026-11-17T20:51:47.188Z`; frontend started `2026-11-17T20:51:40.386Z`.
Final manifest: **336 production / 3 harness / 4 regression / 18 artifacts / 26 logs**, all SHA-256 verified. Artifact count is16 PNG plus browser/cleanup JSON; the earlier progress count20 was a summation error corrected in MISTAKE_LOG and controller messages.
This metadata-only follow-up records commit/PR evidence; production, tests, harness, logs and artifacts are unchanged. Root checked clean on main. Independent reviews and final-head CI remain controller work; do not treat draft creation as review acceptance.

# Round 1/5 — I1 CR anchor identity and I2 overlapping Clipboard feedback

FIX_BASE: `2199d7082ae79bf1e831091b17a9f629840655a6`. Original task review read in full from `/private/tmp/akh-c9-task-review.md`; preserved as `task-9-review-round1.md`. Applied receiving-code-review and the SDD fix-loop contract; no helpers, controller fixes, root edits or merge.

Status: both reproduced Important findings fixed and locally verified; independent scoped re-review remains pending. Minor1 inherited >500kB chunk warning remains acknowledged/deferred.

## I1 — cause, ruling, compatibility

Confirmed that marked counts standalone CR as newline while the opt-in token segmenter sliced `content.split("\n")`, allowing a real second CR-only paragraph to receive SHA256(empty). An unrelated replacement could keep the stable ID, and actual DocumentReader then mapped it to replacement content. Mixed newline order also produced wrong target movement.

Ruling: only the new token-mode hash source replaces standalone CR (`/\r(?!\n)/g`) with LF before splitting into lines. This gives the same line count/coordinates as marked while retaining the original CR bytes of CRLF inputs. Default legacy segmentation is byte-for-byte unchanged; stored metadata and historical version content are untouched. The bounded tail uses the same corrected line array. This fixes the coordinate mismatch without globally normalizing stored content or changing LF/CRLF hashes. Newline-style-only changes may conservatively lose identity, as before; no guessed jump is introduced.

Covering tests:
- `src/operational/convenience/reader.test.tsx`: CR, mixed, LF, CRLF actual Reader mapping across moved/changed/deleted blocks and fixed-old restoration; exact two-block CR replacement reproduction must show unavailable and have no DOM node bearing the original ID.
- `server/convenience/anchors.test.ts`: actual approved publication capture for the same four newline formats, preserved IDs only for moved original content, changed/deleted unresolved, SHA256(empty) forbidden for the real original paragraph, immutable historical body/anchors. Golden pre-fix legacy CRLF IDs/hash values plus original CR coarse single-block fallback preserve compatibility.

## I2 — cause and fix

Confirmed two copy operations in the same document shared only the document-generation check. A pending latest-link copy could resolve after a newer fixed-link rejection and replace its error/textarea with false success.

Ruling: each copy increments a `copySequence`, clears old feedback immediately, and writes result only when both its document generation and copy sequence are current. Existing document switch/unmount generation remains. Tests hold first/latest promise, reject second/fixed, then resolve first: the exact failed fixed URL and error stay visible, with no success message. Further tests assert new-request feedback clearing and that a pending completion cannot cross document switch or unmount.

## RED → GREEN and failure accounting

Commands used Node24.22.2 via the same supplied PATH and loopback test database as the initial report.

1. `vitest run src/operational/convenience/reader.test.tsx` → `c9-r1-reader-red.log`: **4 failed/9 passed** (before exact two-block case added). `node scripts/test-server.mjs server/convenience/anchors.test.ts` → `c9-r1-native-red.log`: **4 failed/9 passed**; two CR/mixed product failures plus two LF/CRLF fixture-control failures.
2. Investigated control failures: existing edit schema trims trailing whitespace, so moving a paragraph to the final position removed its delimiter. Added a fixed terminal heading so all compared blocks remain internal with unchanged delimiters; historical byte assertion now observes exact accepted content. No product change had been made. Added exact reviewer two-block reproduction.
3. Same RED commands → `c9-r1-reader-red-controls.log`: **5 failed/9 passed**; `c9-r1-native-red-controls.log`: **2 failed/11 passed**. Only CR/mixed and copy defects fail; LF/CRLF and legacy golden controls pass. These are the clean before-fix baselines.
4. Implemented only two production files (`server/workflows/versions/diff.ts`, `src/operational/convenience/DocumentReader.tsx`). `vitest run src/operational/convenience/reader.test.tsx src/operational/document-navigation.test.tsx src/ui/Markdown.test.tsx` → `c9-r1-reader-green.log`: **3 files/28 passed**. `node scripts/test-server.mjs server/convenience/anchors.test.ts server/workflows/versions/versions.test.ts` → `c9-r1-native-green.log`: **2 files/19 passed**.
5. `npm run check` → `c9-r1-check.log`, exit0: **71 src files/508 tests + Node48 + imports16 + evaluation41 +251 criteria + server types + build + static HTTP smoke**. Inherited chunk warning retained.
6. `node scripts/test-server.mjs server/convenience/anchors.test.ts server/convenience/links.test.ts server/convenience/links-http.test.ts server/convenience/structure.test.ts server/convenience/structure-final.test.ts server/convenience/structure-http.test.ts server/workflows/versions/versions.test.ts server/workflows/versions/publication-integration.test.ts server/workflows/versions/visit-http.test.ts server/workflows/lineage-closure.test.ts server/workflows/navigation-http.test.ts server/runtime/versions-host.test.ts server/runtime/search-mcp.test.ts server/agents/mcp.test.ts server/operations/links-erasure.test.ts` → `c9-r1-native-final.log`, exit0: **15 files/120 tests** (anchor13, all other prior file counts unchanged). Not a full-server-suite claim.

## Fresh browser and cleanup

Started a new owned runtime/database and frontend after the production fix; used the same exact runtime/frontend/capture commands listed earlier, logs `c9-r1-runtime.log`, `c9-r1-frontend.log`, `c9-r1-browser.log`. Harness-only changes use distinct idempotency keys for distinct added publication requests.

Chromium158.0.8127.18, 1440×1000/390×844 × light/dark: all four passed with errors[]. Existing 16 screenshot states were recaptured, plus 8 new captures = **24 PNG**. New assertions execute actual HTTP approval/publication of CR-only v4 → mixed moved v5 → replacement v6 → deleted v7, verify exact current focus, missing-location/no misdirection and frozen v4 original position. New controlled Clipboard promises simulate older latest success after fixed-copy failure, preserving the failed URL and no success. Screenshot `390-dark-copy-race.png` and `1440-light-newline-unavailable.png` visually inspected.

These are canonical HTTP/PG paths with synthetic identities and controlled browser Clipboard promises, not OS Clipboard/company IdP/full accessibility/real device acceptance. Old and new provenance/source/ancestor/erasure checks remain; North Star and251 criteria unchanged. Current unknown review/official metadata and bundle warning limitations remain.

Owned runtime/frontend commands verified by PID then terminated. `cleanup.json` records round1 own DB/profile0,4399/5199closed,parent knowledge_test alive. Previous16PNG and old source manifest remain immutable in FIX_BASE; top-level current24PNG all match the new source fingerprint. No pending product changes during packaging; scoped review/CI are controller work.

Round1 production fingerprint: `a88bf15d089d600138896abec34ce5d2215744c0901e54702e8b5c9f10a7a07a`; runtime `2026-11-17T21:10:12.347Z`; frontend `2026-11-17T21:10:13.089Z`; capture finished `2026-11-17T21:11:28.840Z`.

Round1 fix/evidence commit: `02b020b30c2aa52b885380d9e06576b527b16cdf` (pushed to the same draft PR75).

Packaging correction: the initial `git diff --cached --check` detected raw test-output trailing whitespace and blank EOF lines, but the shell did not stop before commit. This is a failed packaging check, not a test failure or passed gate. The exact original stdout bytes are preserved in the fix commit above. The following evidence-only commit trims trailing whitespace/blank EOF in `c9-r1-*.log` text views, without removing any test/failure/output line; regenerates their manifest hashes; records this mistake; and uses `set -e` for verification/commit/push. Production, test sources, harness and PNG/JSON artifacts remain unchanged. No browser recapture is necessary for log whitespace normalization.

Round1 final source fingerprint is `a88bf15d089d600138896abec34ce5d2215744c0901e54702e8b5c9f10a7a07a`. Manifest inventory: **336 production/3 harness/4 regressions/26 artifacts (24PNG+2JSON)/38 logs**. Final evidence-only commit and tracked-path/diff gate result are returned to controller for scoped review. Original finding verdict acceptance remains the independent reviewer's responsibility.


## Combined final review wave — authoritative after FIX_BASE 4615153

Full review was read verbatim and is preserved in `task-9-final-review.md` with trailing-whitespace-only normalization. Scope is its three Important findings; no helpers, merge, server schema, stored metadata, approval or historical-version rewrite. Same UXC-08 / EDT-001/010 / SHR-001~003 / UX-005/006 and all251 criteria. The prior Round1 fixes remain intact. Current code improves authorized reading and precise reuse; semantic quality, agent performance and production acceptance remain unevaluated North Star targets.

### Changes and writer audit

- I1: `WorkflowPanel` initial/exact-draft admission, background focus/60s read, manual `refreshDocument` (expiry/settings/protection/state/comment callers), and `DocumentStructureControls.onChanged` now commit detail/comments only through one read epoch plus the same API/identity/selection token and mounted check. Current401/403/404 invalidates the epoch, admission readiness and safe Reader state before clearing protected data. Async action error/reload checks its selection; unmount invalidates. The admitted-detail selection is checked during render, so an identity switch cannot paint the prior body before passive effects. Initial exact-draft admission remains separate from background refresh and cannot be canceled by focus before admission. No mutation is replayed.
- I2: the existing safe renderer excludes trailing blank token separators from visible source ranges. `blockForElement` requires exact range equality, a single stable metadata candidate and one overlapping rendered wrapper. Same-line and adjacent display-math ambiguities, duplicates and old coarse multi-node spans explicitly refuse sharing; a supplied old/ambiguous anchor reports unavailable. Separated math with a one-to-one range still copies/reopens its exact latest/fixed target. The server segmenter, legacy fallback hashes, stored version bytes and metadata are unchanged in this final wave.
- I3: a parent-owned `ReadingSession` retains only query, numeric match/heading/scroll/input-selection coordinates, selected block ID and whether the initial anchor was already visited. Revalidation still synchronously removes protected Reader DOM. The same authorized API/identity/space/document/version restores interaction state; denial or scope/version change discards it. Copy fallback text/URLs/results and pending Clipboard completions are never retained. Explicit outside focus wins. An unchanged refresh does not refocus the route anchor. StrictMode replay can rebuild marks without losing restored focus; an unchanged stable wrapper's tabindex is retained because Chromium blurs a focused wrapper when it is removed.

### Real RED / GREEN and mistakes

- Executed both supplied reviewer Node24 scripts against FIX_BASE behavior before changes: manual late success re-exposed the protected paragraph; math copied/reopened the first wrapper; same-snapshot timer cleared query/focus. Their original observations and exact commands are in the saved review.
- Initial `c9-final-red.log`:13fail/4pass. Two scope fixtures initially resolved the newly overwritten resolver instead of the old response, and the document-select test found BulkEditor's first select. Corrected to capture the old promise and choose the document selector; these errors were not product failures. A broad text replacement also accidentally used an undefined `finish` in an intermediate fixture; corrected without changing intended assertions.
- `c9-final-confirmed-red.log`: temporarily loaded the five unchanged FIX_BASE production files, ran the corrected22 regressions, then restored every working byte in a Python finally block: **17failed/5passed**. No alternate checkout/branch was edited. Additional boundary tests then found independent space-key and pre-passive identity exposure: `c9-final-boundary-red.log` **2failed/22passed**.
- An overly broad initial-anchor guard edit also applied to explicit match/TOC navigation. Existing search test and actual browser caught this. Search was corrected first; real repeated-TOC click got a dedicated `c9-final-toc-red.log` **1failed** before the explicit-click correction. No test was removed.
- Browser `c9-final-browser.log`/`-diagnostic.log`: initial anchor focus timeout. Actual Chromium removed focus when decoration removed/reapplied tabindex; jsdom StrictMode characterization passed and is explicitly not RED (`c9-final-strict-probe.log`). The exact attributes are now retained for unchanged targets. Browser `-2.log`: explicit TOC guard error above. Browser `-release.log`: second periodic mark focus lost during StrictMode search-decoration replay; strengthened real Snapshot timer tests in StrictMode produced `c9-final-strict-refresh-red.log` **2failed**, then retained restoration coordinates through replay.
- Browser `-verified.log` passed periodic search/input-selection/match focus and math latest/fixed round trips, then the harness could not click a lifecycle control inside its closed details. `/me`/render probe confirmed actual Maintain/lifecycle.manage; the harness now opens the real summary, with no role/ACL bypass. This is a fixture interaction failure, not product authorization failure. Both current document and comment denial responses are held for the opposite-order race.
- All intermediate red/green/check/browser logs remain evidence of those stages. Final log presentation removes only trailing line/EOF whitespace before hashing; results are unchanged. No failed attempt is represented as final success.

### Final verification commands and boundaries

All commands ran in this isolated branch with Node24 directory `/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin` first in PATH. Every existing test/criterion remains. The final browser-only corrections changed frontend files; affected PostgreSQL results below remain from the unchanged server bytes and are not falsely counted as rerun after each frontend correction.

- `node node_modules/vitest/vitest.mjs run src/operational/convenience/reader-revalidation.test.tsx src/operational/workflows-reader.test.tsx src/operational/convenience/reader.test.tsx src/operational/convenience/composer.test.tsx src/operational/document-navigation.test.tsx src/ui/Markdown.test.tsx` → **6files/72passed**, exit0, `c9-final-green-verified.log`. Covers actual manual/structure handlers in both completion orders, principal/space/selection/unmount and pre-paint identity, exact-draft admission and unsent editor, latest/fixed timer search/selection/match focus, external focus, denial/scope/version state disposal, code fallback disposal, math actual copy/codec/remount, coarse failure and existing CR/copy/security tests.
- `npm run check` → **73frontend files/534tests +48Node +16imports +41evaluation +251requirements +server types +build +static HTTP smoke**, exit0, `c9-final-check-verified.log`. Prior `c9-final-check.log`, `-browser-fix.log`, `-release.log` are intermediate source evidence. Existing >500kB bundle warning remains.
- `TEST_DATABASE_URL=<provided loopback synthetic parent> node scripts/test-server.mjs server/convenience/anchors.test.ts server/convenience/links.test.ts server/convenience/links-http.test.ts server/convenience/structure.test.ts server/convenience/structure-final.test.ts server/convenience/structure-http.test.ts server/workflows/versions/versions.test.ts server/workflows/versions/publication-integration.test.ts server/workflows/versions/visit-http.test.ts server/workflows/lineage-closure.test.ts server/workflows/navigation-http.test.ts server/runtime/versions-host.test.ts server/runtime/search-mcp.test.ts server/agents/mcp.test.ts server/operations/links-erasure.test.ts` → **15files/120passed**, exit0, `c9-final-native.log`. Actual disposable PG: anchors13, links13, linksHTTP1, structure20, structure-final10, structureHTTP2, versions6, publication11, visitHTTP1, lineage32, navigationHTTP1, versions-host5, searchMCP1, agentMCP1, erasure3. This is focused affected coverage, not every server suite.
- The supplied unchanged workflow probe was rerun on fixes: `node --import tsx /private/tmp/akh-c9-workflow-race-probe.mjs` → `c9-final-reviewer-race-green.log`, both after-denial and after-late-success body=false. Its controlled client responses are distinct from the real PG/browser evidence.
- Final actual browser/cleanup/manifest result is recorded below after completion. Synthetic identities/HTTP ACL fixture, controlled Clipboard responses and accelerated browser clock do not certify company IdP, OS Clipboard, physical-device IME, full accessibility, deployment/load/backup or semantic knowledge quality.


### Final browser, cleanup and package result

`AKH_C9_SYNTHETIC_CAPTURE=1 TEST_DATABASE_URL=<provided synthetic parent> PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-18-document-reader/capture.mjs` → `c9-final-browser-complete.log`, **exit0: Chromium158.0.8127.18,1440×1000/390×844 ×light/dark,412 actual API requests per case,errors[]**,40 fresh PNG. All current PNG belong to production fingerprint `c3887659bfeaeb3327ed73990be8fac28998c0ab1e372050619914c1b342f15f`; runtime/frontend start precedes capture and matches the fingerprint. The final harness only added disclosure opening/response gates after the final production checks; no production source changed afterward.

Real browser verified automatic60s callback with Playwright's accelerated browser clock (not60seconds of wall waiting), protected DOM absent while canonical response held, restored input query/selection and active second mark without refocusing initial anchor, distinct repeated-heading explicit navigation, existing CR/copy regressions, ambiguous same-line/adjacent math refusal and separated math latest/fixed copy→HTTP revisit. Final race used the actual expiry-save button/POST/manual GET and actual PostgreSQL source-reader removal; held both document/comment denial responses and exercised denial-first and older-success-first completion. No fabricated API bodies. Own synthetic maintain/editor roles are not company authentication certification.

Visually inspected four current PNG across all configs:390-dark-reading-restored (visible2/4 query and focused mark),1440-light-math-unavailable (explicit unavailable text and only exact math target share),390-light-revocation-manual-first (permission error and no protected body),1440-dark-copy-race (newer failed fixed-copy fallback remains). Other PNG are supported by execution assertions rather than a claim of separately inspecting all40.

Cleanup stopped only identified own listeners. All owned `akh_c9_test_ui_*` DBs/profiles absent;4399/5199 closed; parent `knowledge_test` query alive=1. No root/other-worktree mutation; root observed clean main. New text logs/report normalize only line-end/EOF whitespace before manifest hashing; old evidence remains in prior commits. Final feature commit/PR metadata is recorded after commit below; independent scoped review and exact-head CI remain controller-owned. No merge.

Packaging note: the first fail-fast staging command refused the ignored `.superpowers` path before commit. Retried only the explicit task report/review/log files with `git add -f`, preserving the ignore policy and rerunning staged/manifest checks.
