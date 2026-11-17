# C10 actual browser evidence

Synthetic local Chromium, Node24.22.2 and PostgreSQL17. Actual viewports1440×1000 and390×844, light/dark. PNGs capture the changed elements at their actual responsive width; they are not mockups. Current `browser-results.json` binds the runtime production fingerprint and four completed scenarios. `manifest.mjs --verify` checks production, harness, regressions, screenshots, cleanup and logs.

| Environment | Property form + keyboard focus | Normalized preview | Partial result/current ACL |
| --- | --- | --- | --- |
| 1440 light | [form](1440-light-properties.png) | [preview](1440-light-preview.png) | [result](1440-light-partial.png) |
| 1440 dark | [form](1440-dark-properties.png) | [preview](1440-dark-preview.png) | [result](1440-dark-partial.png) |
| 390 light | [form](390-light-properties.png) | [preview](390-light-preview.png) | [result](390-light-partial.png) |
| 390 dark | [form](390-dark-properties.png) | [preview](390-dark-preview.png) | [result](390-dark-partial.png) |

Each scenario: block missing required environment; fill canonical fields; focus type and press real Tab to tags; capture; submit a reviewed proposal and verify canonical published tags remain empty. Select three synthetic targets, preview before/after, accept a real durable job, mutate one target's settings revision and revoke another's resource reader before actual worker tick. Refresh the real receipt and confirm applied/stale outcomes, omit revoked title/checkbox, preserve authorized selection and show a generic count-free removal notice. No horizontal overflow or page errors. The rest of the incumbent page is not presented as newly designed or independently audited.

`runtime.ts` is explicitly opted-in loopback-only test infrastructure, not production startup code. It creates random owned databases, real OIDC UserInfo/session DAO, canonical runtime HTTP handlers and real queue workers. Browser routing forwards actual HTTP responses with synthetic session cookies. The loopback synthetic tick only controls when the actual worker runs so permission/CAS races can be reproduced; responses are never mocked. No real account, company material, production credential or OS/IME/assistive-technology acceptance is claimed.

Run from repository root with Node24 PATH, TEST_DATABASE_URL pointing to synthetic loopback PG, AKH_C10_SYNTHETIC_CAPTURE=1 for runtime, and PLAYWRIGHT_MODULE for installed Playwright. Start Vite on5200/runtime4400, run capture.mjs, stop the exact owned processes and verify cleanup, then run manifest.mjs and manifest.mjs --verify. Never reuse parent/other-task databases or stop their server. `cleanup.json` records zero remaining owned databases, closed4400/5200 and a live parent PostgreSQL query.

Historical failed logs are retained in `.superpowers/sdd/2026-11-16-essential-convenience/c10-*.log`; only `c10-current-check`, `c10-current-native`, `c10-browser-current` and this final source manifest are the current final wave. Other native components and prior failures are explicitly separated in task-10-report.md. Existing Vite bundle-size warning remains.
