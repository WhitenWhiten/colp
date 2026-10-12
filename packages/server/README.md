COLP Server (`@know-n/colp-server`) is the self-hosted bookmark server in this package. Install and run it by following [deploy/INSTALL.md](../../deploy/INSTALL.md).

MCP clients can use the strict `2026-07-28` endpoint at `/collections/-/mcp`,
or the compatibility endpoint at `/collections/-/mcp-compat`. Ordinary calls
do not require optional client capabilities. Advertise `elicitation.url` only
when the client implements URL prompts; otherwise pending writes return an
`awaiting_approval` result with the approval link and plan ID. Answers to a
prompt never grant approval: only the owner's browser decision does.

Use `collections.list` to find owned libraries and `collections.get_snapshot`
to read their bounded pages. `resources/list` is the published directory;
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

For bulk reads, process pages in a script and return only the requested
summary to the conversation. A publication's HTTP snapshot link still needs
authorization where applicable, pagination and completeness checks. Reuse
the client's OAuth provider and secure token storage instead of copying
credentials into scripts. Measure actual model request tokens separately
from serialized schema bytes and HTTP payload sizes.


Public collection and bookmark pages use stored site icons or a local
fallback. They do not contact a third-party favicon service, even if a cached
response carries an older CDN opt-in flag. The legacy `faviconCdnAllowed`
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
