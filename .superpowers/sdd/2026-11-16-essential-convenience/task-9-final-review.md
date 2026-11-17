# C9 independent whole-branch final review — changes required

Base: `79a90cc9c06c476cd270dec2d17ce11faf11e7e3`
Head: `4615153d420970d5ace98d4f1b54a6948e0ada0c`
Worktree: `/Users/wt.jeong/.codex/worktrees/2fb2/agent-knowledge-hub`

**New findings: Critical 0 / Important 3 / Minor 0. Carried nonblocking Minor 1: existing large-bundle warning. Ready to merge: No.** The original task-review CR-coordinate and overlapping-copy findings are addressed, but the complete branch still has the three independently reproduced defects below. Exact-head CI/controller approval remains necessary after fixes; passing existing CI does not resolve these cases.

## Strengths

- The implementation delegates existing DocumentBody to DocumentReader and retains the canonical marked/DOMPurify renderer. Search highlights and reader controls use DOM nodes/textContent; the sanitizer and raw-HTML exclusion are retained. Ordinary repeated-heading TOC entries remain separate, and identical block content fails closed for sharing. The copied URL uses the existing validated route/login-return codec rather than a new hash convention.
- New publication capture remains in the existing version_metadata INSERT authority (`server/workflows/versions/metadata.ts:40` onward), with explicit workspace scope in `server/convenience/anchors.ts:14`. Stored historical metadata is not rewritten. Legacy fallback is unchanged, and the new CR-only normalization preserves LF/CRLF hash inputs. The new exact CR replacement, moved/changed/deleted and frozen-byte tests are meaningful regressions.
- `latestVersion` delegates to the existing VersionService authorization/transaction/version projection (`server/workflows/versions/service.ts:44–63`). Current/fixed snapshots continue to use current page/source/ancestor checks. New actual-PG tests cover source revocation/erasure; explicit frozen link references retain transitive C7 copy and restore authority. Raw HTML inference exclusion affects new inference, not historical metadata or approval records. The changed C7/C8 fixture assertions still test the same target/source/trusted-origin boundaries using visible Markdown.
- Snapshot's own overlapping requests are sequenced and scoped with usePersonalKey. Per-copy sequence plus document generation now prevents the original late-success/failed-newer-copy feedback bug. Error fallback is selectable and not labelled success.
- The report distinguishes implementation, synthetic HTTP/PG/browser verification, and operating acceptance, and preserves failed/red attempts. It records requirement IDs, source/evidence fingerprints, old-versus-current evidence and remaining limitations. North Star and the 251 criteria were not changed.

## Important I1 — the new revalidation fence does not cover manual document refreshes

**Location:** `src/operational/workflows.tsx:838–854` (new background request counter), interacting with `:855–867` (`refreshDocument` writes detail/comments unconditionally); an actual caller is the expiry-save handler near `:1456`. The structure-change callback at `:1024` is another detail writer that should be included in the audit.

The focus/timer refresh has its own local `request` sequence. Existing manual refreshes never participate in it. Thus a newer current-authorization failure clears the page, but an older successful manual response can restore the protected body afterward. Neither the current selection token nor the background counter changes on a same-document denial, and `refreshDocument` does not test either.

Actual mounted WorkflowPanel reproduction on the reviewed head:

1. Open `topic` with a protected paragraph and lifecycle-management capability.
2. Fill the existing change-reason input and click **유효기간 저장**. Let its POST succeed; hold the subsequent `/workflows/pages/topic` response (authorized before revocation) pending.
3. Dispatch window focus. The newly added `/workflows/pages/topic?visit=0` read returns `ApiError(404, NOT_FOUND)` to represent current source/page revocation. The paragraph disappears and the revocation error appears.
4. Resolve the earlier manual GET with its old authorized body. **The protected paragraph reappears while the revocation error remains.**

Observed output:

```text
old read pending true
after revocation {"body":false,"denied":true}
after late success {"body":true,"denied":true,...}
```

Reproduction: from the worktree run `/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin/node --import tsx /private/tmp/akh-c9-workflow-race-probe.mjs` (exit 0). The saved probe mounts the real WorkflowPanel and exercises its actual button/handlers, with controlled API response ordering; it does not bypass setters or replace product functions. It is a client-response race reproduction, not a new PostgreSQL or real-IdP experiment.

**Impact:** violates the current-ACL/late-response clearing contract in the precise new background-revalidation integration. The older unguarded helper existed before C9, but C9's new reader revocation boundary does not fence it; this is not a claim that a new server endpoint authorizes forbidden reads. It restores already fetched protected data after the UI has learned it is forbidden.

**Fix:** use one identity/selection/read-generation authority for every detail/comments writer (initial admission, background reads, manual refresh and structure callback), invalidate pending generations on authorization denial, and only commit a response still current for that authority. Preserve exact-draft admission and avoid replaying mutations. Add this actual older-manual-success/newer-denial ordering and the opposite completion order as regressions.

## Important I2 — two rendered blocks can receive one stable anchor, silently sharing the wrong location

**Location:** `src/operational/convenience/document-reader.ts:39–50`, `src/operational/convenience/DocumentReader.tsx:93–114` and `:126–132`. Cause spans the server's plain `marked.lexer` at `server/workflows/versions/diff.ts:12` and the renderer's custom blockMath extension at `src/ui/Markdown.tsx:67–76` / token wrapper generation at `:91–103`.

Supported Markdown `before $$x$$\nafter` produces one server token/anchor covering lines 1–2, but the canonical renderer produces three separate wrappers: paragraph `before` (1–1), display math `x` (1–1), paragraph `after` (2–2). `blockForElement` matches on startLine and end containment, so **both first wrappers get the same stable ID and their own Partial link button**. Link resolution uses `.find`, always selecting the first wrapper.

Actual Reader interaction, using the server's new token mode and the real renderer:

1. Mount the document above, version 2. Two Partial link buttons have ID `a-770de03d712f4e6157aa26c22ee2864e`; one is under `before`, one under the displayed formula.
2. Click the second (formula) button, then **최신 부분 링크 복사**. Actual copy handler produces `https://wiki.example/?app=1&space=space&document=doc&anchor=a-770de03d712f4e6157aa26c22ee2864e`.
3. Unmount, parse that copied URL through `parseConvenienceLocation`, and mount the real Reader with its returned document/space/anchor. Focus lands on **`before`**, not the formula; no missing/ambiguous-location warning appears.

Observed output:

```text
share buttons [{"parent":"before \n부분 링크","id":"a-770de03d712f4e6157aa26c22ee2864e"},{"parent":"x부분 링크","id":"a-770de03d712f4e6157aa26c22ee2864e"}]
reopened {"focused":"before \n부분 링크","targetCount":2,"missing":false}
```

Reproduction: `/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin/node --import tsx /private/tmp/akh-c9-final-probe.mjs` (exit 0). This includes actual click/copy/route parsing/remount/focus, under jsdom; no claim of a fresh full-browser HTTP navigation. Fixed links share the same target-mapping code, although the explicit copied/reopened interaction above used latest.

Generality controls in that probe: ordinary inline math (`$x$`), inline code, inline attachment-image syntax, fenced code and a table did **not** produce duplicate IDs. The reproduced duplication comes from blockMath splitting an existing same-line paragraph. Adjacent separate-line block math also exposes the broader parser mismatch: e.g. `$$x$$\nOriginal paragraph` gets one server block while the renderer makes two, leaving the visible following paragraph without its own share target. Do not infer the duplicate-ID bug affects all Markdown constructs.

**Impact:** a visible, enabled partial-share control copies a URL that silently opens a different rendered location. It violates precise sharing/no-silent-misdirection, including on an unchanged publication. The stated legacy-coarse limitation does not justify issuing two distinct visible controls with one indistinguishable destination.

**Fix:** align the new publication block model with the canonical renderer's supported block grammar or explicitly refuse ambiguous mappings. At minimum enforce a one-to-one anchor-to-rendered-target assignment and never provide a second control that resolves to the first. Preserve stored legacy/frozen identities rather than rewriting historical metadata. Add actual rendered math-boundary and copied-location regressions, including same-line and adjacent-line forms.

## Important I3 — every successful periodic refresh discards active reading/search state

**Location:** `src/operational/convenience/DocumentSnapshot.tsx:48–49`, `:65–66`, `:97–115`; same remount pattern in `src/operational/workflows.tsx:846` with the reader under `detail && latest` at `:1014` onward.

The new 60-second callback always sets `snapshot`/`detail` to null before the request. That unmounts DocumentReader even when authorization and content remain unchanged. Its query, active match, selected partial share and copy fallback are component-local, so the next successful response creates an empty reader. The focused search control is removed from the DOM; anchor routes additionally execute initial target focus again on remount.

The saved `akh-c9-final-probe.mjs` mounts the actual DocumentSnapshot with a fixed version, types `Korean` into the real search input (two highlighted matches), focuses the input, invokes the captured actual 60-second callback, then resolves the read with **the exact same authorized snapshot**:

```text
pre-timer {"query":"Korean","marks":2,"focus":"INPUT"}
pending-timer {"input":false,"focus":"BODY"}
post-timer {"query":"","marks":0,"focus":"BODY","calls":2}
```

**Impact:** simply reading or navigating search for more than a minute unexpectedly loses the user's query, position and keyboard focus; this affects ordinary unchanged documents, not just rare failures. Current/fixed link readers both use this refresh path. Clearing protected body while checking current authorization is appropriate, but losing safe interaction state on every successful check is not necessary for that guarantee.

**Fix:** retain non-protected reading state in an identity/document/version-scoped owner across revalidation, restore it only after an authorized response for the same snapshot, and avoid replaying initial anchor focus on routine unchanged refresh. Continue clearing protected DOM immediately and discard retained state on identity/document switch or denial. Cover unchanged-success preservation alongside the existing denial/late-response security tests. Do not fix this by leaving revoked content visible or removing revalidation.

## Existing fix assessment and evidence boundaries

- Original task review I1 (CR-only empty hash causing replacement identity reuse): addressed in the new token-mode line array; legacy branch and historical storage untouched. Original I2 (earlier Clipboard success replaces newer failed-copy fallback): addressed by copySequence plus generation. Current added tests and browser assertions exercise those exact cases. They do not cover the three new failures above.
- Reviewed all changed production/test paths, harness/manifest, documentation changes and evidence in bounded passes, with neighboring code only for named mapping, authority, identity and async-writer risks. No CodeGraph directory exists in this worktree. No checkout/index/HEAD/branch/PR changes and no helper agents. Final observed HEAD remains `4615153...`, and git status is clean. Only the requested report and two reproduction scripts were written under `/private/tmp`.
- Current-source stored evidence: `c9-r1-check.log` has 71 frontend files / 508 tests, 48 Node tests, 16 import tests, 41 evaluation tests, all 251 criteria, type/build/static HTTP smoke success. `c9-r1-native-final.log` totals 15 files / 120 tests. These are implementation/controller evidence, **not suites rerun by this reviewer**. Earlier C9 501/115 and pre-fix browser captures are carried historical evidence, not extra current-head runs.
- Current browser-results records Chromium 158.0.8127.18, four 1440×1000/390×844 light/dark configurations, errors[], 219 API requests per case, copy ordering and CR/mixed movement/deletion checks. Fingerprint `a88bf15d089d600138896abec34ce5d2215744c0901e54702e8b5c9f10a7a07a`; runtime/frontend starts precede capture. Controller independently verified 336 production / 3 harness / 4 regression / 26 artifacts / 38 logs; no redundant manifest or broad suite rerun here.
- Visually inspected current `390-dark-reader.png` and `1440-light-copy-race.png`: readable narrow layout, distinct repeated TOC entries, safe code/table highlighting, independent unknown metadata and visible failed-copy fallback. Remaining conditions are supported by supplied execution records, not a claim of visually checking every PNG. Cleanup JSON records owned DB/profile removal and ports closed while parent DB remains alive.
- Reviewer probes initially ran with ambient Node 26; an initial combined probe failed before mounting because its synthetic navigator omitted userAgent. Corrected the fixture and reproduced; then repeated only the two focused probes using the project's supplied Node24 binary to eliminate unsupported-runtime doubt. Both exit 0 with the exact outputs above. Ambient Node26 emitted the unrelated module.register deprecation; Node24 did not. CSS imports alone were stubbed for jsdom; production renderer/component/handlers were loaded unchanged. No database or browser service was started by these probes.

## Declined to judge / explicit remaining acceptance

- Company IdP, production ACL race certification, operating deployment, real sensitive data, load and backup/restore acceptance: outside this C9 synthetic review; no certification inferred from existing service reuse.
- Semantic knowledge quality and downstream agent-performance benefit: not measured by this work; North Star/evaluation contracts remain targets.
- OS Clipboard behavior, physical-device IME and full screen-reader/accessibility acceptance: supplied tests use controlled Clipboard promises and synthetic browser keyboard input; no claim of those broader checks.
- Review timestamp and official-document status availability: currently honest `미확인` because DTOs do not supply independent evidence. I do not require inventing values or infer review from publication.
- Conservative unavailable sharing for identical duplicates, bounded tails, legacy coarse positions and some newline-style-only edits: intentional documented fail-closed limitations. I2 specifically concerns controls falsely claiming a precise destination, not demanding guessed IDs for these cases.
- Existing >500 kB build warning: carried Minor 1, acknowledged separately; not newly caused or made blocking by this review.
- Exact-head required CI, mergeability and merge authorization: controller-owned final gate, not checked or mutated through GitHub here.

## Assessment

**Ready to merge: No.** Fix all three Important findings and add narrowly targeted regressions while retaining the current authorization clearing, historical immutability and exact-draft rules. The branch has substantial meaningful evidence, but that evidence misses one protected-state response race and two precise-reading regressions demonstrated against its current code.
