# Remaining product roadmap design

User authorization (2026-11-16): implement every remaining roadmap item as individual PRs, validate and merge all; use recommended decisions and ask no questions. Scope includes the prior audit table and its expansion/optional list. Existing PR32–43 are merged at main 5218828; PR30 discovery remains separate.

Keep existing TypeScript/PostgreSQL/React architecture; first release is one node, one app Pod and one DB Pod with minimal resources. Do not add mandatory infrastructure services. Preserve North Star, current ACL/source ceilings, immutable sources, reviewed version-bound atomic publication, idempotency, legal holds and honest model/verification status. Optional audiences are opt-in with safe defaults. No production deployment or external messages are authorized by this request.

Approaches: extend existing canonical services (selected, lowest resource cost); separate services would duplicate authorization and require more Pods; replacing the application would discard established contracts. Recommended decisions are implementation choices, not changes to North Star.

Each feature is a separate worktree/branch/PR. Meaningful domain and native HTTP/DB regressions, npm test, requirements, server typecheck and build precede review and merge; changed UI requires actual 1440/390 screenshots. Do not describe a module or mock as a complete connected feature.

Evaluation: test each behavior and failure boundary; actual model quality and downstream business effects remain claims requiring controlled experiments.

- 1. Unified search and recommendation: SRH-001~008, CORE-009~010. Use currentRecommendation consistently; share scoped historical filtering without widening credential ceilings; semantic retrieval must be configured and honest, never fake semantic success.
- 2. Document navigation and personal lists: EDT-007/010, SRH-009/010. Provide document outline, find and position navigation, link completion/backlinks, favorites/recent and bounded neighborhood navigation under current ACL.
- 3. Document presentation and attachments: EDT-001/008/009. Safe image attachments and previews, math and Mermaid rendering with external execution disabled and explicit supported formats.
- 4. Bulk document edits: EDT-012. Preview authorized tag/move/archive targets, CAS execution and explicit per-target outcomes and retries.
- 5. Knowledge lineage and feedback: KNO-002~006/013/014. General ingest candidates maintain source lineage; correction impact and review rejection reasons inform later proposals; preserve review and independent verification distinctions.
- 6. Question scope and context: QNA-004, CORE-010. User selects topic and current/historical scope; inject applicable claims, exceptions and validity without expanding ACL or context budgets.
- 7. Weekly knowledge maintenance: MGR-003/004. Weekly topic consolidation, duplicate/gap/staleness candidates differ from daily; monthly owner/retention/cost review is proposal-only.
- 8. Subscriptions and event notifications: CLB-004~006. Add topic/space subscriptions and publish/review/expiry/failure events, dedupe and reauthorize before notification content.
- 9. Share descendants and impact preview: SHR-007. Explicit fixed descendant selection and audience impact preview, never expose future descendants automatically.
- 10. Lossless export import: LIF-008/009. Versioned tree/properties/historical metadata export and reviewed import, preserve current ACL and avoid blindly applying imported permissions.
- 11. Granular deletion retention: LIF-005, VER-012. Support individually attributable data and reviewed pruning with legal holds, shared ancestry and recovery replay preserved.
- 12. Local new-source knowledge loop: KI integration, CORE-009. Register new personal sources through common service then ingest/query/lint and review proposals under scoped credentials, without daemon.
- 13. Realtime collaborative editing: VER-011. Authenticated bounded concurrent editing, presence, explicit save state, revocation disconnect and protected draft publication boundary.
- 14. Scheduled publication: REV-011. Preview schedule, cancel and recheck current permission, reviewed content and base versions at execution; no stale approval reuse.
- 15. Additional tool collector adapters: COL-004. Support another explicit tool version only with real anonymized fixture and trusted session binding. Unsupported formats remain explicit errors.
- 16. Inbound Webhook integration: INT-004. Signed timestamped events with replay protection, idempotence, ordering and retry/dead-letter workflows under explicit service grants.
- 17. Source system synchronization: INT-008. Approved Git or messenger adapter synchronizes source content, deletion and access changes with provenance and re-review.
- 18. Directory provisioning: IAM-007. Authenticated SCIM or directory-event provision/update/disable with group removals and session/token revocation, no inferred admin grants.
- 19. Policy controlled audiences: SHR-010~012. Company readers, expiring isolated guests and separately published/revocable anonymous links activated only by explicit policy; source upper bounds remain enforced.
