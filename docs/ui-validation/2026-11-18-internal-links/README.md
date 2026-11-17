# C8 internal links: current local evidence

All results are synthetic local acceptance, not production IdP, scale, semantic quality or OS accessibility acceptance. Existing251 requirements and North Star are unchanged.

Current post-final CI-fix run: **1440x1000 and390x844, each light/dark**, real Chromium/canonical HTTP/PostgreSQL,20PNG. Runtime 2026-11-17T20:10:00.012Z; frontend 2026-11-17T20:10:11.245Z; complete 2026-11-17T20:11:10.039Z. Production fingerprint **93d89a4896dd4cdd702e08c23db4ff8c202bb3cd1d51ac9b83d2e3b1a68a9de9**. Current log: c8-postreview-browser.log (exit0).

The explicit synthetic actor adapter supplies editor/reviewer identities; it is not real production OIDC. Browser route forwarding returns actual canonical HTTP responses without fabricated successful DTOs. Rename/revocation are controlled canonical DB fixture mutations, while suggestion selection, autosave, approval/publication and subsequent navigation/backlink reads use real services. Korean composition is browser-dispatched composition events, not a physical OS IME.

Each configuration selects leaf from two same-title choices using ArrowDown/Enter, preserves editor focus, inserts the stable ID URL and persists its dependency version. Draft backlinks are empty; review/approval/publication creates the edge. The existing label opens the renamed target via unchanged ID. Source revocation plus focus refresh removes the backlink, confirmed by canonical API. No horizontal overflow or page errors. Four representative final images were visually inspected; existing long page layout remains.

| Configuration | Suggestions | Published backlinks after rename | After source revocation |
| --- | --- | --- | --- |
|1440 light|[image](1440-light-suggestions.png)|[image](1440-light-backlinks.png)|[image](1440-light-revoked.png)|
|1440 dark|[image](1440-dark-suggestions.png)|[image](1440-dark-backlinks.png)|[image](1440-dark-revoked.png)|
|390 light|[image](390-light-suggestions.png)|[image](390-light-backlinks.png)|[image](390-light-revoked.png)|
|390 dark|[image](390-dark-suggestions.png)|[image](390-dark-backlinks.png)|[image](390-dark-revoked.png)|

[Actual assertions/request paths](browser-results.json), [cleanup](cleanup.json), [source/harness/regression/artifact/log SHA manifest](source-manifest.json). Own DBs/profiles are absent, ports4398/5198 closed, owned processes40043/40118/40177 absent; parent knowledge_test PostgreSQL remains alive. No cleanup of other agents' resources.

Current verification: fullcheck494frontend +48Node +16import +41evaluation +251criteria +server types/build/static smoke; current native8files101tests, all exit0. Earlier runtime/discovery/clock/restore/versions/C7/lineage runs are carried, not aggregated. CI44161579437 at44d73b97 failed all4 storage-graph tests; clean3b8f310 passed4 and scoped final source passes4 unchanged. Current new routing/canonical/retention tests3 pass. Detailed RED/intermediate outcomes remain in task-8-report. Earlier browser attempts and original discovery-clock defect remain historical.

Reproduce from repository root with Node24 and a localhost synthetic TEST_DATABASE_URL:
```sh
AKH_C8_SYNTHETIC_CAPTURE=1 node --import tsx docs/ui-validation/2026-11-18-internal-links/links-runtime.ts
node docs/ui-validation/2026-11-18-internal-links/manifest.mjs --frontend-start
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort
AKH_C8_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node docs/ui-validation/2026-11-18-internal-links/capture.mjs
# SIGTERM only the owned runtime/frontend; runtime drops its exact owned DB.
node docs/ui-validation/2026-11-18-internal-links/manifest.mjs
node docs/ui-validation/2026-11-18-internal-links/manifest.mjs --verify
```

The historical discovery probe is preserved verbatim in discovery-clock-probe.mts: baseline is a read-only git archive at /private/tmp/akh_c8_baseline_probe from3b8f310, with node_modules symlink to this isolated worktree. It creates/drops exact own PG databases. Its recorded C8 source predates the clock fix; rerunning now is not the same historical result. No original checkout modification was used.

Rulings/costs: canonical version metadata plus disposable ID index preserves portability and current authorization; legacy rebuild now changes only the derived version-keyed index, preserving every existing version byte/hash, approved work and answer envelope. The earlier enrichment/invalidation ruling was incorrect and is superseded by round1. Batches100 are resumable; read candidate bound10000 fails explicitly, and full-state/digest work plus final authorization projection repeats have unmeasured scale cost. Unknown sourceBlockId stays null for future C9. Existing relation/citation privacy engines are reused. Large Vite chunk warning remains. Model calls in clock tests use an actual local HTTP synthetic provider and make no quality claim.


Round1 current capture adds actual content-only restore after link removal. The author selects only content and explicitly supplies the reviewed historical body; preview shows the induced leaf relation. The independent reviewer sees that same disclosed ID and uses actual UI approve/publish, producing v4. All four configurations pass;20PNG total. Earlier source-manifest/browser-results/cleanup are preserved under round0/ and are historical, not current-byte verification.

| Configuration | Restore preview | Independent reviewer |
| --- | --- | --- |
|1440 light|[image](1440-light-restore-preview.png)|[image](1440-light-restore-review.png)|
|1440 dark|[image](1440-dark-restore-preview.png)|[image](1440-dark-restore-review.png)|
|390 light|[image](390-light-restore-preview.png)|[image](390-light-restore-review.png)|
|390 dark|[image](390-dark-restore-preview.png)|[image](390-dark-restore-review.png)|

EDT-001 full export roundtrips, KNO-007 precedence and KNO-010 merged-document redirects/reasons remain cross-feature acceptance, not proved by C8. C12 operational acceptance tracking remains unchanged. The preceding round1 fourteen-file183 run included migration/approved-work/prior-answer preservation, restore, discovery/refile, retention/legal-hold/erasure and C7 HTTP/MCP origin guards. The earlier20files302 is prior-head evidence, not added to current counts.


Authoritative final preview persistence: the first restore projection is pure across external identity refresh; only the final current canonical projection writes its returned receipt. Generic VersionService.run is unchanged; no preview or business mutation is replayed. Exact reviewer detail is re-read after refresh. Actual PG changed-data test proves one fresh receipt and successful approve/publish; final ACL-refresh tests reject stale preview/detail disclosure.

Historical prior native log c8-r1-single-write-native.log:6files50 passes (rebuild4, discovery15, clock2, runtime12, restore11, versions6). The prior eight security/retention/C7 files134 are carried separately. Final fullcheck c8-r1-single-write-check.log494/48/16/41/251/types/build/smoke exit0; existing chunk warning. Intermediate c8-r1-browser and c8-r1-final-browser captures do not claim final-byte verification. The fresh postreview20PNG and source-manifest are authoritative. Prior captures and README are preserved under round1-before-ci-fix/.


Post-final CI ruling: Source.targetPageId is a routing hint, not provenance. Erasure/hold dependencies recognize only exact published version linkReferences and published_page_links endpoints. Generic existing page references remain. Retention retains historical target IDs without fetching labels/body; erasure redacts labels while preserving canonical IDs for recovery. Actual-PG differential probe is retained verbatim as storage-scope-probe.mts; its head path was44d73b97 at capture and rerunning on fixed source is not the same historical result. Baseline archive is /private/tmp/akh_c8_storage_base_3b8f310; parent PG retained. First new-test fixture column error and intermediate retention omission are recorded honestly, not counted as meaningful green. Current physical-storage suite4 and new scoped-graph suite3 prove the repair without weakening existing fixtures/assertions.
