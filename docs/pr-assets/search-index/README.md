# Search index UI evidence

Actual Chromium rendering of SearchIndexPanel and application CSS at1440x1000 and390x844 on2026-11-16. The local temporary harness supplied explicitly labeled synthetic status/job replies. Images demonstrate the component and controls; real PostgreSQL, OIDC, CSRF, policy, queue, index plan and rebuild failure/recovery are validated separately in server/search/index.test.ts.

- [Desktop success](desktop-1440.png)
- [Mobile success](mobile-390.png)
- [Desktop failed rebuild](failure-1440.png)
- [Mobile failed rebuild](failure-390.png)

Checked actual pending/running/succeeded/failed UI paths, last success separate from mutation observation, failure code with preserved old success, and wrapped mobile text. Width390/document375 excludes the vertical scrollbar, with no horizontal overflow. No real accounts, tokens, source bodies or production database details. Temporary harness removed and Vite stopped after capture.
