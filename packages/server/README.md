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
supports visibility operations; use the dedicated move and deletion tools
for those operations. Its required `dryRun: true` saves a real pending plan.

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
whole-request idempotency while each operation keeps its own transaction and Sequence receipt.

For multi-operation requests, individual receipt bindings use each `opId` as the
operation's idempotency key. The outer `Idempotency-Key` binds the complete ordered
array. If a non-atomic batch fails midway, earlier commits remain durable and the
client can recover them by sending singleton requests with the original operation
bytes and `Idempotency-Key: <opId>`. Multi-operation atomic batches are rejected.

Snapshot capacity admission uses an exact incremental ledger. Migration
`202610280100_canonical_tree_capacity` installs transactional change tracking;
existing collections initialize on their first admission. To backfill and verify
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

No object-storage service is required: favicon bytes persist in PostgreSQL and are included in
normal database backups. Upload bytes, bindings and receipts commit in one transaction. Existing `AVATAR_R2_*` storage configuration stores favicon objects
in the same bucket under `FAVICON_R2_PREFIX` (default `favicon/`), isolated from avatars.
Apply migrations before running the updated API/worker. The standard `colp-server` process
runs the worker; deployments running API and worker separately must run both.
`KNOWN_FEATURE_FAVICON_POLICY=false` disables policy and automatic jobs.

The server fetches provider icons with bounded requests and blocks private network targets.
Browsers display stored objects; public pages never contact a third-party icon provider.
Private objects require a current owner/member browser session and use `private, no-store` caching.
The extension's favicon helper uploads bytes separately after syncing a bookmark; images are
not embedded in COLP Push operations. Existing helper paths and ETag checks are preserved.

### Gallery preview images

Gallery cards show the bookmark page's own sharing image (`og:image`, `twitter:image` or
`link rel=image_src`). The worker fetches pages over HTTPS with the same private-network
blocking as favicons, decodes the image and keeps a validated copy in PostgreSQL; browsers load
it from this server, never from the third-party site. Public and unlisted collections are filled
in the background. A private collection's pages are fetched only after its owner or an editor
opens it in Gallery. Shared-folder links do not expose private preview images.
`KNOWN_FEATURE_LINK_PREVIEW=false` turns previews off; `LINK_PREVIEW_CONCURRENCY`
(default 2) sets the worker's parallel fetches.
