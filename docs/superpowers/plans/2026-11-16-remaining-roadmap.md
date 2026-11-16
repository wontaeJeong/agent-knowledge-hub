# Remaining roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development; independent feature branches only.

**Goal:** Implement and merge every feature from the approved audit roadmap as separate reviewable PRs.

**Architecture:** Existing canonical TypeScript/PostgreSQL services and React clients; one app Pod and one DB Pod.

**Tech Stack:** TypeScript, React, PostgreSQL, Vitest, Node24.

**Spec:** ../specs/2026-11-16-remaining-roadmap-design.md

**Global Constraints:** Preserve AGENTS and North Star invariants. No fabricated real fixtures/model success. No permission prompts; user authorizes feature PR creation and merge. Native worktree first. UI screenshots at 1440/390.

**Review Focus:** Revoked source/identity must not leak through search/cache/presence; stale base or approval cannot publish; retries never duplicate; imports cannot broaden ACL; failures and missing configuration stay visible.

### Task 1: Unified search and recommendation

**Files:** server/agents/service.ts, server/runtime/mcp.ts, server/questions/search.ts. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** SRH-001~008, CORE-009~010. Use currentRecommendation consistently; share scoped historical filtering without widening credential ceilings; semantic retrieval must be configured and honest, never fake semantic success.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 2: Document navigation and personal lists

**Files:** src/operational/workflows.tsx, server/workflows/service.ts. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** EDT-007/010, SRH-009/010. Provide document outline, find and position navigation, link completion/backlinks, favorites/recent and bounded neighborhood navigation under current ACL.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 3: Document presentation and attachments

**Files:** src/ui, src/operational/storage.tsx, server/storage. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** EDT-001/008/009. Safe image attachments and previews, math and Mermaid rendering with external execution disabled and explicit supported formats.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 4: Bulk document edits

**Files:** server/workflows, src/operational/workflows.tsx. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** EDT-012. Preview authorized tag/move/archive targets, CAS execution and explicit per-target outcomes and retries.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 5: Knowledge lineage and feedback

**Files:** server/runtime/knowledge.ts, server/refinement/service.ts, server/publication.ts. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** KNO-002~006/013/014. General ingest candidates maintain source lineage; correction impact and review rejection reasons inform later proposals; preserve review and independent verification distinctions.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 6: Question scope and context

**Files:** server/runtime/schema.ts, server/questions, server/agents/service.ts. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** QNA-004, CORE-010. User selects topic and current/historical scope; inject applicable claims, exceptions and validity without expanding ACL or context budgets.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 7: Weekly knowledge maintenance

**Files:** server/jobs/runtime.ts, server/refinement. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** MGR-003/004. Weekly topic consolidation, duplicate/gap/staleness candidates differ from daily; monthly owner/retention/cost review is proposal-only.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 8: Subscriptions and event notifications

**Files:** server/collaboration, server/workflows, server/publication.ts. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** CLB-004~006. Add topic/space subscriptions and publish/review/expiry/failure events, dedupe and reauthorize before notification content.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 9: Share descendants and impact preview

**Files:** server/access/index.ts, src/operational/access.tsx. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** SHR-007. Explicit fixed descendant selection and audience impact preview, never expose future descendants automatically.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 10: Lossless export import

**Files:** server/storage/service.ts, server/storage/imports.ts. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** LIF-008/009. Versioned tree/properties/historical metadata export and reviewed import, preserve current ACL and avoid blindly applying imported permissions.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 11: Granular deletion retention

**Files:** server/operations/erasure.ts, server/retention. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** LIF-005, VER-012. Support individually attributable data and reviewed pruning with legal holds, shared ancestry and recovery replay preserved.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 12: Local new-source knowledge loop

**Files:** scripts/wiki-connector, server/agents. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** KI integration, CORE-009. Register new personal sources through common service then ingest/query/lint and review proposals under scoped credentials, without daemon.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 13: Realtime collaborative editing

**Files:** server/workflows, src/operational. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** VER-011. Authenticated bounded concurrent editing, presence, explicit save state, revocation disconnect and protected draft publication boundary.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 14: Scheduled publication

**Files:** server/jobs, server/publication.ts, src/operational. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** REV-011. Preview schedule, cancel and recheck current permission, reviewed content and base versions at execution; no stale approval reuse.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 15: Additional tool collector adapters

**Files:** server/storage/trusted-collector.ts. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** COL-004. Support another explicit tool version only with real anonymized fixture and trusted session binding. Unsupported formats remain explicit errors.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 16: Inbound Webhook integration

**Files:** server/runtime, server/integrations. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** INT-004. Signed timestamped events with replay protection, idempotence, ordering and retry/dead-letter workflows under explicit service grants.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 17: Source system synchronization

**Files:** server/integrations. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** INT-008. Approved Git or messenger adapter synchronizes source content, deletion and access changes with provenance and re-review.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 18: Directory provisioning

**Files:** server/identity. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** IAM-007. Authenticated SCIM or directory-event provision/update/disable with group removals and session/token revocation, no inferred admin grants.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

### Task 19: Policy controlled audiences

**Files:** server/policy/features.ts, server/access. Add focused domain/integration tests adjacent to implementation. Update docs/AGENT_HANDOFF.md and CURRENT_STATUS.md with exact scope and limits.

**Requirements:** SHR-010~012. Company readers, expiring isolated guests and separately published/revocable anonymous links activated only by explicit policy; source upper bounds remain enforced.

**Interfaces:** Consume existing canonical authorization, source snapshots, transaction and publication APIs; produce an authenticated connected API and user flow where applicable, retaining existing DTO compatibility.

- [ ] Step 1: Read current implementation and requirement acceptance; write regression for requested successful behavior and current-ACL/stale/retry failure.
- [ ] Step 2: Run targeted regression and verify failure before implementation.
- [ ] Step 3: Implement connected behavior using existing services; record exact API decisions in feature-specific design notes.
- [ ] Step 4: Run targeted regression, npm run check and relevant native HTTP/DB tests; capture changed UI in actual browser.
- [ ] Step 5: Commit, independent spec/code review, fix findings, create feature PR, verify final CI and merge; refresh main before dependent task.

