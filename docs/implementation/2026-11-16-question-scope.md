# Question scope and applicable context

Requirements: QNA-004, CORE-010. This is Task 6 of the approved remaining-roadmap plan. It builds on the canonical scoped search and the Task 5 publication lineage; it does not change North Star or claim operational acceptance.

## Connected contract

`POST /api/v1/query` and cookie MCP `knowledge_query` accept the existing `question` and `mode`, with optional `scope`:

```json
{
  "question": "retry",
  "mode": "model",
  "scope": {
    "topic": "기술 설계",
    "project": "example",
    "historical": true,
    "periodFrom": "2026-10-01T00:00:00Z",
    "periodTo": "2026-10-31T23:59:59.999Z",
    "environment": {"os": "linux"}
  }
}
```

`wiki_get_context` on agent REST and agent MCP accepts the same optional `scope`, alongside its existing task/project/environment/token_budget fields. Existing project/environment document filters remain in force. `scope.environment` carries exact structured claim conditions; its `environment` key also narrows the registered document environment. Explicit legacy project wins over scope.project. No scope field changes workspace, identity, role, source permission or credential ceiling. The selected authenticated space remains the workspace; unknown keys and inverted dates are rejected. Date filters require historical=true. Scope is included in the durable payload/idempotency hash and is used at execution.

`topic` means the exact registered document category, consistent with topic subscriptions. The web form suggests categories from currently admitted pages and accepts a historical category name without querying unauthorized category names. Empty topic means all admitted topics. Default scope remains current recommendations. Existing method arguments and ordinary query DTOs stay compatible; query scope is the optional sixth RuntimeService.query argument after execution and trusted conversation context.

Returned and saved answers include the authenticated workspaceId, queryScope, temporalMode and asOf. The web result shows the actual selected space/topic/period independently of subsequent edits to the controls. Saved-answer reads preserve these fields after their existing full-input current authorization check. The result labels the query time and historical answers as not current recommendations. Legacy saved answers without scope retain their original DTO.

## Time and metadata

Period boundaries are inclusive publication-recording timestamps, compared as instants rather than timestamp string spellings. The web date fields explicitly use UTC, from start of day through end of day. These dates are not factual validity dates. Historical selection uses the actual version body and immutable version metadata. Missing historical title/category/conditions stay unknown; the stable page ID is only the citation-title placeholder when the original title was not recorded. Current metadata never fills missing historical metadata. A current topic filter cannot manufacture a match for an unknown historical category.

Current retrieval uses canonical currentRecommendation, including replacement, archive and future-effective exclusions. Historical retrieval is explicit and never marked a current recommendation. Claim validity is checked at query time in current scope and at each version's recording time in history. Validity has an inclusive start and exclusive end. A later claim is not projected backward into a historical version. Claims bound by originBatchId to that exact publication are allowed despite timestamp ordering within the same atomic transaction. This does not reinterpret independent later observations as historical metadata.

## Evidence, applicability and budgets

Both actual provider input and agent context contain fixed-version pages, recorded metadata status and structured claim context. A whole claim preserves conditions, every exception, validFrom/validTo, uncertainty and exact evidence ancestry. Compatible but missing conditions or validity remain applicability=unknown. Exact condition matches and registered validity are metadata matches, not proof of semantic relevance or truth. Claim/approval status is never promoted to independent execution verification. Query projection conservatively labels claims unverified; verified review decisions remain available through the dedicated refinement interface.

The existing refinement service authorizes each claim, its superseded ancestors and all evidence. Every influencing ancestor page and evidence source must already fit the selected page/source envelope; otherwise the whole claim is excluded. Adding a readable claim cannot expand model transmission consent to another source. Rechecks compare selected page metadata and claims immediately before actual provider fetch and before answer persistence, in addition to existing source/identity/policy and envelope checks. Denied input never reaches the provider; post-response revocation prevents storing/releasing an answer.

Runtime retrieval retains the existing lexical rank and four-result bound. The shared search DB projection can inspect all admitted candidates for this trusted composition without changing public search pagination. Agent context is capped at 100 candidate versions, reports candidate omissions, and counts the entire serialized page/claim/evidence item against its conservative UTF-8 byte budget. Whole items are omitted rather than stripping exceptions or evidence. Refinement context retains its 100-claim bound and explicit omission count. Actual provider input remains subject to the existing hard context-byte/output/time/job budgets; budget failures are errors, not model success. Body retrieval uses wiki_read; complete claim context can be requested using a narrower wiki_get_context or the existing refinement/context endpoint.

The model contract version is 2026-11-17-question-scope-v1. Accepted model work with an older contract remains subject to the existing configuration freshness failure/resubmission boundary. No new grant, worker, service, migration or deployment is introduced. First-release topology remains one node, one app Pod and one DB Pod.

## North Star decision and evaluation

The change improves the Query/agent-consumption part of the existing Ingest → Query → Lint and feedback loop: already published knowledge is reused with its conditions, exceptions and source lineage. It preserves original evidence, review boundaries, current ACL, fixed versions and honest unknowns. It never writes claims or knowledge merely because a query succeeded. Historical answers still cannot bypass the existing stale-citation and review requirements for answer re-ingestion.

The small alternative of passing only search labels into the UI would leave actual provider and agent inputs unchanged. The selected composition reuses canonical search, refinement and policy services without another infrastructure dependency. It adds read work over existing admitted data; large-corpus latency/load is not measured and must be evaluated before scale-up.

Synthetic PostgreSQL, OIDC, real loopback provider HTTP, MCP SDK, durable replay and browser tests establish connected behavior and failure boundaries. They do not establish natural-language relevance, citation support beyond exact text, real company model compatibility, knowledge-quality improvement or downstream agent performance. Those effects remain goals subject to docs/EVALUATION.md controlled experiments. Runtime wiki policy version is unchanged; this server contract does not activate every long-term target in wiki/SCHEMA.md.
