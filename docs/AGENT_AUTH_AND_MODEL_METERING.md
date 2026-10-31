# Agent credentials and provider usage contract

Date: 2026-10-31. Scope: agent-knowledge-hub latest main. This is an implementation specification, **not** a production security approval.

## Requirements and acceptance matrix

| ID | Requirement | Implementation | Deployment acceptance |
| --- | --- | --- | --- |
| AUTH-01 | 1–90 day API keys | SHA-256 digest in DB, random 32-byte secret, one-time token response, read/write scopes and owner+space binding | No raw secret in GET, logs, exports, dashboards, or database |
| AUTH-02 | Key management | Name, id/suffix, issuer, issue/expiry/revocation/last-use, 30-day request count and active days, own-key revocation; space Admin sees all keys and may revoke them with a persisted reason | Cross-owner and cross-space mutation blocked; legacy reviewer is not silently Admin |
| AUTH-03 | MCP/REST | Strict allowlist. Read allows pages/sources/search/jobs; write adds query/ingest/lint | Never grant approval, publication, administrative API, user directories, boards, import uploads or usage exports |
| AUTH-04 | Device Code | Registered client, 8-character human code, 10 minutes TTL, 5 seconds polling, approval/denial, one-time token exchange | No double issuance, disabled client cancels pending grants and revokes connected keys |
| AUTH-05 | Current permissions | Recheck live DB membership, principal enabled flag and revoked key on every request/mutation | Account/group revocation feed to DB must be verified before enabling machine auth |
| MOD-01 | On-prem and Bedrock via LiteLLM | Same OpenAI-compatible wiki model contract. LiteLLM routes its model aliases to vLLM or Bedrock; no AWS credentials in Hub | Verify actual configured routes in STG; assign backend=bedrock only to a pinned non-fallback route |
| MOD-02 | SystemOne | Separate reviewer-only, opt-in probabilistic review of a published page, never a text generator | Verify actual SystemOne API contract and scoring; scores never trigger publication |
| MET-01 | Per-call actual usage | Provider, backend, model/deployment, operation, principal, workspace, latency, success, input/output/cache tokens, cost when reported | Do not store prompts, raw model input, completions, keys, private URLs or raw model responses |
| MET-02 | Honest analytics | 7/14/30/90-day scoped summary, per-model rows, CSV, denominator for reported tokens/cost | Unreported count and cost remain null; zero only when actually reported |
| OPS-01 | Safe launch | Migration 009 through separate migration Job, agent credentials disabled by default | SSO revocation sync, rate limiting, TLS, key rotation, secrets, audit and rollback reviewed |

## Device Code REST sequence

1. A logged-in human registers a named client using POST /api/v1/credentials/clients.
2. That client requests POST /api/v1/device/authorize with JSON clientId and read/write scope. Receives opaque deviceCode, 8-digit-or-letter userCode, verificationUri, expiresIn=600 and interval=5.
3. Human opens verificationUri, logs in using SSO, checks the client/scope and calls GET /api/v1/device/verify/{userCode}, then POST /api/v1/device/decision with JSON userCode and approve=true/false. Web mutations require same-origin and CSRF.
4. Client polls POST /api/v1/device/token using opaque deviceCode. Pending is 202, too-fast polling is 429, expired/denied/consumed is rejected. Approved grant yields a 90-day bearer token once.
5. Client sends Authorization: Bearer akh_sk_... to approved REST/MCP methods. The token never grants a higher space role or approval/publish permission than its current owner. A client disable action revokes its keys.

## Provider usage

OpenAI-compatible and LiteLLM responses are normalized from usage.prompt_tokens, usage.completion_tokens, prompt_tokens_details.cached_tokens and cache creation fields if provided. The trusted LiteLLM response header x-litellm-response-cost supplies reported USD cost. x-litellm-model-id identifies a deployment, **not** a proven Bedrock/onprem backend. Dynamic routes must be labelled unknown. Cache-read and cache-write may overlap with input totals; do not add twice. Usage reports may be partial: measured-call and priced-call denominators must be shown.

Amazon Bedrock Converse has its own inputTokens/outputTokens/cacheReadInputTokens/cacheWriteInputTokens shape; the Hub's Bedrock integration is through a configured LiteLLM route, not a direct Converse SDK. This is deliberate to keep enterprise credentials and provider routing in one proxy.

SystemOne uses a distinct server-only endpoint and fixed NOUL question. It is not interchangeable with generative wiki LLMs and cannot issue an approval or automatically publish.

## Server configuration

- AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED=true (defaults false until SSO deprovisioning accepted)
- AGENT_KNOWLEDGE_HUB_LLM_PROVIDER=openai or litellm; default openai
- AGENT_KNOWLEDGE_HUB_LLM_BACKEND=unknown, onprem, bedrock or external; set only on pinned trustworthy routing, unknown by default
- Existing server-only LLM_BASE_URL, LLM_MODEL, LLM_API_KEY and LLM_ALLOW_TRANSMISSION=true
- AGENT_KNOWLEDGE_HUB_SYSTEMONE_BASE_URL, SYSTEMONE_MODEL, SYSTEMONE_API_KEY, SYSTEMONE_ALLOW_TRANSMISSION=true, optional SYSTEMONE_REVIEW_THRESHOLD in [0,1].

Never place secrets or raw conversation contents in a VITE_ variable or public GitHub source.

## Known limitations / required independent acceptance

- The current OIDC browser session validates live IdP UserInfo. Long-lived bearer keys use live DB membership, access-principal enabled state, and explicit key revocation, but **do not query the IdP for group status on every key request**. Before enabling bearer keys, integrate and operationally verify SSO account/group deprovisioning into database principals and grants. Default disabled protects deployments lacking this.
- SystemOne scoring semantics and the actual Bedrock backend route require real-provider synthetic test data and approval; local tests do not prove external availability, billing or data classification compliance.
- First-phase storage and import worker are not validated for 30k concurrent users or multiple replicas. Migration/backup, rate limits, retention and network egress policies require the existing release checklist.
