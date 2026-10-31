# Task G trusted integration contract

Migration **109 is reserved and frozen**. Owned files: this directory, migration109, questions UI/tests. No runtime/jobs/model/agents/App edits by G.

The host must wire `options.questions = questions.questionJobAdapter()` into `createRuntimeJobs`, analogous to semanticLint, for query payload **strict `{threadId,turnId}`** only. `prepare` returns `{payload,pageIds,sourceIds}`. Internal payload is an opaque ID/hash seal, never question/history plaintext. Queue derives model/offline policy from the returned payload's `mode`. `execute(ctx,payload,execution)` invokes the configured trusted `runQuery` callback.

`QuestionsService` requires `runQuery: QuestionRunner`. It must invoke **the actual RuntimeService.query(ctx, question, mode, execution, context)**. The fifth argument is **trusted, not deserializable from HTTP**:

```ts
interface TrustedQuestionContext {
 resolve(db: PoolClient, state: State): Promise<{
   messages: {role: 'user'|'assistant'; content: string}[];
   pageIds: string[]; sourceIds: string[];
 }>;
 onCreated(db: PoolClient, answer: Answer): Promise<void>;
}
```

Runtime MUST call `resolve` in its initial query-input transaction and again before transmission and before persistence using current state; include resolved `messages` as separately typed model input (not concatenate into the question). Union resolved roots with retrieved-page roots in the **actual saved answer.inputEnvelope**. `captureInputs` must cover that union. `onCreated` runs inside the same fenced `execution.persist(db,'query',write)` write callback immediately after answer registration, before checkpoint. No nested pool transaction. It CAS-completes the sealed pending turn with the **actual produced answer.id**, fixed answer version1. Replay of checkpoint must not invoke another model or create another answer/turn.

Important: resolve against the **unfiltered current admitted view**, before recommendation-only filtering. The raw prompt is conservatively bound to that whole view (including non-recommended readable records); dropping those roots fails `ANSWER_SCOPE_CONFLICT`. `onCreated` verifies the actual saved envelope equals the accepted full seal, including ACL hashes. Runtime queue `selectState` pins admitted IDs so later newly allowed documents cannot enter an already accepted turn. An internal completed seal is usable for existing checkpoint readback; a new public admission of a completed turn is rejected. Never expose `sealHash` as an accepted public submission field.

Prepare validates the server-stored pending turn, pinned accepted thread revision, exact history IDs/input envelope/context fingerprint. Added turns cannot enter a previously admitted context. Invalid old context is excluded before admission; the owning user gets only a generic exclusion notice. If any allowed input changes after admission, fail stale, not silently resend. Raw user prompts are private and bound to the actual full current view plus validated explicit sourceRefs; sourceRefs are not grants, and source-unknown copied quotes cannot be automatically proven safe.

HTTP coordinator: construct service with mandatory qualified authorizer and real runQuery; bind `setSubmit((ctx,payload,key)=>runtimeJobs.submitInteractive(ctx,'query',payload,key))`; mount `handleQuestionRoute`; delegate agent scoped search explicitly without removing the old interface. Turn submit returns actual durable receipt for HTTP202. Pending enqueue crashes are recovered by retrying the accepted nonce via `resumeTurn`, never minting a replacement request. UI host mounts `QuestionsWorkbench`.

Do not claim end-to-end completion until real RuntimeService + createRuntimeJobs + loopback model/PG tests pass. Task G's injected-runner tests alone are adapter evidence, not proof of runtime transmission safety.

## Existing C/D consumers and host follow-up

- Feedback consumes migration102 `governance_business_owners` and hash-pinned `governance_review_assignments`. It checks current designated reviewer/capability/independence/type rules, active humans and full input access. Disabled/unqualified owners are **pending-unassigned**, not inferred Team/space Owner responsibility. Rows in `question_feedback_work` are actual version/evidence-pinned review candidates, with no approval or verification side effect. `/questions/feedback` is the current authorized candidate inbox. Private thread/answer history stays private even to assigned reviewers.
- Historical search reads **actual** migration103 `version_metadata.snapshot`, verifies snapshot/body hashes, and checks recorded source/dependency/parent/relationship closure. No historical snapshot means explicit unknown metadata and null title. `unknownMetadataKeys` lists absent fields. Snapshot103 currently does not capture business owner: that field remains unknown, never today's owner or an untrusted arbitrary property. To support historical-owner filtering, D must capture the validated business owner in future immutable snapshots; old snapshots remain unknown. Current-owner filtering already uses the authoritative C table.
- Agent legacy search must explicitly map its old DTO into the strict search whitelist (no raw owner/SQL alias inference); preserve its existing interface. Whitelist: `query,type,businessOwner,tags,state,reviewDateFrom,reviewDateTo,periodFrom,periodTo,project,environment,archived,historical,limit,cursor`. Default page25, max100. Cursor is MAC-bound to current principal/space/credential, every filter, as-of, whole visible content/ACL/metadata revision and last stable key; expires in15 minutes and on process restart.
- `QuestionsWorkbench` takes `{api,identityKey}` where identityKey includes current principal and space. Mount it only in the actual authenticated host. It uses shared `resolveJob`, clears protected data on scope/identity/policy failures, preserves the accepted nonce and original CAS during retry, and does not persist prompts/history in browser storage.
- Operations erasure/export/backup/retention must explicitly include the new private tables `question_threads`, `question_turns`, `question_feedback`, `question_feedback_work`; these integration files are coordinator-owned, not modified by G.

## Executed evidence (2026-10-30)

All tests use Node24 and a fresh UUID-named PostgreSQL database via `server/questions/test-runner.mjs`. The runner reads only the local test fixture configuration, passes credentials through child environment, and removes only its own isolated database on exit.

Command: `npx --yes --package=node@24 -- node server/questions/test-runner.mjs server/questions src/operational/questions.test.tsx`

Current package evidence: 11 tests /4 files passing (rerun after final edits required). Includes private thread reads, CAS concurrency, nonce/orphan enqueue retry, strict public IDs, revoked raw-question context omission at the trusted adapter boundary, changed input rejected before runner invocation, actual historical bodies, combined current filters, cursor cross-filter/principal/ACL rejection, actual103 immutable metadata snapshots, actual RuntimeService offline answers, actual reviewed/published version2 and current102 assignment feedback routing, reviewer revocation, inactive-owner unassigned work, no new approvals, pure HTTP202 routing and Korean UI/accepted retry helper. The adapter inspection test deliberately throws `INSPECTED_CONTEXT`; it is **not** a model/durable queue end-to-end success test.

Repository gates observed: `npm test` under Node24 passed124 UI/domain tests plus48 Node CLI/model/connector tests. `check:requirements` passed all251 original criteria unchanged. `check:server` passed. `build` currently blocked by coordinator-owned `src/operational/App.tsx:1113` (`ChangeSet.reviewWarnings` missing, implicit-any warning). A full fresh-DB server run was attempted while shared migrations were still being edited: 123 passed/406 failed/47 skipped across79 files; failures include migration checksum mismatch and isolated recovery database preconditions. This is **not** a green server regression result. Full log remains in harness shell output `sh_18d4442770019apFg33MMB8pXO`.

Still unverified/unintegrated: actual query trusted context implementation, queue adapter admission/dispatch/model budgets and HTTP202 host mount, real loopback model proof of zero revoked historical bytes, actual queue restart/exactly-once/lease fencing, MCP delegation, operations storage graph integration, actual390/1440 browser/keyboard validation after host mounting. No claim of QNA005/QNA008/SRH002/SRH004 whole acceptance closure yet. No commits/push/worktree/merge/credential changes by G.
