# Reviewed archive round trip (LIF-008/009)

The change preserves connected knowledge when an authorized export is reviewed and reintroduced. It improves the source → proposal → independent review → atomic publication loop without changing the North Star, treating an imported approval as current authority, or claiming improved knowledge quality or downstream agent performance. Those effects remain evaluation targets.

## Contract

`POST /api/v1/storage/export` emits `akh-export` version 2. The existing authenticated export/import/proposal endpoints remain unchanged; version 1 archives remain readable with their previous content-proposal semantics. Version 2 pages include current operational metadata and `history`:

- `snapshots`: the original immutable local version metadata, hashes, anchors, actor and capture instant. A missing snapshot remains unknown.
- `events`: metadata-only before/after records, actor, reason and instant.
- `importedEvidence`: original page bodies/versions/metadata, source metadata, original attachment metadata and old-to-new source/blob/slot ID maps from a previously published import, labelled `trust: unverified-import`. Selective review follows immutable decision lineage to retain this evidence. These records are not inserted into the canonical versions or version metadata tables and never authorize a historical claim.

Export includes the closure of current links/tree/provenance **and historical metadata dependencies**. All resources and attachment bytes require current access and current source egress policy; inaccessible historical dependencies reject the archive rather than disappear. Current access is checked again after filesystem reads.

`POST /api/v1/storage/import` validates and quarantines an archive. `POST /api/v1/storage/imports/:id/propose` creates a pending ordinary canonical changeset and immutable server-generated metadata plans. The reviewed latest body, facts, links, title, summary, category, tags, custom properties, environment and actual parent form the restored current document. Unchanged metadata is frozen too. A parent is a tree edge rather than an extra link in version 2. Property/type requirements, current bases/settings/policy, independent approval and final permissions are checked through the canonical publication path. A combined proposed/current parent graph cannot contain a cycle.

Existing pages preserve current scope, readers, ownership, protection, workflow policy (including review deadlines), and lifecycle. Imported roles, permissions, official/verification labels, old approvals and timestamps cannot grant current authority. Newly created IDs remain restricted to the owning human's personal namespace: sources/pages are private and unverified, publication starts a new local version sequence, and source egress permission is independently configured. New-page plans bind absence/base 0 and reject existing resources/settings collisions; delegated credentials cannot use that extension.

Attachments keep content hashes, byte content and logical revision history; imported logical/blob IDs may be remapped, and live body references are rewritten. Until a new page exists, a new attachment uses an authorized source ceiling. The canonical publication transaction validates every imported byte hash, scan state and attachment head, then moves **all revisions together** to their reviewed page parent only if the current page audience is no broader than the source ceiling. Failure rolls back page versions and all parent moves. Ordinary source snapshots without logical slots stay source snapshots. Duplicate staging/submission/publication retries use existing durable idempotency records.

## Boundaries

- Archives are limited to the selected workspace; this does not add cross-space migration or imported permission installation.
- Existing limits remain: 5 MiB archive, 100 pages/sources/blobs, 20 proposed pages. History permits 100 captured snapshots, 1,000 metadata events and 100 imported evidence records per page; nested history traversal is bounded and fails explicitly rather than truncating. Repeated archive nesting can reach these limits.
- Version 1 compatibility is not a retrospective guarantee of full property restoration. Current version history displays local publications; imported past history is preserved as inspectable/re-exportable evidence, not promoted to locally confirmed versions.
- Original raw source metadata such as licensing remains in archive evidence; newly registered live sources use the safe canonical registration schema. No imported egress, scan approval or verification is accepted.
- No new service, database, Pod, migration or client interface is required. The first release remains one node, one app Pod and one DB Pod. This feature changes no UI and requires no new screen capture.
- Native regression data and the loopback OIDC provider are synthetic. Passing HTTP/PostgreSQL tests is not company IdP, sensitive-data, model quality, production load or operational acceptance.

## Verification

The adjacent native PostgreSQL tests exercise real staging/proposal/approval/publication, metadata/fact/tree restoration, safe new personal IDs, historical access, imported evidence after selective review, stale metadata, exact retries, new attachment chains/source snapshots and publication-time scan/head changes. An authenticated runtime HTTP test covers DB sessions, OIDC UserInfo, CSRF, export/import/propose/review/publish, two attachment revisions and access revocation. Test-only identity/provider fixtures do not replace the actual runtime handler or database.

Exact final commands and remaining limits are recorded in AGENT_HANDOFF and the feature PR. No evaluation effect or company operations acceptance is asserted.
