# Spec compliance: issues found — C9 needs fixes

Reviewed base `79a90cc9c06c476cd270dec2d17ce11faf11e7e3` to head `2199d7082ae79bf1e831091b17a9f629840655a6` in `/Users/wt.jeong/.codex/worktrees/2fb2/agent-knowledge-hub`.

**Task quality: Needs fixes. Critical 0 / Important 2 / Minor 1 (inherited build warning).** The two Important findings violate UXC-08's no-silent-misdirection and no-false-copy-success contracts. No requirement criterion was removed from the requirements files.

## Strengths and scope checks

- The existing DocumentBody delegates to DocumentReader (`src/operational/document-navigation.tsx:18`), retaining the canonical marked/DOMPurify renderer rather than introducing an unsafe search renderer. Search marks and controls use DOM nodes/textContent (`src/operational/convenience/DocumentReader.tsx:157`). The sanitizer remains at `src/ui/Markdown.tsx:107`; raw HTML still emits no nodes.
- Publication uses the existing version-metadata store, with the existing current-transaction/new-version guard and INSERT-only capture (`server/workflows/versions/metadata.ts:40`, `:46`, `:48`). `captureBlockReferences` scopes its preceding-metadata query by workspace/page/version (`server/convenience/anchors.ts:14`). The new token mode is opt-in, while legacy fallback remains the old default (`server/workflows/versions/diff.ts:5`, `:15`). Ordinary identical duplicate blocks remain unstable; repeated headings retain separate TOC entries. New tests assert moved IDs, changed/deleted refusal, and immutable historical bodies/anchors (`server/convenience/anchors.test.ts:49`, `:106`).
- Latest reads delegate through the same VersionService transaction/session revalidation and version authorization (`server/workflows/versions/service.ts:44`, `:47`, `:55`, `:62`). Fixed/latest source erasure and source revocation have actual PostgreSQL regression assertions (`server/convenience/anchors.test.ts:92`, `:182`, `:201`). This is not an independent audit of the entire unchanged ACL engine.
- Snapshot revalidation clears protected content and rejects older responses by request generation (`src/operational/convenience/DocumentSnapshot.tsx:48`, `:60`). Workflow refresh uses the selection identity plus its own request sequence and `visit=0` (`src/operational/workflows.tsx:838`). The HTTP option is parsed, and default workflow visit behavior remains (`server/workflows/http.ts:43`, `server/workflows/service.ts:687`). No new MCP mutation or bypass route was introduced.
- New raw-HTML inference exclusion (`server/workflows/references.ts:58`) matches the visible renderer's HTML policy. The C7 fixture changes retain the original target/source/audience assertions while adding visible Markdown beside HTML (`server/workflows/lineage-closure.test.ts:111`, `:364`; `server/workflows/navigation-http.test.ts:153`). Explicit old Page.links/version references remain represented in the new regression, including byte equality, exact-origin duplicate pin, denial on target revocation, and restore-preview/proposal denial (`server/convenience/anchors.test.ts:114`). These changes are justified compatibility/security tests, not evidence of deleted acceptance criteria.
- Plan file-list discrepancy: `server/publication.ts`, `src/operational/convenience/route.ts`, and `src/operational/api.ts` have no diff hunks. This is not a missing implementation finding: the existing publication hook at `server/publication.ts:1238` calls the modified metadata authority; the existing route codec validates/preserves version and anchor and excludes comment/share hash combinations (`route.ts:40`, `:66`, `:72`, `:169`); login return uses that codec (`api.ts:12`, `:23`). The new reader test checks latest/fixed round trips. The responsible implementations were reused rather than duplicated.

## Important 1 — CR line endings let a latest link silently identify replacement content

**Location:** `server/workflows/versions/diff.ts:6–13`, especially line 13. Reader mapping: `src/ui/Markdown.tsx:91–103`, `src/operational/convenience/document-reader.ts:49`, `DocumentReader.tsx:123`.

`marked.lexer` normalizes standalone carriage returns into newlines. The new token branch counts those normalized lines but hashes slices from `content.split("\n")`, which has not normalized CR. This can hash an empty slice for a real rendered paragraph. An empty hash that appears once is declared stable and reused on the next publication even when that paragraph has completely different content.

Focused reproduction, executed against the actual module with `node --import tsx --input-type=module`:

```js
import { segmentAnchors, resolveAnchor } from './server/workflows/versions/diff.ts';
const old = segmentAnchors('doc', 2, '# Heading\r\rOriginal paragraph', [], true).anchors;
const next = segmentAnchors('doc', 3, '# Heading\r\rUnrelated replacement', old, true).anchors;
console.log(old[1], next[1], resolveAnchor(old[1], next));
```

Actual: both second blocks have SHA-256(empty) `e3b0c442...b855`, `stable:true`, and ID `a-a61596a9ad43a599c881e35507d7b0c2`; resolution returns `resolved:true,status:'unchanged'`. The actual `renderMarkdown` under jsdom emits `<div data-document-start="3" data-document-end="3"><p>Unrelated replacement</p>...` for the new body. `blockForElement` therefore maps the retained ID to the replacement, and an old latest URL jumps there without the missing-location warning. This is not merely loss of a sharing opportunity. The accepted edit text schema (`server/workflows/service.ts:60`, `:488`) does not forbid standalone CR.

Control: the same changed-body reproduction with LF and CRLF gives different old/new paragraph IDs. Legacy CR fallback creates one coarse block, whereas new CR token mode creates two. Existing legacy metadata must remain immutable, and an indiscriminate global normalization would also change existing CRLF hashes/fallback identities.

**Fix:** use consistent source coordinates/hash input in the new token mode, or explicitly fail closed for unsupported newline mapping. Preserve old stored metadata and legacy fallback semantics, including CRLF. Add CR-only and mixed CR/LF changed/moved/deleted regressions covering both capture and actual reader target mapping. Do not rewrite historical content to repair this.

## Important 2 — an earlier Clipboard success overwrites a later failed copy

**Location:** `src/operational/convenience/DocumentReader.tsx:48–62`.

`copy()` captures only the document-generation counter. It does not give individual copy operations a sequence, clear the prior result at request start, or prevent overlapping copy requests. An older successful request can overwrite the error/fallback of the newer request on the same document.

Focused reproduction used the actual DocumentReader mounted through React/createRoot in jsdom, with the CSS import stubbed and two Clipboard promises:

1. Click `최신 문서 링크 복사`; keep its `writeText` promise pending.
2. Click `v2 고정 링크 복사`; reject its promise.
3. Observe the failure text and selectable `https://wiki.example/?app=1&space=space&document=doc&version=2` fallback.
4. Resolve the first promise.

Actual final result: `복사했습니다.` is displayed and the textarea disappears, although the most recently requested fixed URL was not copied. The existing denied-copy test covers one request only (`src/operational/convenience/reader.test.tsx:189`).

**Fix:** add a per-copy request sequence (in addition to the document/unmount generation), clear stale feedback when initiating a new copy, and commit success/fallback only for the current operation; alternatively serialize/disable copy operations. Add this out-of-order success/rejection regression. This directly violates the specified failure-feedback contract.

## Minor 1 — inherited build warning remains visible

`.superpowers/sdd/2026-11-16-essential-convenience/c9-check-packaging.log:285` contains the >500 kB chunk warning. This is acknowledged in the implementation report and not newly attributed to C9. Treat it as nonblocking existing output noise, not a pristine build claim; address separately if the project requires warning-free verification.

## Evidence assessment and limitations

- Read the supplied diff in bounded production/test/harness/documentation/evidence passes. Initial fallback git diff/stat output was truncated before the supplied package path was clarified; bounded package reads supplied the missing hunks. No checkout/index/branch/PR mutation and no helper agents. No suites rerun.
- Verified stored final log counts: `c9-check-packaging.log:20` has 71 frontend files/501 tests, line 77 has 48 Node tests, line 94 has 16 import tests, line 143 has 41 evaluation tests, line 155 preserves all 251 criteria, line 294 passes static HTTP smoke. `c9-focused-final-source.log:5` records 4 files/58 tests. Summing all 15 per-file totals in `c9-native-release.log` yields 115, not a full-server-suite claim. Earlier red/fixture/type-failure logs are preserved and described as failures, not final success.
- Browser harness uses actual canonical HTTP/PG services and explicit synthetic authentication (`docs/ui-validation/2026-11-18-document-reader/reader-runtime.ts:133`). `capture.mjs:25–51` checks precise focus, repeated headings, Korean next/previous, denied copy, latest removed-anchor vs fixed, and source revocation in both readers. Browser-results contains four 1440/390 light/dark runs, Chromium158, no page errors, fingerprint `41b26860c702219d80d27ef603b884e579d546dfdedd1a43323149aab826dce6`, runtime/frontend starts before capture. Controller independently verified manifest 336 production/3 harness/4 regressions/18 artifacts/26 logs; this review did not rerun that verification.
- Visually inspected final `390-dark-reader.png` and `1440-light-reader.png`: readable controls, distinct repeated TOC positions, Korean/code/table highlights, separate unknown review/official metadata, and no evident horizontal clipping. The other two conditions are supported by the capture records; no full assistive-technology or physical-device claim.
- Concrete additional context checks were limited to named risks: full segmentation/Markdown effect bodies because diff hunks cut functions; VersionService authorization and usePersonalKey for session/late-response safety; workflow admission/fail for refresh interaction; publication/route/api call sites for omitted planned files; accepted edit text for the CR reproduction. Actual renderer and component reproductions were small one-shot probes, not validation-suite repeats. The reviewer environment emitted a Node module.register deprecation warning during those probes; it is unrelated to product behavior or the implementer's Node24 evidence.
- Unknown review time/official designation, duplicate-block unavailable sharing, bounded results, synthetic IdP, real IME/device/accessibility, operational acceptance, and semantic quality remain explicit limitations rather than additional C9 blockers. Existing tests exercise ACL/source/ancestor/session/erasure, but this task review is not a new whole-system security certification.

**Requirements gaps:** UXC-08 changed-paragraph/latest-link correctness and Clipboard failure feedback remain unmet in the two reproduced cases. Fix those before task approval; keep historical anchor compatibility and the existing security criteria intact.
