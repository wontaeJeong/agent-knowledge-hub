# Native search index operations (Task1c)

SRH-006/008, with SRH-001/002/004/007 compatibility. Migration121 adds a PostgreSQL GIN body index, transaction-bound content mutation observations, recorded maintenance outcomes and a fixed index operation in existing durable grants/workers. No new service, Pod or model call.

## Retrieval and observations

ScopedSearch body candidates use parameterized literal LIKE on lower(version content), escaping percent/underscore and the explicit escape character. Korean text, code, punctuation and backslashes retain substring semantics. Current source/dependency ACL and historical metadata checks still gate every output. This index accelerates body candidates; titles/metadata retain existing filters. Small tables or short patterns may use other plans. [PostgreSQL17 pg_trgm](https://www.postgresql.org/docs/17/pgtrgm.html).

Native index maintenance and the workspace observation trigger run in the same transaction as versions mutations. Rollback preserves both. Observation timestamps are database statement observations visible after successful commit, not independently measured commit or knowledge-verification timestamps. Status returns catalog readiness, actual bytes, content observations, the last recorded index creation/rebuild success and recorded failure. Background lag is not measured; lagSeconds is null. Catalog flags are not a physical corruption detector.

## Fixed administrative operation

Physical maintenance affects the database-wide index. Admission requires configured AKH_PLATFORM_OPERATOR_IDS membership plus the current space Admin role through a verified human login session. Bare contexts, PATs, service/delegated jobs and legacy agent keys cannot substitute. The payload accepts no table/index/SQL/model override. Schedules are rejected.

A server-minted one-operation index grant binds the existing same-human parent session. Execution validates that exact grant/session, then separately checks the human's current Admin role and configured operator membership for this fixed operation. Its credential retains only ordinary read/propose actions and grants no general Admin delegation. Revocation is checked before effects and result reads.

The existing maintenance worker executes REINDEX, or CREATE INDEX when missing. Index replacement, success metadata and retry checkpoint commit atomically. Failure rolls back replacement and preserves prior index/last success; a separate authorized transaction records safe failure metadata. If revocation prevents that write, the actual failed job remains visible under current policy. Successful checkpoint replay avoids repeating the physical effect. UI confirmed dead/cancelled retries get new keys; uncertain admission/network/poll results retain their keys.

Non-concurrent REINDEX supports the required single transaction. It can briefly block writes/index readers; existing5s lock and15s statement bounds apply. Large work may fail safely. Concurrent REINDEX requires multiple transactions and is not silently substituted. [PostgreSQL17 REINDEX](https://www.postgresql.org/docs/17/sql-reindex.html).

GET /api/v1/search/index returns guarded status. POST /api/v1/search/index/rebuild accepts only {idempotency_key}, returns202 durable acknowledgement/trace and uses existing job controls. The compact jobs-console panel displays observations separately from completion. Extension operator classes are qualified by actual extension namespace; object names are derived and quoted by PostgreSQL from the resolved versions schema, including isolated-schema upgrades.

## North Star and validation

The change improves safe Query access and maintainability of a derivative index. It changes no sources, conclusions, reviews, approvals or publications. Exact current ACL/source ceilings remain outside candidate selection. A real10,000-version EXPLAIN ANALYZE fixture proves the actual candidate SQL uses the GIN index; it is not a company workload benchmark or downstream performance evidence.

Native tests cover literal Korean/code matching, current source revocation, committed/rolled-back observations, actual lock-failure rollback/recovery, missing-index recreation, identity/Admin revocation, operator/role/PAT/session ceilings and actual OIDC HTTP/CSRF/strict inputs. Existing runtime, policy, historical search, release-upgrade, erasure and storage graph regressions run. Actual1440/390 browser captures use explicitly labeled synthetic UI replies; real SQL/HTTP execution is separate. Large-index performance, corruption detection and production operating acceptance remain unverified.
