# Semantic search UI evidence

Actual Chromium rendering of QuestionsWorkbench and application CSS at1440x1000 and390x844 on2026-11-16. A temporary local Vite harness supplied explicitly labeled synthetic UI responses; images do not claim company data, model quality or complete browser-to-provider execution. Real configured provider HTTP, credential, source policy, queue and budget execution are separately tested by server/questions/semantic-search.test.ts.

- [Desktop selection](desktop-1440.png)
- [Mobile selection](mobile-390.png)
- [Desktop unconfigured failure](unconfigured-1440.png)
- [Mobile unconfigured failure](unconfigured-390.png)

Checked: mode/query interaction; running/succeeded states; returned provider/model; relevance proposal/quote; unconfigured failure clears old results; text wrapping and no horizontal overflow (viewport1440/document1425, viewport390/document375, excluding vertical scrollbar). No real tokens/accounts/private data. Harness removed after capture. Worktree screenshot writes were refused by browser tool allowed-root policy; captured to its allowed ignored output then copied here. Ambiguous selectors were corrected before the actual failure-state capture.
