# Weekly knowledge maintenance and monthly operation review

Task 7: MGR-003/004; related MGR-005/006 and CORE-007/008/011. This extends the existing app worker and PostgreSQL queue. It adds no Pod, broker, database service, cron sidecar or connector daemon. The initial one-node/one-app-Pod/one-DB-Pod design stays intact.

## North Star and boundaries

Weekly revisits the existing published corpus, source snapshots, explicit claims, applicability, exceptions, validity and connections. It improves the Lint → connected multi-document proposal → independent human review/publication loop, rather than treating another source summary as maintenance. Daily retains its existing unprocessed-source ingestion and structural lint behavior.

Exact equality, shared category/tag, isolated connections, missing source references, expired claim validity, different claim/page versions and overdue/90-day publication age produce typed **review candidates**. Shared category is not semantic equivalence; age does not prove that knowledge is wrong; an unobserved connection can exist outside the approved scope. Claim observations, human approval and independent execution are not promoted into one another. Original sources remain immutable.

Configured weekly model execution uses the actual existing ingest transport with a distinct `weekly-maintenance` context and contract, and can propose updates to multiple related pages. Full input, exact page/base versions, source versions/quotes, conditions/exceptions, candidate findings and the review window are checkpointed and returned with a context fingerprint. All transmitted source lineage is retained even if omitted by the response. Page/claim protection, canonical currentRecommendation, source ceilings, model transmission policy, reservations/output/context limits and current identity/ACL checks remain authoritative. Errors stay failed; there is no fallback from a failed model call to a structural success.

The structural mode produces review candidates and no semantic rewrite. Model no-change output creates no batch. Model mode with no eligible source-backed published context records that no model was called. Mixed source scopes require separately approved schedules; they are rejected before transmission rather than allowing cross-scope consolidation. Proposals use canonical `propose`, bound envelopes and base versions; neither weekly nor monthly approves or publishes. Independent human review and version-bound atomic publication remain necessary.

Monthly produces three proposal-only records: business ownership review, retention/classification review with current policy/holds and selected document impact, and measured cost review across the previous two calendar months. Unknown business ownership stays unknown: page author, `Page.owner` display text or an authorization role is not proof. No owner/permission/policy mutation or deletion runs. Costs preserve the existing usage API's non-admin ceiling: only the execution principal's measured events in its currently authorized space are aggregated. Other actor/model labels, credentials and private prompts are not read into the result. The scope limitation is explicit in the UI/result. Missing prices leave comparison incomplete and cost delta unknown; known priced totals are only a measured subset.

## Connected API and calendar policy

Existing authenticated `/api/v1/jobs-v2/schedules`, `/:id/preview`, `/:id/run`, `/:id/enabled`, job read and existing operator UI carry the feature. A human with current jobs.manage approves an actual scoped service identity and fixed page/source ceilings; ordinary human sessions/PATs cannot become unattended identities. Current sponsor, directory proof, credential expiry/revocation, current source/page ACL, policy and budget are rechecked during execution and effect commit.

| Field | Contract |
| --- | --- |
| `cadence` / `job.kind` | `daily`, `weekly`, or `monthly`; these maintenance kind/cadence values must match |
| Weekly payload | `{mode:"offline"}` or `{mode:"model"}`; model name and full configured reservation must match server policy |
| Monthly payload | `{mode:"offline"}` only; no model transmission or automatic management changes |
| Monthly date | `dayOfMonth` 1–31 plus required `invalidDay:"clamp"|"skip"`; clamp uses actual month end, including leap years |
| Time | Explicit IANA timezone, local HH:mm; nonexistent DST minute skips that occurrence, a fold runs only its first occurrence |
| Holidays | Listed local dates skip execution, including a clamped date; no silent next-day shift |
| Catchup | Existing skip/latest/bounded policies; long monthly downtime searches actual calendar occurrences, not a fabricated current timestamp |
| Window | Weekly previous seven local calendar days; monthly previous complete local calendar month, with adjacent prior month for measured cost comparison |

The occurrence comes from `durable_schedule_runs.scheduled_at`, or the durable job admission time for a manual run. Timezone comes from the exact approved schedule revision, not a later edited configuration. No arbitrary caller-provided report window is trusted. Local-date occurrence keys and existing durable uniqueness prevent duplicate execution. Monthly lookup checks at most fourteen calendar dates, avoiding years of minute scanning.

Weekly input, model response, canonical proposal and final maintenance result have separate fenced checkpoints. A failure after proposal commit reuses the same proposal/model result. Changed inputs/claims on retry invalidate cached synthesis instead of applying it to fresh context. Queue cancellation, emergency stops and actual usage telemetry continue through the existing executor. The result cap and input/claim/findings bounds fail explicitly rather than silently truncate provenance.

## Verification and remaining conditions

Node 24 `npm run check` passed: 192 source tests, 48 Node tests, 16 import tests, 41 evaluation tests, 251 requirement mappings, server typecheck, build and static HTTP smoke. Native PostgreSQL 17 uses only `scripts/test-server.mjs` with a new UUID database per file; the base test DB is never migrated/reset. The full jobs suite passed 115 tests before two additional claim/meter tests; the new maintenance runtime file then passed 9/9, and actual OIDC HTTP schedule/CSRF/preview/run/source-revocation checks passed. Later final-head results and screenshot provenance are recorded in the PR/assets README.

Actual configured model transport was exercised against a local OpenAI-compatible HTTP fixture with reported usage and an actual response model. Tests cover two-document proposals, independent approval/publish, stale source/version changes during model transmission, protected pages, exact claim source version/quote and applicability, unknown ownership/cost, and failure after committed proposal. These are synthetic contract/regression results, not company model quality or downstream agent-performance evidence. `docs/EVALUATION.md` controlled comparisons and production directory/model/policy/operational acceptance remain required.

A six-connection actual browser bootstrap reproduced an existing authentication lock-order/session-discard issue. That approved fix is a separate unit; Task 7 does not absorb unrelated auth changes. Final browser evidence uses a separate native verification worktree with the approved auth fix and records both commits. No North Star, original acceptance or production verification status is reduced.
