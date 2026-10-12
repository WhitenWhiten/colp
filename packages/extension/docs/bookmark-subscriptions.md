# Bookmark subscription runtime

As of 2026-09-25. The implementation is on feat/bookmark-subscriptions.

## Boundaries

The options subscriptions, preferences and diagnostics panes send typed requests to
the service worker. Only its exact options.html sender can invoke management commands.
The user-gesture bookmarks permission request stays in the clicked options control.
The worker rechecks permission before using the native API. Personal Collection sync
binding is not a prerequisite for a subscription.

The worker owns Product Cookie authentication, session-bound bounded transport,
source/mapping configuration, snapshots, local journals, native changes and exit ACKs.
Collection and Digest trees are read-only projections, including for source editors.
The website bridge carries only kind/requestId/sourceType/sourceId from an exact
configured origin. Acceptance opens the wizard; it does not mount a tree.

Code responsibilities:

- contracts/commands: wire DTOs and closed management envelopes.
- product-client/projection: current-session transport, byte budgets, complete snapshot validation.
- store/local-types: local ownership, durable operations, capacity reservations, terminal ACK outbox.
- native/maintenance/recovery: fenced native apply, actor checks, nonrecursive cleanup, verified copies.
- runtime/coordination/events: independent mapping lanes, alarms, native-event reconciliation.
- barrier/guards/personal-boundary/capture-boundary: shared creation barrier and final personal-write exclusion.
- settings/external/worker: local defaults, trusted web continuation and options command execution.

## Persistence and recovery

IndexedDB known-bookmark-subscriptions-v1 is separate from personal sync state.
Migrations add stores/indexes without deleting recovery evidence. mappings keeps small
configuration/state; stages holds complete bounded snapshots; tokens holds the small
current generation/applyEpoch fence. nodes records source identity and native IDs.
operations records intent before the native call and receipt immediately after it.
acks and preserved exclusions commit atomically with a completed exit. diagnostics
and recovery intents remain local and exports omit native paths and identifiers.

Every content batch rechecks current mapping revision, content gate and actor access.
An unreadable node or edition can be removed while content is paused, disabled or
oversized. Permission/API/network errors never prove native absence or revocation.
An incomplete projection cannot authorize deletion. Ordinary kept copies are not
reclaimed after a later source revocation.

A create with unknown outcome is quarantined and reported for repair. It is never
repeated based on matching title, URL or tree shape. No-local-mount cannot be ACKed
while that ambiguity remains. Logout first saves cleanup authority and exclusions;
personal sync cleanup does not erase this database. A later login does not silently
restore a deleted subscription tree.

Local copy/restore previews bind account, generation, epoch and a complete local-tree
digest. Copy nodes remain managed until a fresh full access proof and durable copy
receipt transfer ownership. Only then may the frozen normal exit be submitted. Native
cleanup uses individual empty-folder removal and preserves identifiable personal edits
or unknown personal subtrees. Browser APIs and IndexedDB are not one atomic transaction.

## Scheduling and limits

Content and authority maintenance have separate due times. Manual mappings maintain
on startup, online, management open or explicit check; other mappings' alarms do not
silently refresh their content. Paused timed mappings still receive access maintenance.
Independent mapping lanes prevent one network failure from stopping unrelated work.
Content has a two-slot ceiling; immutable ACK retry continues independently of the
pending-actions listing. All-browser state is server state, not a claim of live device activity.
Maintenance preserves a content deadline until a content attempt actually starts.
A wake completes maintenance and queues content without awaiting long imports. Busy
mapping lanes defer their own maintenance while other mappings continue; pending exits
fence a busy mapping immediately. Explicit refresh joins only a matching account,
generation and epoch attempt, and waits for a fresh attempt after an epoch changes.
Unfinished native journals are recovered during maintenance independently of the
content deadline, including paused and gate-off mappings. An ambiguous create remains
quarantined and visible as repair_pending without issuing another create.

The profile reservation transaction enforces 50 live mappings and 20,000 managed nodes,
including synthetic folders/links and native nodes not yet deleted. Recent Digest has
an absolute 20-edition ceiling. Snapshot limits are 20,000 nodes, depth128,32MiB;
node pages are at most200 nodes/256KiB and actor checks128 identities/64KiB.
The backend admits at most8 live snapshot caches per account,128MiB,15-minute retention.

## Running relevant evidence

From `packages/extension`:

    npm run evidence:bookmark-subscriptions
    npm run evidence:bookmark-subscriptions:capacity

For Edge, set KNS_08_BROWSER=msedge and KNS_08_EDGE_EXECUTABLE to the installed executable
before the first command. The harness verifies the real browser user agent. Every
command uses xvfb and isolated PostgreSQL/BetterAuth/Product routes; browser contexts,
temporary profiles and services close in finally blocks. No developer server remains.
The capacity case is opt-in. It creates actual native nodes and mappings, checks their
identity after refresh and worker termination, and records elapsed times. The opt-in
capacity test permits up to 45 minutes: a measured Chromium 50-mapping/20,000-node run
took 28.2 minutes, including a 26.3-minute initial large mount and a 41.9-second refresh.
An instrumented Edge run took 25.5 minutes, including a 22.9-minute large mount,
30.8-second unchanged refresh and 46.0-second refresh after worker termination.
An independent small source refreshed in 194 ms during that large mount.
Large initial imports are expensive. Process RSS sampling includes browser/test overhead;
options-page heap is reported separately and is not service-worker-only memory. Between preparatory small-source
mounts its fixture expires completed server caches to model a profile accumulated across
retention windows. This measures an existing full profile, not a bypass of the separate
live-cache quota or evidence that50 snapshots may be built simultaneously.

## Release and rollback

Both KNOWN_FEATURE_BOOKMARK_SUBSCRIPTIONS and
KNOWN_BOOKMARK_SUBSCRIPTIONS_PROTOCOL_READY remain false by default. Protocol readiness
may be enabled only after API/atomic-exit and browser acceptance is recorded. On content
rollback set the feature flag false while retaining migrations, configurations, local
journals, fresh access checks, exits and ACKs. Do not clear the local DB or drop server
tables to disable content. This would erase evidence needed by offline clients.

The backend emits bounded transaction latency/error metrics without source/account/title
labels. Local diagnostics expose state, actual managed count and recovery result; they
never invent completion percentages or upload native trees for telemetry.

A14 vendor cloud sync remains a manual release gate by user decision on2026-09-25.
Dedicated synced profiles are required to verify cross-profile/reinstall ambiguity.
The UI warns that native bookmarks may enter the browser vendor account. Unowned copies
are not automatically adopted/deleted; identity-free copies cannot be guaranteed to be
recognized before personal ingestion. Multi-profile control of one vendor-synced tree
is unsupported. Public deployment extension IDs/store URLs/origin allowlists must be
supplied by deployment, never guessed from the local fixture extension.
