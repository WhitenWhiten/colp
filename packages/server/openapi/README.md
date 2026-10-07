# Product OpenAPI build

`product-v1.yaml` is the only authored Product transport contract. Phase 1 froze
`/api/v1` at `info.version` **1.0.0**; the accepted Phase 2 publication contract
advanced it to **1.1.0** under
[ADR-0015](../docs/adr/0015-product-api-versioning-and-freeze.md). Do not change
paths, methods, operationIds, requiredness, enums, error codes, Node unions,
response fields, or Header/status/cache/concurrency/receipt semantics without
updating the governing ADR and compatibility baseline.

Phase 2B advanced the additive contract to **1.7.0**. Library Management LM-02
advanced it to **1.8.0** with authenticated owned Collection keyset paging, and
Profile settings advanced it to **1.9.0**; P3-36 advanced it to **1.10.0** with the narrow authenticated Product Sync Center. P5-05 advanced it additively to **1.11.0** with authenticated Follow/Unfollow and private followers/following pages. P5-13 advanced it to **1.12.0** with a private current-authorized Product Feed outside the route Manifest. P5-21 advances it additively to **1.13.0** with private Notification inbox, read-state, and in-app preference operations. MCP-W07 advances it additively to **1.14.0** with the private current-account MCP Write approval surface. P4A-P01 advances it additively to **1.15.0** with the owner-private Attachment product surface. PI-02 advances it additively to **1.16.0** with anonymous public-collection insight ingest. PI-03 advances it additively to **1.17.0** with the authenticated owner publishing insights dashboard. SC-02 advances it additively to **1.18.0** with authenticated collection member and invite operations. The Search Product API
adds a bounded `GET /api/v1/search` operation over the existing owner-controlled
`allowSearchIndexing` authority. Anonymous and Session projections have distinct
cache semantics, and conditional reads re-run current authority before 304.

Run `npm run openapi:ci` to lint the source, verify the operation catalog,
validate embedded schema examples, check generated artifact drift, and compare
the generated bundle with the compatibility snapshot. The same command also
compiles the generated-client usage fixture through `tsconfig.openapi.json`. Run
`npm run openapi:generate` only when an intentional contract edit requires new
generated artifacts.

## Baseline policy after freeze

| File | Role |
|---|---|
| `baselines/product-v1.0.1.0-draft.yaml` | Historical draft compatibility snapshot (pre-freeze). Keep immutable for audit; not the default breaking baseline. |
| `baselines/product-v1.1.0.0.yaml` | Immutable `1.0.0` post-freeze compatibility snapshot. |
| `baselines/product-v1.1.1.0.yaml` | Immutable accepted `1.1.0` compatibility snapshot and old-client evidence. |
| `baselines/product-v1.1.2.0.yaml` | Immutable accepted `1.2.0` Profile compatibility snapshot. |
| `baselines/product-v1.1.3.0.yaml` | Immutable accepted `1.3.0` Annotation/Relation compatibility snapshot. |
| `baselines/product-v1.1.4.0.yaml` | Immutable accepted `1.4.0` Saved Resource compatibility snapshot. |
| `baselines/product-v1.1.5.0.yaml` | Immutable accepted `1.5.0` Reading Progress compatibility snapshot. |
| `baselines/product-v1.1.6.0.yaml` | Immutable additive `1.6.0` Search-authority compatibility snapshot. |
| `baselines/product-v1.1.7.0.yaml` | Immutable additive `1.7.0` Search Product HTTP compatibility snapshot. |
| `baselines/product-v1.1.8.0.yaml` | Immutable additive `1.8.0` owned Collection list compatibility snapshot. |
| `baselines/product-v1.1.9.0.yaml` | Immutable additive `1.9.0` Profile settings compatibility snapshot. |
| `baselines/product-v1.1.10.0.yaml` | Immutable additive `1.10.0` Product Sync Center compatibility snapshot and P5-05 old-client evidence. |
| `baselines/product-v1.1.11.0.yaml` | Immutable additive `1.11.0` Follow Product API snapshot and P5-13 old-client evidence. |
| `baselines/product-v1.1.12.0.yaml` | Immutable additive `1.12.0` Feed Product API snapshot used by default by `npm run openapi:breaking`. |
| `baselines/product-v1.1.13.0.yaml` | Immutable additive `1.13.0` Notification Product API snapshot. |
| `baselines/product-v1.1.14.0.yaml` | Immutable additive `1.14.0` MCP Write Approval Product API snapshot. |
| `baselines/product-v1.1.15.0.yaml` | Immutable additive `1.15.0` owner-private Attachment Product API snapshot (P4A-P01). |
| `baselines/product-v1.1.16.0.yaml` | Immutable additive `1.16.0` anonymous public-collection insight ingest snapshot (PI-02). |
| `baselines/product-v1.1.17.0.yaml` | Immutable additive `1.17.0` owner publishing insights dashboard snapshot (PI-03). |
| `baselines/product-v1.1.18.0.yaml` | Immutable additive `1.18.0` collection member and invite snapshot (SC-02). |
| `baselines/product-v1.1.49.0.yaml` | News Digest private series/edition compatibility snapshot (ND-06 draft wave). |
| `baselines/product-v1.1.50.0.yaml` | News Digest public projection compatibility snapshot (ND-07 draft wave). |
| `baselines/product-v1.1.51.0.yaml` | News Digest Follow/timeline compatibility snapshot (ND-08 draft wave). |
| `baselines/product-v1.1.52.0.yaml` | News Digest schedule compatibility snapshot (ND-11 draft wave). |
| `baselines/product-v1.1.53.0.yaml` | Corrected News Digest public issue paging snapshot; supersedes the gated draft shapes. |
| `baselines/product-v1.1.54.0.yaml` | Safe followed-issue timeline snapshot with private source/revision fields removed. |
| `baselines/product-v1.1.55.0.yaml` | Corrected closed report schedule response snapshot; 1.54.0 remains immutable historical evidence. |
| `baselines/product-v1.1.56.0.yaml` | Additive public report issue source Collection slug snapshot. |
| `baselines/product-v1.1.57.0.yaml` | Additive private Sync Center trash list/item/restore snapshot. |
| `baselines/product-v1.1.58.0.yaml` | Additive private Sync Center bulk restore, subtree restore, and empty-trash snapshot. |
| `baselines/product-v1.1.59.0.yaml` | Additive optional LinkHealthItem errorClass and private duplicate_of review fields. |
| `baselines/product-v1.1.60.0.yaml` | Additive optional PublicCollectionNode tldr/note public curation marks. |
| `baselines/product-v1.1.61.0.yaml` | Additive optional curatorNote on ExploreCollectionItem and PublicCollectionSummary. |
| `baselines/product-v1.1.62.0.yaml` | Additive optional curator/followerCount/sourceCollectionSlug on PublicReportSeries and issueKey/editionOrdinal/periodStart/periodEnd on PublicReportIssue. |
| `baselines/product-v1.1.64.0.yaml` | Additive account-credential parent/child lifecycle, token exchange, identity, grants, and Plan authorization snapshot. |
| `baselines/product-v1.1.67.0.yaml` | Moderation tombstone contract (#21): hide_public rows stay listed as inert placeholders on digest surfaces — PublicReportIssue gains a tombstone state, ReportIssueTimelineItem.state gains 'hidden', and ReportSeries/ReportTimelineSeries gain optional hiddenPublic. |
| `baselines/product-v1.1.68.0.yaml` | #21 continued on Explore: ExploreCollectionItem.publicationSlug becomes nullable and optional hiddenPublic marks a hide_public tombstone; delist still excludes. |
| `baselines/product-v1.1.70.0.yaml` | Intentional operator-only bot credential correction: remove browser parent management; require parent keys for child/grant management and conceal invalid credentials with 404. ADR-0015 records acceptance. |
| `baselines/product-v1.1.69.0.yaml` | #21 continued on the follower Feed: FeedItemDto gains optional hiddenPublic — a hide_public collection_change row stays as a placeholder-titled tombstone with null publicationSlug instead of being omitted. |

P4A-P01 advances the contract additively to **1.15.0** with the owner-private
`/api/v1/attachments` resource family (issue, complete, status/private
metadata, finalize, replacement, retire, download admission). Physical keys
and provider URLs exist only inside the one-time opaque grant of the issue
response; Attachment error responses use the dedicated
`AttachmentErrorEnvelope`/`AttachmentErrorCode` machine contract (the frozen
shared `ProductErrorCode` enum cannot grow without a superseding ADR).
PI-02 advances the contract additively to **1.16.0** with
`POST /api/v1/public-collections/{slug}/insight-events`. PI-03 advances it
additively to **1.17.0** with `GET /api/v1/me/publishing-insights`. SC-02
advances it additively to **1.18.0** with collection member and invite
operations. The default
breaking check is pinned to `product-v1.1.18.0.yaml` with
`product-v1.1.17.0.yaml` retained as immutable old-client additive-diff evidence.

P5-21 keeps `product-v1.1.12.0.yaml` as explicit old-client additive-diff evidence; the default breaking check remains pinned to it while 1.13.0 is introduced.

News Digest report waves are intentionally kept after the historical 1.48.0
chain. The 1.49.0–1.52.0 files record the original gated implementation
shape for audit; 1.53.0 is the first corrected report compatibility snapshot,
1.54.0 removes private fields from followed-issue timeline responses,
1.55.0 corrects the closed schedule response schema, and 1.56.0 additively
exposes the public source Collection slug on public report issues. 1.57.0
additively exposes the private Sync Center trash list, item, and restore
commands. 1.58.0 additively exposes bulk restore, subtree restore, and
empty-trash with per-item results. 1.59.0 additively exposes optional
LinkHealthItem `errorClass`, `duplicateRelationId`, and
`duplicateRelationEtag` so LibraryHealth can classify cannot-probe rows
and undo a private `duplicate_of` review. The current
generated bundle is checked against the latest snapshot by `openapi:breaking`.

To intentionally re-seed the current compatibility baseline from the generated bundle (maintainers only; never in ordinary CI):

```sh
node scripts/seed-product-v1-freeze-baseline.mjs
```

The breaking checker rejects removed paths or methods, operation ID, parameter,
request, response status/header/security, and existing schema/required/enum
changes. A deliberate incompatible change must update the governing contract and
ADR before refreshing the current snapshot. Historical snapshots stay
immutable. Additive endpoints and non-breaking optional headers still require
OpenAPI diff and contract tests.

Redocly's 2xx/4xx response, license, and unused-component rules are disabled
with reasons in `redocly.yaml`: OIDC callback maps both success and failure to
browser `303`, this private API has no distribution license, and the complete
`NodeView` union is kept as an explicit authority while Phase 1 operations
reference its editable subset.
