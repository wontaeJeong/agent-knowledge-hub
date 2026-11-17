# Connected selected-source knowledge loop (Task 12)

Requirements: CORE-009 and the bounded KI-01/02/03/05/06/07 integration path. This extends the existing P8 authenticated personal-page synchronization/proposal path; P8 is not new work. ADR 004 remains **Proposed**. The deployment shape remains one node, one application Pod and one DB. There is no local daemon, crawler, watcher, OS startup task or saved timer presented as execution.

## Contract

Use the native `/api/v1/connector` endpoint and a current `akh_` scoped credential. The selected actions require the canonical capabilities `source.create`, `knowledge.read`, `changeset.propose`, and/or `lint.run`. The credential and current human/service/space/resource policy remain authoritative. Legacy `akh_sk_` PATs do not gain routes or publication rights. Existing personal synchronization additionally requires its existing `personal.sync`/`local.copy` capabilities. Knowledge operations do not depend on personal synchronization succeeding.

Set `AGENT_KNOWLEDGE_HUB_SOURCE_ROOT` to an explicitly approved local directory. Select one file by name; the root cannot be supplied by the MCP caller. Realpath containment, final-component no-follow open, a post-read containment check, secret-path exclusions, file/type/size/content limits apply. No directory traversal or automatic outside-policy collection occurs. Secret-path exclusions are a path guard, not semantic classification of arbitrary file content. The local operator remains responsible for selecting permitted material.

```sh
npm run wiki -- source-register selection.json
npm run wiki -- knowledge ingest.json
npm run wiki -- knowledge-poll ingest-new
npm run wiki -- knowledge-status
npm run wiki -- knowledge-resume ingest-new
```

Selection example (synthetic names; use the actual authorized principal and target):

```json
{"id":"selected-1","file":"notes.md","source":{"title":"Selected notes","targetPageId":"topic","scope":"private","readers":["actual-owner-id"]}}
```

Private is the default; its readers must be exactly the current owner. Explicit team/company selection is a separate caller-selected source creation request checked by the common service, not an automatic promotion of a previously private source. Existing disclosure and independent review/publication paths apply to any later sharing. Registering a private source does not sync it into a team publication. Input verification is always forced to unverified.

Operations are explicit JSON requests:

```json
{"id":"ingest-new","kind":"ingest","sourceIds":["returned-source-id"],"mode":"offline"}
{"id":"query-new","kind":"query","question":"A question about published knowledge","mode":"model"}
{"id":"lint-new","kind":"lint"}
{"id":"file-answer-new","kind":"file-answer","answerId":"returned-derived-answer-id"}
```

`offline` is structural compilation/extraction, not model synthesis. `model` uses configured real server model transport and policy/budget gates; unconfigured or invalid output stays an error. Lint uses the existing structural maintenance service and returns review findings. Semantic Lint remains the separately configured server feature. Source registration uses AgentService's canonical immutable source registration. Ingest/Query/Lint use the existing durable job admission, worker, current identity/envelope checks and errors. The new connector adds no approve/publish operation. An independent authorized human reviews and publishes through the existing web/server review flow; subsequent Query reads that actual publication. Answer filing uses the existing derived-answer service with an atomic idempotency hook, and creates no independent raw source.

Local STDIO MCP adds `wiki_register_source`, `wiki_knowledge`, `wiki_knowledge_resume`, `wiki_knowledge_poll`, and `wiki_knowledge_status` with the same contracts. Server knowledge-capability negotiation fails explicitly on old/synthetic unsupported APIs; the ordinary synthetic synchronization service is not upgraded into a knowledge engine. A remote MCP connection by itself is not the loop.

## Receipts, reconnection and review

Before transmission, the selected operation and its key are saved atomically. Registration stores the selected path, metadata and content digest, not raw file content. Reconnection is explicit `knowledge-resume`; the file must still match the original digest. The original content is never silently replaced with a changed file. The existing store is bound to endpoint/credential hash and locks to one writer. Credentials themselves are never written to the state or printed.

Admission is not completion. Keep the same key after an unknown network outcome. The server returns the existing source/job/proposal only under current authorization; mismatched input conflicts. Client polling preserves actual queued/running/succeeded/dead/cancelled status and errors. Failed access/polling is unconfirmed, not successful execution. The 1,000-operation local receipt cap fails explicitly rather than silently evicting uncertain work. A new credential needs a separate existing connector directory, as before.

Receipts carry source ID/version/digest, job ID, proposal ID/hash, derived answer ID, cited page versions, and Lint finding references. Protected source/answer/proposal bodies stay on the server: this avoids treating read permission as local-copy permission. Existing local copying continues through its source-copy-policy checks. Review references are historical receipts, not an assertion of current approval, verification or publication. Open the returned server review path under the human's own credentials. Changing source access or credential policy blocks subsequent server reads/replays.

## North Star judgments and limits

This is an adapter into maintained knowledge, not another local knowledge authority. The common server remains authoritative for raw sources, page versions, relationships, proposals and publication. New source Ingest consumes existing context and produces the common dependent change set. Query after independent publication cites exact new versions; filing remains derived knowledge. No source trust, audience expansion, approval or independent execution evidence is inferred from transport success.

Validation exercises actual PostgreSQL, scoped credentials, native HTTP, server workers, local CLI and SDK STDIO with synthetic content, plus actual loopback model HTTP transport. Source/credential revocation, duplicate admission/filing, path/secret guards, lost response/reconnect and model failures are separate regressions. The authentication lock-order prerequisite is the separately reviewed PR54 branch, not a Task12 fix. Actual company SSO/model quality, KI operational acceptance, Windows installation and KE-08 controlled downstream utility remain unverified; no quality/performance effect is claimed. No UI layout changed, so CLI/protocol evidence replaces screenshot evidence for this PR.
