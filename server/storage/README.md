# Persistent content boundary

The host supplies an authenticated, selected-space `Context`, `Pool`, canonical app-owned PVC path, and **mandatory** transaction authorizer. No module starts or mounts an unauthenticated server. See `routes.ts` for the exact pure extension contract.

```ts
const service = new StorageService(
  pool,
  new FileBlobStore(blobRoot),
  authorizer,
);
const route = storageRoutes(
  service,
  new UrlCollector({
    enabled: false,
    approvedOrigins: [],
  }),
);
```

`blobRoot` is an explicit constructor configuration; the host may map `AKH_BLOB_ROOT` to it. No default temporary store exists. Mount a persistent filesystem there and keep it inaccessible to untrusted writers. Metadata in migration 021 and CAS files must be backed up/restored together. Keep all hashes referenced by `storage_blobs` **and** `storage_imports.manifest.stagedBlobs`; failed writes can leave unreferenced CAS objects, which are safe but require coordinated retention/GC, not eager deletion.

## HTTP hook

Pass `{method,path,body,ctx,send,req,res}` to the returned `handleStorageRoute`. `path` includes `/api/v1/storage/`. The host must perform authentication/session validation, CSRF, allowed-origin and selected-space resolution **before** calling it. For raw PUT, call before reading/parsing the body. Other JSON endpoints need a bounded host body parser (5 MiB maximum). Errors propagate to the host's safe error mapper. Never serialize native error paths or stack traces.

| Method/path suffix                      | Input / result                                                                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUT `blobs`                             | Raw stream; `X-Parent-Kind: page\|source`, `X-Parent-Id`, URI-percent-encoded `X-Filename`, exact supported `Content-Type`; returns random blob ID, SHA256, byte size, scan/extraction state                                       |
| GET `blobs/:id`                         | Current-parent/provenance-authorized attachment bytes, never inline HTML                                                                                                                                                           |
| GET `blobs/:id/local-copy`              | Requires **both** `local.copy` and `data.export` over complete ancestry                                                                                                                                                            |
| POST `blobs/:id/extract`                | Exact UTF8 text; unsupported PDF conversion explicitly denied                                                                                                                                                                      |
| POST `blobs/:id/ticket`                 | `{seconds:1..300}`; random principal-bound authenticated ticket, not a public grant                                                                                                                                                |
| POST `tickets/redeem`, `tickets/revoke` | `{token}`; expiry/revocation and current ACL checked again                                                                                                                                                                         |
| POST `list`                             | `{kind,id,offset?}`; deterministic 25-row pagination with total; all original rows retained                                                                                                                                        |
| POST `sources`                          | `{title,content,project,tool,targetPageId?,external?:{id,sessionId,version}}`; private immutable source+snapshot, server actor, no execution verification; event replay/stale versions deduplicated                                |
| POST `snapshot`                         | `{sourceId}`; immutable content hash snapshot; source correction never overwrites an earlier blob                                                                                                                                  |
| POST `export`                           | `{pageIds?,sourceIds?}`; `akh-export` version1 JSON with complete input closure, raw sources, page history, original ACL limits, file hashes/bytes and untouched metadata/license fields; requires explicit `data.export` policies |
| POST `import`                           | Version1 export manifest; verifies IDs, hash, formats, closure and limits; creates idempotent **private quarantined proposal**, no page/ACL overwrite or publication                                                               |
| GET `imports/:id`                       | Owner-only proposal with current bound-resource ACL rechecks; original scan verdicts **not trusted**; newly imported binary remains pending                                                                                        |
| GET `collectors`                        | Exact fixture-tested tool/version/format coverage; does not assert installation approval                                                                                                                                           |
| POST `collect-artifact`                 | `{artifact,tool,version,format,selectedIds,excludedSessionIds,title,project,targetPageId?}`; selected text becomes private unverified immutable source                                                                             |
| POST `collect-url`                      | `{url,parent:{kind,id}}`; requires source-create permission **before** network; approved-origin text stored as attachment, no arbitrary response proxy                                                                             |

## Security and actual caps

- Raw upload/download: 5 MiB per file, incrementally read and elapsed-time bounded (30 seconds), then at most 5 MiB buffered to validate and recheck ACL before commit/return. This is not an unlimited zero-copy streaming system.
- Import/export: **total JSON 5 MiB**, at most 100 pages/sources/blobs, at most 100 versions per imported page. Export fails rather than silently truncating ancestry or unscanned attachments.
- UTF8 text/Markdown/JSON: reject invalid encoding, control/binary camouflage and HTML markup. Exact extensions/MIME enforced. PDF signature/end marker checked; starts **pending**, cannot download/export/extract until a trusted scanner approves. No antivirus or PDF extraction is fabricated. Other MIME, archives, SVG, executable conversion are unsupported.
- `recordScan` is a direct trusted-adapter method, not an HTTP route. It requires deployment-specific `scan.manage` authorization and the expected hash. The common access service intentionally has no implicit scan capability; without a configured scanner binaries remain denied.
- External collection is **disabled unless explicitly configured**. Only exact approved HTTPS origins, no URL credentials/fragments/IP literals, public IPv4 DNS answers only, no mixed private answers, no IPv6, no redirects or compression. HTTPS lookup is pinned to the checked IP while retaining hostname TLS verification; DNS, response and body are bounded. Fixture fetch/resolver injection is for tests, not caller configuration.
- Imports preserve original IDs, history, source references, ACL lists, links and license metadata as untrusted evidence. Effective visibility is **only the importing principal**. Existing IDs are never overwritten; current ACL narrowing is enforced before storing and before reading proposals. An imported `clean` string does not approve a binary. The host workflow must consume proposals through its normal review/publication contract; importing never invokes publish.

## Integration boundaries / not claimed

The owning host must mount routes/UI, supply raw fetch with session/CSRF/space headers, mount PVC, configure approved origins/scanner and connect import proposals to its review workbench. The optional `StoragePanel` accepts `api`, `parent`, host-owned `transport`, capability booleans and `onChanged`. No persistent local crawler/daemon is added. Exact OpenCode2.2.2 synthetic-message and assistant-message (including explicitly selected completed tool outputs) formats are tested against actual redacted API fixtures described in `fixtures/README.md`. For assistant messages, supply `sessionId` and `selectedToolIds` in addition to the message `selectedIds`; no tool input, hidden reasoning, snapshot or native-provider field is persisted. Omission counts and author-statement/tool-output/mixed kind remain explicit, never independent execution approval. Project labels are explicitly `projectVerified:false`, not a fabricated external mapping. Whole-session export, other versions and installation approval are not claimed. Physical deletion, retention, encryption, backup restore and CAS garbage collection are the operational-release task, not silently simulated here. Attachment uploads preserve all immutable originals; there is not yet a replacement-head/version association API.
