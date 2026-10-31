# Task A — actual transmission/feature integration

Requirements: **SEC-011 / GOV-007 / OPS-005**. This is software integration and local
synthetic regression evidence, not company approval, independent semantic quality,
or a declaration that every acceptance task is complete. No commits/staging during
the active shared-worktree merge. Migrations 001–029 and fixed migration100 unchanged.

## Implemented boundaries

- `RuntimeService.query/ingest`: exact actual input envelopes, immediate policy
  preflight, actual transport callback after existing budget hook, policy/content/
  ACL recheck before answer/proposal persistence and pending-result release.
- `server/runtime/model.ts`: additive `ModelOptions.beforeTransmission(endpoint)`;
  preserves `beforeCall`, `onUsage`, signal, byte/token/output/time limits and system
  rules. Standalone transport tests remain transport-only. Runtime model calls do
  not have a bare-context bypass. Unconfigured remains `MODEL_NOT_CONFIGURED`.
- `server/jobs/runtime.ts`: `sourcePolicyHash` in the actual queue policy fingerprint;
  exact operation feature guards in scope validation for admission, execution and
  schedules. Read/status/cancel remain authorized and available when disabled.
  Daily/weekly require **both** lint and ingest. Existing fence, execution identity,
  directory freshness, content envelope, budget and idempotency remain in force.
- Real semantic adapter/provider: full pinned claim/evidence/page/source snapshot,
  policy-bound actual endpoint, post-provider DB recheck. Actual network providers
  cannot use the legacy inline bare-context path; they require durable jobs.
- Actual execution verifier: canonical source hash/exact quote challenge remains
  validated by existing code; `execution-verification` checks before actual HTTPS
  transport and again before evidence persistence. Policy is not execution proof.
- `changesetsDb` includes `reviewWarnings` only for a nonempty stored array; no new
  empty field is added to strict existing DTOs.

## Context and feature semantics

`assertModelTransmission(db,ctx,{destinationId,purpose,pageIds,sourceIds})` is DB-only,
default-DENY for absent source policy. Historical version source/provenance, links
and hierarchy parents are closed over; >200 combined resources or depth>32 rejects,
never truncates. Existing canonical current-role/resource/source guards still apply.

Browser contexts require the trusted server request capability. Verified PAT/service
contexts may have no OIDC `authorization`: the helper explicitly locks/checks the
current credential row (same principal/workspace, unrevoked/unexpired), then uses the
canonical engine's scope/action/role intersection. A credential-looking string alone
does not grant authority. Network identity refresh runs outside DB locks when supplied;
DB assertions never perform directory/network I/O.

`assertFeature(db,ctx,feature,resource?,action?: Action)` checks a boolean **in addition
to**, not instead of, the exact canonical operation. Default action is knowledge.read;
trusted host call sites pass their real action for write-only source.create tokens,
personal.sync, export/local-copy resources, etc. A feature does not imply a fixed
write/admin action. Resource accepts `{kind,id,version?}`: exact-version role-less
shares can check their feature after canonical grant/ancestry authorization, without
global read or share.manage. Internal flag reads do not authorize metadata endpoints.
Policy `featureState` remains a globally authorized management projection.

Pure helpers: `featureForRoute(method,path)`, `featureForMcpOperation(name)`,
`featureForJobOperation(kind)`. Own-property lookup prevents constructor/**proto**/
toString resolution. Null means unmapped, not authorization. `wiki_*` and existing
knowledge/import tools are mapped; existing import status/preview/cancel and wiki job
status/cancel controls deliberately remain usable while creation/execution is off.
Use `assertJobFeatures` for compound daily/weekly, not a guessed single feature.

## Trusted registry and environment

Startup calls `registerTrustedDestinations(pool, unknown)` with the COMPLETE array:

```ts
[
  {
    id: "local-model",
    url: "https://approved.example/v1/chat/completions",
    purposes: ["query", "ingest", "organize", "semantic-lint"],
    classifications: ["synthetic"],
    active: true,
  },
];
```

Strict runtime validation rejects unknown keys, duplicate/prototype-unsafe IDs,
unsupported/empty purposes/classifications and nonbooleans. URL is the full final
endpoint, not base URL; no credentials/query/fragment. Empty registry revokes all
active entries. Address/purpose/classification/active changes revise fingerprints;
changing back never revives grants. No browser destination-registration endpoint.
BEGIN → shared mutation gate822025 → registry advisory7203100 → ordered workspace
locks. Registry changes are audited atomically per existing workspace.

Exact env names:

- `AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID`
- `AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_DESTINATION_ID`
- Existing LLM/verifier URL/model/global-transmission configuration remains mandatory.
- Coordinator parses `AKH_MODEL_DESTINATIONS_JSON` at trusted startup and registers
  before API/workers; a configured URL alone creates no source grants.
- Optional `AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS`: JSON of KNOWN feature/boolean pairs
  only. Site false overrides workspace/source grants. Existing authorized groups
  default enabled; company/guest/anonymous are false and cannot be enabled by JSON
  until their separate optional policies exist. Unknown features fail closed.

Classifications, including any deliberate `unknown` exception, must be explicitly
approved by trusted local destination configuration. Team Admin cannot approve an
unsupported destination/classification. Local authorization is never company approval.

## Private raw imports — migration105, imports-worker hook

Raw imports are NOT registered sources and upload is NOT model consent.
`policy_private_import_sources` binds explicit human uploader approval to current
import revision + parsed/raw-file/selection hash, classification and exact destination
fingerprint/purpose. Only the current human uploader with canonical source.create can
grant its private-import policy; credentials/LLMs cannot grant. This is not a space
Admin promotion, sharing authorization or publication approval. Source policies still
separately constrain any existing wiki/source context sent alongside the raw import.

Actual worker integration (imports files deliberately not edited):

```ts
const binding = await bindPrivateImportTransmission(
  pool,
  ctx,
  { importId, inputRevision },
  actualInputEnvelope,
  modelOptions,
);
const output = await runtime.model("organize", actualInput, binding.options);
// In existing same lease/fenced commit, after network refresh OUTSIDE locks:
await binding.recheck(db);
// then persist the actual run stage/results, preserving existing checks
```

Export is `server/policy/imports.ts`. Do this for EVERY extraction/consolidation call,
not just enqueue/first chunk. `inputEnvelope` may be empty for raw-only private input;
it must cover all registered context when present. Worker must bind ref to its current
stored run/owner/lease and never take it from model output or arbitrary payload hints.
`options.beforeTransmission` is chained; producer-specific budgets/usage are retained.

HTTP (host normal auth/CSRF/Origin/body-size admission first):

- GET `/api/v1/policy/imports/:id`: current uploader only; policy/revisions plus
  preapproved organize destinations. Does not enumerate another user's private raw.
- PUT same path: `{expectedRevision,expectedImportRevision,classification,
grants:[{destinationId,purpose:"organize",fingerprint}],impactAcknowledged:true}`.
- GET/PUT `/api/v1/policy/sources/:id`: current human space Admin AND source read;
  source PUT `{expectedRevision,classification,grants,impactAcknowledged:true}`.
- GET `/api/v1/policy`; PUT `/api/v1/policy/features/:feature`
  `{expectedRevision,enabled}`. Guards need not be enabled to manage/re-enable policy.

All DTOs are strict: no principal/URL/key/registration. Revision0 means absent policy.
Policy mutation + chained immutable audit + access policy-version bump is atomic.
`sourcePolicyHash(db,ctx,roots)` includes complete roots AND all workspace source/
private-import policies, destination revisions, feature records and site configuration.
This conservatively invalidates other jobs too; combine with existing content/ACL
envelope, never replace it. Approval integration must consume current policy_version.

Physical erasure must DELETE model_source_policies before sources (migration100 FK).
Private-import policies cascade with imports. Immutable policy_events hold decision
metadata/hashes, not raw input text. Coordinator owns erasure integration.

## Trusted conversation extension (Task G)

`RuntimeService.query(ctx,question,mode,execution?,trustedQueryContext?)` accepts only a
server-created `TrustedQueryContext`: `messages[{role,content,turnId}],inputEnvelope,
contextFingerprint,recheck(db),onAnswerPersist?(db,answer)`.
Adapter validates current private owner/turns and all old envelopes. Runtime checks
again before actual transport/after model, unions historical roots with current
recommendation inputs in the saved answer envelope, and passes history as separate
untrusted DATA, never as system instructions/current evidence. Existing byte budgets
apply. `onAnswerPersist` is inside answer insertion + existing fenced query checkpoint
transaction, so a turn-write error rolls back the answer too. Filing preserves roots.

`RuntimeJobsOptions.questions.prepare(db,ctx,input)` returns
`{payload,pageIds,sourceIds}`; **payload.mode is required**. It must accept initial
`{threadId,turnId}` and its own sealed payload for current revalidation. IDs/source
scope come from trusted DB lookup, not caller selection. `execute(ctx,sealedPayload,
execution)` supplies the trusted fifth argument to RuntimeService.query. Default
unknown/unconfigured thread jobs reject `QUESTION_JOBS_NOT_CONFIGURED`.
G owns actual thread storage/owner/turn implementations and host wiring.

## Evidence / remaining host boundaries

Initial production-integration RED: all four new runtime/PAT tests failed (unauthorized
actual model request succeeded, PAT rejected, policy-revoked result persisted).
They now pass with actual producer HTTP receive counts and current DB checks.
Real query/ingest/worker/semantic/HTTPS-verifier tests cover deny receive0, destination
change-back, inflight rollback, PAT revoke/forgery, role-less pinned sharing, private
raw explicit consent/hash change, callbacks/limits and history lineage/atomic callback.

Existing regression model fixtures now explicitly configure/approve **synthetic**
transmission. In-process pure ModelCall fixtures use a clearly labelled noncontacted
test endpoint; this is not claimed as network/model/independent proof. Their original
source ACL upper bounds are restored after named local policy-review setup, rather
than accidentally adding a new published reader. Real transport fixtures stay real.

Host-owned REST/MCP feature routing, policy UI mounting/registry startup and imports
worker bindings remain coordinator/import-owner integration. No embedding/OCR service
is invented: unsupported producers have no fallback allowance. UI pure tests are not
390/1440 browser verification. Final full-server/npm-check outcomes are reported in
the task handoff response; active unrelated workers can change their files during runs.
