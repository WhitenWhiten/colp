COLP Server (`@know-n/colp-server`) is the self-hosted bookmark server in this package. Install and run it by following [deploy/INSTALL.md](../../deploy/INSTALL.md).

Each account has one private bookmark library, with **Bookmarks bar** and
**Other bookmarks** ready on first use. `/library` opens that folder tree.
The extension connects it automatically and merges the whole browser tree;
users untick folders to keep them on one browser. New folders, imports and
saves use a folder the user chooses.

The library cannot be deleted, published or made public, and its browser role
folders cannot be renamed, moved or deleted through the web or agents.
Share an individual folder through **Share…** for an unlisted, read-only link
to its live subtree. **Stop sharing** revokes the link immediately; deleting
the folder also ends its share. The library root cannot be shared. Folder
links do not appear in directories, feeds or search indexes, and never expose
private or protected nodes or references outside the shared folder.

MCP clients can use the strict `2026-07-28` endpoint at `/collections/-/mcp`,
or the compatibility endpoint at `/collections/-/mcp-compat`. Ordinary calls
do not require optional client capabilities. Advertise `elicitation.url` only
when the client implements URL prompts; otherwise pending writes return an
`awaiting_approval` result with the approval link and plan ID. Answers to a
prompt never grant approval: only the owner's browser decision does.

Outstanding plans are capped at 20 per client and 100 per authenticated principal,
shared across server instances. Completing, cancelling or expiring plans frees
capacity; an agent that fills the backlog must let the owner review earlier work.

For ChatGPT, the compatibility endpoint returns snapshot pages as inline JSON
text plus `structuredContent`, without the companion snapshot `resource_link`.
Read-only tools publish their existing `outputSchema` and read-only annotations.
The strict endpoint and explicit `resources/read` retain their resource behavior.
These changes remove an unnecessary file delivery path; they do not guarantee
that ChatGPT will never request file materialization.

The `colp-server-v0.1.0-rc.7` source lacked the current read-only tool annotations.
Its snapshot tool also returned a top-level `resource_link`, even for private
libraries. `collections.list` and `collections.get` returned inline JSON without
that link, so the snapshot link cannot explain every reported prompt.
OpenAI documents [read-only detection](https://developers.openai.com/api/docs/guides/custom-mcp-server)
and [structured JSON results](https://developers.openai.com/plugins/reference),
but neither establishes the cause of small JSON results being materialized.
After deploying an update, refresh the plugin's tool definitions in ChatGPT.

To isolate ChatGPT behavior from COLP data, run this from `packages/server`:

```sh
node scripts/mcp-json-probe.mjs
```

It listens on `127.0.0.1:3133/mcp` and exposes only `diagnostics.ping`, a read-only
tool returning `{"ok":true}` in text and `structuredContent`, with `outputSchema`.
It uses the installed MCP SDK and accesses no database, credentials or files.
Use an isolated test connection through a tunnel to that address with no auth.
Record the exact approval wording and whether it appeared before `tool_called`
or after `response_finished` in stderr; match those times to the individual call.
Stop with Ctrl-C. For a comparison, restart with `--text-only` (no structured
result or output schema); `MCP_JSON_PROBE_PORT` overrides the port. A prompt for
the default probe is evidence for investigating the host or delivery layer, not
proof of a particular ChatGPT bug. The raw HTTP contract is covered by
`tests/unit/phase4b/phase4b-mcp-compat-json-wire.test.ts` for the supported
compatibility protocol version (`2025-11-25`).

Use `collections.list` to find the account's library, marked `library: true`,
and `collections.get_snapshot` to read its bounded pages. Add a folder with
`nodes.create` and an explicit `parentId` in that library. `collections.create`
refuses and returns the library and role-folder IDs with this instruction;
`collections.update` and `collections.set_visibility` cannot publish it.
`resources/list` is the published directory;
resource reads use the publication projection and are not a substitute for
all unpublished owner reads. For writes, get the current resource revision
from `collections.get` or `nodes.get`, not a publication content/policy revision.
Search returns titles, URLs, kinds and link health without requiring one read
per match. Its `page.nextCursor` matches the snapshot pagination convention;
the legacy top-level `cursor` remains available.

Direct write results carry `applied` and `status`; previewing does not apply
changes. `nodes.update` accepts `returnRepresentation: true` to include the
updated node, including on an idempotent replay. A trusted move can return
`status: consumed` and `applied: true`; it has already committed. Pending move
and deletion results include the approval link and expiry. `changes.plan`
supports visibility operations and mixed organization plans. Supply `collectionId`,
`reason`, `dryRun: true`, and up to 50 `operations` using `create_node`, `move_node`,
and `delete_subtree`. A folder creation may declare `ref`; later creates or moves
can use `parentRef` to that earlier folder instead of `parentId`. The plan stays
pending until approved and commits all operations in one transaction. For example:

```json
{
  "collectionId": "YOUR_LIBRARY_ID",
  "reason": "File the paper and remove the duplicate",
  "dryRun": true,
  "operations": [
    {"type": "create_node", "ref": "papers", "parentId": "DESTINATION_ID", "node": {"kind": "folder", "title": "Papers", "visibility": "private"}},
    {"type": "move_node", "nodeId": "PAPER_ID", "parentRef": "papers"},
    {"type": "delete_subtree", "nodeId": "DUPLICATE_ID"}
  ]
}
```

History restores retained deleted folders and bookmarks with their original IDs.
A permanently purged item prevents the entire restore; no partial tree is applied.
Automation Undo compensates an individual move, tag update or added note while its
recorded revisions still match. Later edits prevent Undo. Tag effects from older
versions without a saved prior value cannot be undone automatically.

`nodes.move` accepts up to 1,000 IDs in one atomic plan. Distinct bookmark
moves to an existing folder in a private, unpublished library use bulk SQL and
publish authoritative Pull effects; browsers keep their current synchronization
session. Folder moves and explicit placement use the normal canonical writer.
Unsupported server mutation effects still require Snapshot recovery. The separate
browser Push limit remains 50, and mixed `changes.plan` requests remain limited to 50.
Plans keep their content revision fence: a genuine intervening edit still requires
a fresh plan. After an uncertain response, inspect `changes.get` with the plan ID
and replay a commit with its original idempotency key before creating another plan.
Trusted-plan history, Undo receipts and approval audit commit with the mutation;
a failed commit cannot leave a new saved version. Undo checks the committed content
revision, so a later saved snapshot alone does not block it.

Read tools advertise `readOnlyHint: true`; write tools retain their actual write
annotations. Host applications control their own confirmation dialogs separately
from COLP's trusted-agent policy. A host may therefore still request confirmation.

Socket inactivity defaults to 60 seconds (`HTTP_CONNECTION_TIMEOUT_MS`); the
MCP request deadline and database statement/lock budgets remain bounded separately.
Snapshot paging may survive content changes only when all intervening revisions
have retained authoritative Pull effects. The final Ack stays at the snapshot's
original cut, leaving those later changes for Pull. Policy changes, retention gaps,
lease expiry and unsupported mutations still invalidate recovery. Update the
extension as well: wrapped `snapshot_409_snapshot_expired` errors must discard the
old recovery chain and start a new snapshot while preserving pending local edits.

For libraries with legacy dense order keys, back up first and run:

```sh
docker compose exec -T server colp-server maintain-positions --collection COLLECTION_ID
```

This operator command compacts affected folders through canonical mutations, one
atomic folder at a time. IDs, contents, parents and sibling order are preserved;
resource revisions change and browser replicas enter Snapshot recovery. Re-running
it skips already compact folders. Deploy the extension recovery fix before resuming
an affected browser. A local allocation window that remains exhausted returns
`position_context_stale` instead of an internal server error.

The self-hosted web app does not send error or Web Vitals telemetry, and the server
does not mount a browser telemetry endpoint.

The tool catalog is scoped to the caller and cacheable for 30 seconds with
`cacheScope: private`; static resource templates are public for 60 seconds.
Never share a private catalog across authorization contexts. Every tool call
still checks current permissions. Private data reads stay at zero TTL. Use
`subscriptions/listen` for invalidation notifications, then read current data;
notifications do not contain a complete data delta. Clients can load tool
definitions into the model on demand without broadening OAuth permissions.

On the server, host tool definitions are indexed lazily per adapter instance
and reused by name during calls. Visibility is checked against the current
request each time; caller catalogs and authorization decisions are not cached.
Custom adapters without direct lookup continue to use their live tool lists.

For bulk reads, process pages in a script and return only the requested
summary to the conversation. A publication's HTTP snapshot link still needs
authorization where applicable, pagination and completeness checks. Reuse
the client's OAuth provider and secure token storage instead of copying
credentials into scripts. Measure actual model request tokens separately
from serialized schema bytes and HTTP payload sizes.


Public collection and bookmark pages use stored site icons or a local
fallback. Shared folders use local icon fallbacks. Public pages do not contact
a third-party favicon service, even if a cached response carries an older CDN opt-in flag. The legacy `faviconCdnAllowed`
response fields remain available and are always false on public pages.

Initial browser synchronization supports non-atomic Push batches of up to 50 operations.
`SYNC_MAX_BATCH_OPERATIONS` defaults to `50` (range `1..50`); set it to `1` to disable batching.
The Manifest advertises the configured limit and Sessions negotiate it with the client.
Apply migrations before starting the updated server; `sync_push_request_bindings` retains
whole-request idempotency. A batch shares one database transaction, with a savepoint
and a separate Sequence receipt for each operation. A denied member rolls back to its
savepoint and the successful prefix commits before the response is returned.

For multi-operation requests, individual receipt bindings use each `opId` as the
operation's idempotency key. The outer `Idempotency-Key` binds the complete ordered
array. If a non-atomic batch fails midway, its successful prefix commits durably and the
client can recover them by sending singleton requests with the original operation
bytes and `Idempotency-Key: <opId>`. Multi-operation atomic batches are rejected.

Sync bootstrap and recovery Snapshots are materialized in 500-row database cursor
batches inside one repeatable-read transaction. The immutable node rows serve
bounded pages; the former 10,000-node / 2 MiB aggregate ceiling no longer rejects
large libraries or their writes. Negotiated per-page transport budgets still
apply, and explicit materialization quotas remain available to application ports.
The server applies no aggregate Snapshot byte quota by default. An operator who
wants one sets `SYNC_SNAPSHOT_MAX_BYTES` (1 to 16,777,216 bytes of summed node JSON,
roughly 430 bytes per bookmark); a library above it can then no longer be onboarded,
recovered or reset on a new device, and the extension reports that the server's
Snapshot size limit is the cause instead of offering a Reset that cannot help.
A subtree deletion reaches replicas as a small Pull event whose member ids are served
as effect pages, which the replica downloads within the session's negotiated effect
budget (512 KiB by default, shared with the page body). A Pull page therefore ends
before an event whose effect pages would not fit with the events already on it, so
several large deletions arrive on separate pages. A single deletion that cannot fit the
budget (only possible when `KNOW_N_MAX_DELETE_SUBTREE_NODES` is raised above roughly
11,000 nodes) sends that replica to Snapshot recovery, whose state already carries the
deletion, instead of leaving it unable to pull.
Migration `202611020100_sync_snapshot_parent_revision_rows` adds page-local parent
revision authority. Existing inline and paged Snapshots remain readable, and the
complete parent header remains compatible with the preceding server binary.
Continuation cursors use the Snapshot header's frozen expiry, so delayed page
replays retain the same response digest across application restarts.

Sync evidence maintenance starts with enabled Sync sessions; operators can set
`SYNC_EVIDENCE_MAINTENANCE_ENABLED=false`. Each transaction keeps its configured
row bound (500 by default). Busy cleanup yields after 20 batches or after its
one-second budget is reached between transactions, then continues after 250 ms;
idle cleanup uses the configured interval (60 seconds by default). Ack and
checkpoint retention stays intact, and protected rows do not displace actionable
work or inflate the backlog-age gauge. Shutdown waits for the current transaction.

Canonical size accounting uses an exact incremental ledger. Migration
`202610280100_canonical_tree_capacity` installs transactional change tracking;
existing collections initialize on their first write. To backfill and verify
all collections before serving traffic, build the server and run
`node scripts/backfill-canonical-tree-capacity.mjs --check` with `DATABASE_URL` set.
The command locks one collection at a time and compares the ledger to the full
Snapshot serializer. Keep the tracking migration installed when rolling back an
application binary so writes continue to invalidate cached contributions.

Session negotiation reissues retained, acknowledged checkpoints under the new
Session without advancing their position. Clients adopt the returned
`collection.serverCursor` at a fully acknowledged local boundary. Empty Pulls
still echo their input cursor; missing retained history still requires recovery.
Recovery uses fresh request credential evidence, while durable credential rows
continue to enforce identity, revocation, token expiry and account security epochs.

### Bookmark favicons

The self-hosted preset enables favicon upload and background filling. In Settings → Favicon,
choose the default for new bookmarks and enable **Fill missing icons** to enqueue existing
bookmarks without icons. The same policy applies to subsequently created and browser-synced
bookmarks. Explicit **No icon** choices and manual uploads are preserved by missing-icon filling.
Force-online also applies to future bookmarks and records their original icon state for restoration.
Each bookmark's edit drawer offers immediate upload/removal and icon-source selection.
PNG, JPEG, WebP and ICO uploads are limited to 64 KiB; SVG and GIF are rejected.
Every Settings section shows active favicon work as a count and thin progress bar.
Reopening Settings discovers current account jobs, including individual refreshes
started elsewhere. Progress reads committed batch-item counts; failed items can be
retried after completion, and closing Settings leaves the server task running.
Online results are cached in PostgreSQL by complete provider URL, including query
parameters, for `FAVICON_SHARED_REFRESH_INTERVAL_SECONDS` (default 30 days) with
stable ±10% expiration jitter. Concurrent requests share a fetch, including across
workers. Different providers and size parameters have separate cache entries.
Cached icons bypass provider limits; queued cold requests wait without consuming
attempts or repeatedly updating every bookmark. Curated-site warming runs only
when no account has active favicon jobs; cold sites requested by a user fill on demand.
`FAVICON_PROVIDER_INTERVAL_MS` defaults to 1000 (1 second). Providers remain
serialized, and `429` responses persist `Retry-After` / exponential cooldowns.
Previously failed jobs can be retried after deployment to recover standard DIB ICOs.

No object-storage service is required: favicon bytes persist in PostgreSQL and are included in
normal database backups. Upload bytes, bindings and receipts commit in one transaction. Existing `AVATAR_R2_*` storage configuration stores favicon objects
in the same bucket under `FAVICON_R2_PREFIX` (default `favicon/`), isolated from avatars.
Apply migrations before running the updated API/worker. The standard `colp-server` process
runs the worker; deployments running API and worker separately must run both.
`KNOWN_FEATURE_FAVICON_POLICY=false` disables policy and automatic jobs.

The server fetches provider icons with bounded requests and blocks private network targets.
Browsers display stored objects; public pages never contact a third-party icon provider.
Private objects require a current owner/member browser session. Objects are never rewritten,
so browsers keep private reads for a week (`private, max-age=604800, immutable`); an icon already
seen can stay in that browser for as long after access is revoked. Owners and members get one
object URL for byte-identical icons in a collection, so a site's icon downloads once rather than
once per bookmark; public pages keep each bookmark's own object.
The extension's favicon helper uploads bytes separately after syncing a bookmark; images are
not embedded in COLP Push operations. Existing helper paths and ETag checks are preserved.

### Profile avatars

Settings uploads a PNG, JPEG or WebP avatar (at most 2 MB) with `POST /api/v1/me/avatar`;
the account menu, members list and shared collections show it. Without `AVATAR_R2_*`
configuration the bytes live in PostgreSQL (`avatar_object_bytes`) and are included in
normal database backups; with it they go to the R2 bucket under `AVATAR_R2_PREFIX`.
A replaced avatar is deleted once no profile references it. Avatar URLs are HTTPS on
the default port, so the plain-HTTP setup answers uploads with `503`.

### Gallery preview images

Gallery cards show the bookmark page's own sharing image (`og:image`, `twitter:image` or
`link rel=image_src`). The worker fetches pages over HTTPS with the same private-network
blocking as favicons, decodes the image and keeps a validated copy in PostgreSQL; browsers load
it from this server, never from the third-party site. Public and unlisted collections are filled
in the background. A private collection's pages are fetched only after its owner or an editor
opens it in Gallery. Shared-folder links do not expose private preview images.
Successful preview images are cached for 7–15 days, publicly for public/unlisted
bookmarks and only in the browser for private ones (`Vary: Cookie`). The image ID
determines a stable jitter in seconds across that range, spreading the expiration
of images loaded together; revalidation, restarts and replicas keep the same lifetime.
Expired images and browser revalidation requests use content ETags and bodyless `304`
responses after a fresh access check. A cached image may remain usable for up to
15 days after access is revoked; changed image content gets a new URL.
Image bytes remain in PostgreSQL; no object-storage bucket is required.
`KNOWN_FEATURE_LINK_PREVIEW=false` turns previews off; `LINK_PREVIEW_CONCURRENCY`
(default 2) sets the worker's parallel fetches.
`LINK_PREVIEW_RETENTION_SECONDS` (default and minimum 1296000, or 15 days) retains
displaced image versions for at least the longest cache lifetime before garbage collection.

### Custom gallery covers

Owners and editors can upload a PNG, JPEG or WebP (up to 2 MiB and 4096 pixels per
side) with `POST /api/v1/collections/{collectionId}/images`, then set a bookmark or
folder cover with `PUT /api/v1/collections/{collectionId}/nodes/{nodeId}/cover`.
The JSON settings are `mode: auto | custom | none`; `custom` requires the upload's
`assetId`. Send `If-Match: "cover:N"` using the node's `coverRevision` (initially
`0`). Both mutations use the standard session, CSRF and `Known-Command-Id` rules.
`custom` overrides automatic OG images or folder mosaics; `auto` restores them.
Read views expose the selected image as `coverImage`, alongside `coverMode` and
`coverRevision`. The older `previewImage` field retains its OG-only URL contract.

Uploads never expire and remain stored after replacement. Bytes live in the
separate `image_asset_bytes` PostgreSQL table and are included in database backups;
the OG worker does not refresh or garbage-collect them. Each new upload command
creates a new immutable `/api/v1/images/{uuid}` URL. Read access follows current
node bindings and collection permissions. Public image responses cache for one
year; private ones cache only in the browser for seven days, with `immutable` and
content ETags. Cached bytes can remain visible for that long after access is
revoked. Missing objects use `no-store`; conditional reads recheck access before
returning `304`. Custom covers work with `KNOWN_FEATURE_LINK_PREVIEW=false`.
Editor read revisions include cover settings; anonymous public collection JSON
uses `max-age=0, must-revalidate` with a current-projection ETag so image references
can change independently of the immutable image cache.
