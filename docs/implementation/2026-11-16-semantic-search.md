# Policy-controlled semantic retrieval (Task 1b)

SRH-001/002/003/004/005/007 and CORE-009/010: semantic retrieval runs a configured real OpenAI-compatible model over the complete currently authorized, metadata-filtered corpus within explicit limits. It selects fixed page/version pairs and exact quotes by meaning, including candidates with zero literal query hits. It is a separate query job, never a heuristic labeled semantic, never a lexical fallback and never an answer/ingest/publication effect.

## Connected interfaces

- POST /api/v1/search/semantic and /api/v1/agent/semantic-search, agent MCP wiki_semantic_search, cookie MCP knowledge_semantic_search: strict {filters, idempotency_key}. Canonical filters/history and nonempty query; no cursor, caller identity, endpoint, model or approval field. Existing keyword DTOs remain unchanged.
- Returns the existing durable query receipt. Read /api/v1/jobs-v2/:id or agent wiki_job_status. Admission is not completion. Web search offers keyword/code or semantic mode and polls the real job contract.
- Completed items add match {quote, reason, status: model-relevance-proposal}. Reasons are unverified proposals; quotes must exactly occur in that version. Fabricated/duplicate pairs or invented quotes fail. Retrieval metadata contains actual provider/reported model and measured or unknown usage. Empty authorized corpus explicitly reports no invocation.
- Result limit defaults25, max100, without semantic keyset continuation. Candidate corpus cap100 documents/versions; larger filtered corpus fails SEMANTIC_CORPUS_LIMIT rather than silently sampling. Existing queue byte/output/time limits also fail explicitly. Narrow filters to fit. No extra service or Pod is required.

## Security and runtime ownership

ScopedSearch.searchDb composes the canonical search within a trusted transaction, with identical filters/authorization. Admission seals filtered items, full source/transitive-page envelope and historical snapshot dependencies. Queue payload stores filters/hash, never copied bodies. Execution, actual transmission and final output rederive the seal under current credentials and source ACLs. Source policy/destination grants are rechecked immediately before actual fetch and output. Added, replaced, changed or revoked inputs invalidate admission rather than widen context.

Durable query jobs retain authenticated parent/credential grants, hard token/cost reservation, begin-call guard, actual provider telemetry, retry checkpoints and current result-read authorization. No inline HTTP model path bypasses them. Every influencing source and the registered destination must allow purpose query and existing feature policy. Legacy unscoped agent keys acquire no semantic/durable authority. No approval/publication capability is added.

The query model contract adds semantic selection and bumps MODEL_CONTRACT_VERSION. Older queued work follows existing policy-change re-admission rules. Provider/schema/network failure remains failure. Search creates no source/wiki/runtime answer/review/publication.

## North Star and evaluation

This improves Query consumption of maintained connected knowledge. It preserves sources, fixed versions, temporal distinction, current access ceilings, exact evidence and separation of relevance proposals, claims and independent verification. It does not reinterpret the North Star or demonstrate downstream performance improvement.

Native tests use real provider HTTP traffic with synthetic replies, actual PostgreSQL identity/policy/budget/queue services, revoked access, historical secrecy and input bounds. Company model relevance and downstream utility require controlled evaluation. Large-corpus performance beyond stated bounds is unverified. Index freshness/rebuild is separate Task1c.
