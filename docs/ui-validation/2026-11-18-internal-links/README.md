# C8 internal links: current local evidence

All results are synthetic local acceptance, not production IdP, scale, semantic quality or OS accessibility acceptance. Existing251 requirements and North Star are unchanged.

Final run: **1440x1000 and390x844, each light/dark**, real headless Chromium and canonical RuntimeService/WorkflowService HTTP with PostgreSQL. Runtime started2026-11-17T19:06:39.302Z; frontend19:06:49.999Z; completed19:07:37.590Z. Production fingerprint **c42ec27c1a0794ad068379d7eaf9bdddbae43a875b0af7f3bb5d95c50bd72891**.

The explicit synthetic actor adapter supplies editor/reviewer identities; it is not real production OIDC. Browser route forwarding returns actual canonical HTTP responses without fabricated successful DTOs. Rename/revocation are controlled canonical DB fixture mutations, while suggestion selection, autosave, approval/publication and subsequent navigation/backlink reads use real services. Korean composition is browser-dispatched composition events, not a physical OS IME.

Each configuration selects leaf from two same-title choices using ArrowDown/Enter, preserves editor focus, inserts the stable ID URL and persists its dependency version. Draft backlinks are empty; review/approval/publication creates the edge. The existing label opens the renamed target via unchanged ID. Source revocation plus focus refresh removes the backlink, confirmed by canonical API. No horizontal overflow or page errors. Four representative final images were visually inspected; existing long page layout remains.

| Configuration | Suggestions | Published backlinks after rename | After source revocation |
| --- | --- | --- | --- |
|1440 light|[image](1440-light-suggestions.png)|[image](1440-light-backlinks.png)|[image](1440-light-revoked.png)|
|1440 dark|[image](1440-dark-suggestions.png)|[image](1440-dark-backlinks.png)|[image](1440-dark-revoked.png)|
|390 light|[image](390-light-suggestions.png)|[image](390-light-backlinks.png)|[image](390-light-revoked.png)|
|390 dark|[image](390-dark-suggestions.png)|[image](390-dark-backlinks.png)|[image](390-dark-revoked.png)|

[Actual assertions/request paths](browser-results.json), [cleanup](cleanup.json), [source/harness/regression/artifact/log SHA manifest](source-manifest.json). Own DBs/profiles are absent, ports4398/5198 closed, owned process21422/21491 absent; parent knowledge_test PostgreSQL remains alive. No cleanup of other agents' resources.

Current verification: fullcheck493frontend +48Node +16import +41evaluation +251criteria +server types/build/static smoke; native20files302tests, all exit0. Earlier logs are historical RED/intermediate evidence, not extra current tests. Browser1 failed on an incorrect autosave-label harness assertion; browser2 passed before later backend fixes; only final-browser is current. Native1 discovery failures were a real baseline clock defect; the withdrawn fixture-normalization proposal is retained, not applied.

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

Rulings/costs: canonical version metadata plus disposable ID index preserves portability and current authorization; latest-version backfill enriches metadata only but can invalidate old approval fingerprints/cursors. Batches100 are resumable; read candidate bound10000 fails explicitly, and full-state/digest work plus final authorization projection repeats have unmeasured scale cost. Unknown sourceBlockId stays null for future C9. Existing relation/citation privacy engines are reused. Large Vite chunk warning remains. Model calls in clock tests use an actual local HTTP synthetic provider and make no quality claim.
