# Task 8 UI evidence — 2026-11-16

Actual headless Chromium against the Vite React application on loopback, 1440×1000 and 390×1000. All API responses in these captures are explicitly synthetic browser route fixtures, including identities, capabilities, subscriptions and events. These images verify rendering and navigation targets; authenticated HTTP/PostgreSQL behavior is tested separately in `server/runtime/subscription-host.test.ts` and `server/collaboration/events.test.ts`. No external email was sent.

- [Desktop notifications](notifications-1440.png), [mobile notifications](notifications-390.png): current category/space subscriptions, publication/review/expiry/failure meanings, read and processed state.
- [Desktop expiry](expiry-1440.png), [mobile expiry](expiry-390.png): UTC validity end and reason/CAS protected setting controls.

Both viewports reported no document horizontal overflow and no browser page errors. Wide history tables retain their existing internal horizontal scrolling.
