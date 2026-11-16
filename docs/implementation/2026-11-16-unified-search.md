# Unified search and recommendations

## Canonical retrieval (Task 1a)

SRH-002/003/004/005/007, CORE-009/010: agent REST/wiki_search, cookie knowledge_search and question search use ScopedSearch with the same literal Korean/code/title/summary/body matching, strict combined metadata filters and immutable historical metadata. Agent search keeps schemaVersion 1.0, id/title/summary/version/conditions/verification and integer offset/nextOffset compatibility; it additionally returns historical status, metadata status, href, asof and a signed nextCursor. Ordering is the canonical stable timestamp/page/version keyset rather than the former independent token-score ranking. Historical unknown metadata stays null, including title and conditions. Summary falls back only to the selected version's own bounded excerpt.

Agent include_history explicitly maps to historical; no other caller fields or identity aliases are inferred. Project and environment filters require recorded exact matches, including rejecting unknown values. Raw source and transitive page checks use the injected canonical authorizer, including credential ceilings. Pagination binds credential/principal/workspace/filter/revision and invalidates on current ACL or content changes. Runtime HTTP shares one searcher across requests so cursors do not reset on each agent/MCP request; restart invalidates old cursors.

Default search and agent task context include only currentRecommendation. Archived, replaced and future-effective knowledge remains explicitly readable. Explicit archived=true or non-active state filters inspect current snapshots without claiming a recommendation. A historical search never claims current recommendation, and reading a historical version also cannot report itself as the current recommendation.

This improves authorized Query consumption of the existing maintained wiki. It does not change stored knowledge, approve or publish anything. Native DB/SDK regressions measure the access, temporal and paging invariants; semantic quality and downstream agent utility still require the controlled evaluation contract.

## Remaining Task 1 work

Task 1b will add configured model-backed semantic selection through existing transmission policy, durable budgets, real usage and input rechecks. Task 1c will add PostgreSQL-backed index freshness/status and atomic rebuild. This lexical integration does not mark SRH-001/006/008 or CORE-009/010 full acceptance complete; actual external agent interoperability, large wiki context adequacy and company model quality remain acceptance work.

Cookie knowledge_search preserves the previous page aliases (id, summary, scope, lifecycle, effectiveFrom, replacementId, reviewDue, reviewOverdue) using the selected version metadata, with null for unknown historical values. Its `question` input is an explicit alias for canonical `query`. The agent include_history and cookie historical filters do not accept identity fields.

Validation: final npm run check passed; native PostgreSQL17 10-file/68-test regression passed, then final changed-search 3-file/24-test rerun passed. No UI source/layout changed in this unit; no screenshot-based UI validation claim.
