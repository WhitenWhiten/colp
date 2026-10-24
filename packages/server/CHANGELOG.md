# Changelog

All notable changes to COLP Server are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]


## [0.1.0-rc.10] - 2026-10-24

### Added

- Consent is the permit for automation workers. An OAuth agent whose consent included `automation:work` binds itself as a paired worker the first time it talks to the server, over MCP or the HTTP work API, with no pairing code: the server adopts the Owner's existing registration for that client or registers the agent with one standard inbox, and re-pairs the inbox after an opt-in change on the agent's next call. The consent page and agent cards describe the three automation scopes, the OAuth issuer and resource metadata advertise them whenever the matching features are on, and the new `automation.targets.mine` worker tool tells an agent which inboxes it works for. The rule editor and the worker form say that such agents pair on their own; the one-use code remains for scripts on API keys.

### Fixed

- Background automation delivery and approvals only verify existing worker bindings; only live worker requests may pair inboxes through consent. `automation.targets.mine` now honors page sizes and signed cursors so workers can discover more than 100 inboxes without exposing other credentials' targets.
- Sync center keeps device recovery controls available when conflicts, library data, or diagnostics fail to load. With an updated extension, Reset sync first retires the old replica before archiving uncertain uploads; command delivery and results survive lost responses and interrupted resets. Browser bookmarks and library content are retained, followed by folder selection and merge review in the extension.
- Extension sync no longer lets failed or missing sibling anchors block unrelated saves. Live predecessor operations still preserve bookmark ordering until their create receipts arrive.
- Activity navigation uses the feature switch returned at sign-in, keeping the inbox reachable while its summary is loading or fails. Older servers retain summary-based discovery.

### Security

- Upgrade all container build stages and the server runtime to Node.js 22.23.4, fixing the bundled Brotli decoder vulnerability CVE-2026-111497 and the other issues addressed by the Node.js October 2026 security release.

### Upgrade notes

From 0.1.0-rc.9, update the checkout and deployment files from this tag,
set `COLP_IMAGE_TAG=0.1.0-rc.10`, and recreate the server. There are no new
database migrations. The image includes the web app; update the extension
separately for the sync recovery and sibling-anchor fixes.


## [0.1.0-rc.9] - 2026-10-23

### Added

- A private Activity inbox records agent bookmark additions and automation run outcomes, with a shared unread count across the web app and extension. Reads are fenced by the observed item revision and replay their original command result. Approval transitions reopen notifications, resolved attention clears, and delayed events aggregate from their first inbox delivery.

### Fixed

- Sync recovery preserves snapshot replay boundaries, durable batch receipts, pending local changes and replica session authority. Concurrent semantic moves rebase against locked state, and abandoned replicas no longer block tombstone retention indefinitely.
- Snapshot materialization, ledger archive cleanup, automation owner maintenance and pending MCP plan admission use bounded work. Extension sync avoids repeated whole-library reads and retains recovery evidence during history cleanup.
- Authentication and deployment hardening covers canonical route rate limits, foreign Sync credentials, extension account restoration, OAuth registration, master-secret validation, browser headers and database restore validation. Dependency security updates are included.
- Web annotation drafts survive server revisions, retained saves settle before later saves, and request deadlines cover response body consumption.
- Activity browser assertions and OpenAPI response headers now match the read contract. The large extension push-backlog test allows for CI coverage instrumentation overhead while retaining its operation and time-budget assertions.

### Upgrade notes

From 0.1.0-rc.8, back up the database, update the checkout and deployment files
from this tag, set `COLP_IMAGE_TAG=0.1.0-rc.9`, and recreate the server.
The image includes the web app. Update the extension separately to pick up its
Activity and Sync fixes. Startup applies these new migrations:

- `202611010600_incremental_ledger_archives`
- `202611010700_automation_owner_maintenance`
- `202611010800_mcp_pending_plan_admission`
- `202611020100_sync_snapshot_parent_revision_rows`
- `202611020200_agent_activity`
- `202611020300_activity_approval_transitions`
- `202611020400_activity_resolved_attention`
- `202611020500_activity_aggregation_clock`


## [0.1.0-rc.8] - 2026-10-21

### Added

- The rule editor can connect an agent and test it on one bookmark before the rule is turned on. `POST /api/v1/me/automations/agent-setup` (owner session) saves the draft rule, its binding, its execution policy and a standard connection in one command. It does not start a model or enable the rule, and pairing is not treated as proof that the agent ran. A connection that is still waiting returns a one-use pairing grant; the editor shows that request and checks until the agent pairs. The test runs the rule's tasks on a single bookmark and asks for a review of the result before the rule is enabled. Run once can name that same bookmark. Guided setup accepts a standard rule with one agent; a restricted rule stays on advanced configuration. Product API 1.101.0.
- An agent can organize one library in a single plan. `changes.plan` with `collectionId`, `operations` (1 to 50 of `create_node`, `move_node` and `delete_subtree`), `reason` and `dryRun: true` is checked and stored as one approval. A folder created in the plan may be named with `ref` and used as `parentRef` by a later create or move. Nothing is written until the owner approves. If the collection changes while the plan is being built, the call is rejected and the agent reads the library again. The tool input stays one closed object, which MCP hosts accept.
- `nodes.move` accepts up to 1,000 bookmark ids in one atomic plan when every move is a distinct bookmark into an existing folder of a private, unpublished library. Those moves publish authoritative Pull effects and leave the browser's Sync session in place. Folder moves, explicit placement and mixed `changes.plan` requests stay limited to 50. A genuine intervening edit still requires a fresh plan. After an uncertain response, read `changes.get` with the plan id and replay the commit with its original idempotency key before creating another plan.
- `colp-server maintain-positions --collection <id>` compacts legacy dense folder order keys, one atomic folder at a time. Ids, contents, parents and sibling order stay; resource revisions change, and browser replicas enter Snapshot recovery. Running it again skips folders that are already compact. Back up first. A local allocation window that is still exhausted returns `position_context_stale` instead of an internal error.

### Changed

- Restoring a collection version brings back folders and bookmarks that are still retained as deletions, parents before children, with their original ids. A permanently purged item, or one whose retained deletion is gone, refuses the whole restore. No partial tree is applied.
- Undoing an automation effect restores the previous tags of a tag update, or deletes the note that effect added, while the recorded revisions still match. A later edit blocks that Undo. A payload that omits tags leaves the tags already on the node; only an explicit list replaces them. A tag effect saved by an older server without the previous value cannot be undone automatically.
- History lists compare a stored summary (`id`, `kind`, `parentId`, `title`, `url`, sibling index) instead of reading each full tree. Restore still reads `tree_json`. Apply migration `202611010500_collection_tree_version_change_summary` before deploying; startup backfills every saved version.
- A browser Snapshot may continue across content changes when every intervening content revision still has a retained authoritative Pull effect. The final Ack stays at the snapshot's original cut, and later changes are left for Pull. Policy changes, retention gaps, lease expiry, a legacy snapshot without a pinned ordinal, and an unsupported mutation still invalidate recovery.
- A delete refused because another device edited, moved or added under that node now carries `currentRevision` and, for a subtree delete, `currentSubtree` (`version`, `count`, `digest`, `memberIdsDigest`). A current browser can rebase a single delete, or rebase a subtree delete when the member-id digest still matches, instead of keeping a permanent rejection. This image vendors `@know-n/colp` `0.2.2-automation-client-id.1` (rc.7 used the published `0.2.1`). Update the browser extension as well: an expired snapshot chain has to be discarded and started again, and a move stuck on a stale snapshot revision has to refresh its authority, while pending local edits stay.
- Conflict-list cursors are still signed with the current editor secret. A cursor signed with a previous key is accepted until that key's retention time.
- An automation connection profile accepts an HTTPS client-metadata URL as `authorizedClientId`, and an opaque OAuth client id of up to 256 characters. Existing opaque ids stay valid. Product API 1.100.0.
- Account export fails when the account mapping cannot be resolved, instead of writing an export under the auth-user id with an empty subject. An account that has no collections still exports empty.
- A database failure while binding an account identity stays a database failure. Only a unique violation on a known binding constraint is recovered by reading the row again; it is no longer reported as an invalid token.
- Web: Add bookmark, New folder, Import, a rule's folder and Run once use the folder picker — the chosen folder's name, search, and an indented tree. Recent folders are remembered in this browser. The library root is named All bookmarks.
- Web: a browser card in Sync center stays short. Its set-aside items, acknowledgement warnings and raw diagnostics open in a dialog, and the card's buttons sit on one row.
- Web: owner pages share one page head, section title, count pill, dialog footer and empty-list frame. Settings › Bookmarks uses the same rows as the extension's Saving page.

### Security

- Change-plan and operation ids come from a CSPRNG. Without Web Crypto they were derived from the clock and were predictable.
- A credential-store or key-set outage is answered as unavailable, so clients retry. It is no longer reported as an invalid credential that signs them out.
- Legacy session rotation no longer invents a process-local key. Deriving a successor without an explicit secret or the existing OIDC HMAC fails. Legacy OIDC in production no longer falls back to the fixed test AES key. A self-hosted server that already sets `COLP_SERVER_SECRET` and does not run legacy OIDC is unchanged.
- Favicon item writes recheck the lease owner in the same transaction. A late holder cannot overwrite a bound icon or delete the new owner's restore snapshot. Upload, delete, helper and source commands require their own retention; the process-global 365-day default is gone.
- The self-hosted web app sends no error or Web Vitals telemetry, and the server no longer mounts `POST /api/v1/client-events`. Product API 1.99.0 removes that path and the client-event schemas.

### Upgrade notes

From 0.1.0-rc.7, update the checkout and `deploy/` files from the same revision,
set `COLP_IMAGE_TAG=0.1.0-rc.8`, and recreate the server. Compose files are
unchanged. This additive migration runs at startup and rewrites every saved
collection version, so the first start can take a while on a large library:

- `202611010500_collection_tree_version_change_summary`

`maintain-positions` does not run on its own. Back up, deploy the extension
recovery fix, then run it only for a library that still has dense order keys.

## [0.1.0-rc.7] - 2026-10-18

### Added

- Each account has one private bookmark library. Opening the library, starting extension sync, or an agent calling `collections.list` creates it when it is missing, with Bookmarks bar and Other bookmarks. The library stays private: it cannot be published or deleted, its root cannot be shared, and its browser role folders cannot be renamed, moved, or deleted. Agents cannot create another collection; `collections.create` returns the library and those folder ids and tells the agent to create a folder with `nodes.create` and an explicit `parentId`. Apply migration `202610311100_account_library` before deploying.
- A folder inside the library can be shared with a revocable unlisted link. Anyone with the link can read that folder's live contents, including subfolders; private and protected items stay hidden. Stopping the share, or deleting the folder, ends the link immediately, and restoring the folder does not reopen it. Apply migrations `202610311200_folder_shares` and `202610311300_folder_share_keyset_indexes` before deploying.
- The Sync center can ask a browser to fix itself. A stopped browser's card offers Retry and Reset sync (after a danger confirm), and a held item in its list offers Try again, whenever the browser's last report offers them. `POST /api/v1/sync/replicas/{replicaId}/commands` (owner session, `Known-Command-Id`) takes `{ action, issueId? }` and answers `412` when the last report does not offer that action, or `429` with eight commands already waiting; an open command for the same action and issue is returned instead of a second one. A command names no data, reaches the browser in the `commands` of its next replica-health response, and its result returns in a later report's `commandResults`; it expires after seven days. `health` adds `actions` (what the browser offers for itself) and `commands` (the last seven days, newest first), and the card says what came of the latest one: waiting for the browser, ran, didn't work and why, or expired. A browser reset from here says so and shows up again as a new browser after setup. Apply migration `202611010300_sync_replica_commands` before deploying.
- The Sync center shows each browser's own report. `GET /api/v1/sync/status` adds optional `health` (`state`, `code`, `since`, `reportedAt`, `issueCount`; `null` before the first report or when retired) to each replica, and `GET /api/v1/sync/replicas/{replicaId}/issues` lists the items it set aside and its latest Ack warnings. The device card says Stopped with the reason in plain words, Needs attention with the items on request, or Paused. A change held behind a conflict (`conflict_hold`) reads as waiting for a conflict on that bookmark; an item the browser could not store says so, and one whose folder is set aside (`parent_set_aside`) says its folder is missing there. Saves the browser set aside because their folder was deleted, their place or identity couldn't be proven, or a deletion couldn't be matched each get a plain reason. A browser that stopped because it set aside too many items (`pull_issue_ceiling`) says so.
- Browsers report their own sync health to the server. `POST /colp/v0.1/sync/replica-health` (extension origin, Sync credential, no Session) stores a replica's state (`syncing`, `degraded`, `stopped`, `paused`), its reason code and up to 50 set-aside issues; an older revision never replaces a newer one, and a report renews no lease and moves no cursor. Issue titles that look like a URL, credential or browser id are dropped. Successful Acks also keep the replica's latest `warnings`, which were validated and discarded before. Apply migration `202611010200_sync_replica_reports` before deploying.
- The Sync center tells when a browser stops taking in changes, without any report from the browser. `GET /api/v1/sync/status` adds optional `activity` (`current`, `behind`, `stalled`, `silent`; `null` when retired) and `behindSince` to each replica, from the oldest Sync stream change past its acknowledged checkpoint. A browser that has missed changes for an hour shows as Not syncing, with whether it still connects.
- Profile avatar uploads work without object storage: when no `AVATAR_R2_*` bucket is configured, avatar images are stored in PostgreSQL (`avatar_object_bytes`) and included in database backups. Apply migration `202611010100_avatar_object_bytes` before deploying. A plain-HTTP origin answers `POST /api/v1/me/avatar` with `503` and says avatars need HTTPS, instead of failing as an invalid avatar URL.

### Changed

- Automation worker pairing confirms the credential: when a valid one-use pairing grant is redeemed by a credential of the profile's `authorizedClientId` that differs from its `credentialBindingId`, the profile adopts that credential's binding and the grant carries over to the new revision. Nothing is adopted for another client or Owner, without the code, or while another target of the profile is paired. Owners (and the web Agents page) can therefore register a worker's connection with a placeholder binding, and pairing a lone target again moves it to the agent's current credential. Over MCP, a credential that a live grant could confirm sees `automation.targets.pair` beside its standard tools until it pairs.
- Online favicon jobs reuse validated results by complete provider URL in PostgreSQL, coalesce concurrent requests and fence fetches across workers. Cached items bypass provider admission; uncached work admits one candidate per provider, rotates waiting items and sleeps until the provider/item retry deadline instead of repeatedly scanning blocked bookmarks. User jobs take priority over curated-site warming, including while waiting for a retry; cold curated sites fill on demand. The default provider spacing is now 1 second, with explicit configuration preserved and durable `429` / `Retry-After` cooldowns. Apply migration `202610311400_favicon_provider_cache` before deploying.
- Fixed standard ICO files containing headerless DIB images being rejected as `invalid_image`; palette, pixel/mask bounds, dimensions and bitfields remain validated.

- Settings shows a favicon task strip across all sections, with live processed/failed/skipped counts, a thin progress bar and failed-item retries. Closing and reopening Settings discovers active account jobs through `GET /api/v1/me/favicon-jobs`, including individual refreshes started elsewhere; in-flight batch reads use committed item counters instead of waiting for the next worker-cycle aggregate.

- Private favicon reads are cached by the browser for a week (`private, max-age=604800, immutable`) instead of `private, no-store`, so scrolling a long library no longer downloads icons again. Bookmarks in one collection with byte-identical icons now share one object URL for owners and members, so a site's icon downloads once rather than once per bookmark; public pages keep per-bookmark objects. An icon already seen can stay in that browser's cache for up to a week after access is revoked.

- Gallery preview images now use a 7–15 day cache (public for public/unlisted images, browser-only for private images), with stable jitter per image ID to spread expiration, and content ETags with `If-None-Match` / `304` revalidation. Revalidation still checks current access and image validity; already cached images may remain usable for up to 15 days after access is revoked. PostgreSQL storage is unchanged. The default and minimum `LINK_PREVIEW_RETENTION_SECONDS` are now 1296000 (15 days), covering the longest image cache lifetime.

### Security

- Replica health reports, Sync-center command delivery, and command results now require `Known-Sync-Replica-Proof` as well as a fresh Sync credential. The proof is the SHA-256 of that installation's Session id and is stored only as a digest. Apply migration `202611010400_sync_replica_report_authorities` before deploying. It copies a proof from each still-active Sync session, so a browser that still has that Session can keep reporting; an installation with neither the proof nor that Session has to sign in again. Account ownership alone no longer authorizes a health report.

### Upgrade notes

From 0.1.0-rc.6, update the checkout and `deploy/` files from the same revision,
set `COLP_IMAGE_TAG=0.1.0-rc.7`, and recreate the server. These additive
migrations run at startup:

- `202610311100_account_library`
- `202610311200_folder_shares`
- `202610311300_folder_share_keyset_indexes`
- `202610311400_favicon_provider_cache`
- `202611010100_avatar_object_bytes`
- `202611010200_sync_replica_reports`
- `202611010300_sync_replica_commands`
- `202611010400_sync_replica_report_authorities`

Existing collections stay. A library is created the first time that account
opens the library, starts sync, or an agent lists collections. Folder shares
start with no links. Compose files are unchanged from 0.1.0-rc.6.

## [0.1.0-rc.6] - 2026-10-16

### Added

- Restored bookmark favicon upload/removal, extension capture helpers, account/source settings and durable missing-icon filling with retries and cleanup. Self-hosted instances store icons in PostgreSQL by default, with existing R2 configuration supported; private reads require a live authorized session.
- Restored bookmark preview images for Gallery (`KNOWN_FEATURE_LINK_PREVIEW`, on in the self-hosted preset). The worker reads each bookmark page's own `og:image`, `twitter:image` or `image_src` and keeps a validated copy in PostgreSQL (`link_preview_object_bytes`), served same-origin at `GET /api/v1/link-preview/{previewId}`. Public and unlisted collections are filled in the background; a private collection's pages are fetched only after its owner or an editor opens it in Gallery (`POST /api/v1/collections/{collectionId}/link-preview-requests`). Signed-in owners and members read private previews with `private, no-store`.

- `colp-server --help` (also `-h`, `help`) prints the command list and exits 0.
- `npm run test:static` runs the static contract project; CI runs it after the unit suite.
- `runtime/package.json` and `runtime/package-lock.json`, generated by `npm run runtime:manifest`, are the production image's install manifest (CI checks for drift with `runtime:manifest:check` and audits the frozen runtime install with `scan:dependencies:runtime`).
- Every committed agent plan saves the collection's version just before it changes anything, inside the commit transaction. Plans the owner approved by hand now appear in History and can be undone from the Approvals page, like plans a trusted agent committed (`approvedBy: "owner"` next to `"policy"`).
- `nodes.move` accepts `nodeIds` (up to 50) to move several bookmarks or folders in one plan and one approval. Each later move in the plan is checked against the revisions the earlier moves left.
- Write tools describe what they do in `tools/list` instead of "Write tool <name>".
- Approvals show what a move or delete does in the server's own words (`move Docs from /A to /B`), as the plan summary and per operation (`description`).
- The edition OpenAPI documents `POST /api/v1/mcp/approvals/{planId}/undo` and `approvedBy`/`versionId` on approvals.
- Web: Approvals is a primary destination (top bar and the phone tab bar) next to Library and Agents; the account menu link stays.
- Web: Agents shows the compatibility and strict MCP endpoints as copyable fields; the Extension page shows this server's address with a Copy button in the "Connect this server" step.
- Web: About reports the server status and transport from `/health` and the Manifest, the server address, and links to the Extension, Agents, Import and Sync pages; it sets the document title.
- Web: Import shows which file is previewed, lists nested destination folders as a tree, and shows an "Import complete" card with "View collection" / "Import another file"; the chosen file is cleared after a completed import so Confirm cannot re-import it by accident.
- Web: the library search palette has one owner gate for every entry (toolbar buttons, ⌘/Ctrl+K and the open-palette event); a visitor on a shared link no longer reaches the sign-in wall through the shortcut, and signing out closes an open palette.
- Product API 1.93.0: search node results carry `nodeKind` (`bookmark`, `folder` or `separator`), and `GET /api/v1/me` (with `PATCH /api/v1/me` and the avatar upload) returns `account.username`, the sign-in name. Both fields are optional in the schema, so 1.92.0 clients are unaffected.
- Web: Search and the ⌘K palette label folder hits "Folder" from `nodeKind` and open them on the library desk; the account menu and the agent consent page name the account by its sign-in username.

### Changed

- The server depends on the published `@know-n/colp` 0.2.1 instead of the vendored `0.2.1-automation.1` build; the image no longer copies `vendor/`.
- Automation editing preserves the complete rule definition, template reference, agent bindings and execution policy. Editing previews exclude the owned rule from competition; omitting `executionPolicyId` preserves the current policy, while `null` removes it explicitly.
- The Automation editor applies changes to enabled rules, explains missing setup and preview warnings, and asks about earlier work only when runs are on hold. Rule and run pages refresh active work and use clearer status and worker setup guidance.
- The SDK supplies URL elicitation and the `awaiting_approval` fallback directly, replacing the server's temporary approval interaction and output-schema compatibility layer.
- Web: sign-in, registration, Agents, Approvals, Get started, Sync, Import, the shared collection page, Search, About and the 404 page are redesigned on Know-N's palette with the pegboard and ribbon motif. Collaborators is hidden until multi-user, and the account menu no longer shows the generated profile handle.
- The in-memory MCP rate-limit stores reclaim expired buckets in a bounded step (at most 64 entries) when at capacity, instead of scanning every bucket; restarted buckets are re-inserted at the tail so the map stays ordered by window start.
- `COLP_SERVER_SECRET` errors now say how the value was interpreted (base64 or UTF-8) and how many bytes it produced.
- Removed the hosted public collection shell: the origin-injected HTML and Markdown for `/c/{slug}`, `/share`, `/path` and `/graph`, with `KNOWN_FEATURE_PUBLIC_SHELL_META` and `WEB_SHELL_ORIGIN`. It fetched and rewrote the hosted service's `index.html` and linked to its origin; the self-hosted web app renders `/c/{slug}` itself behind Caddy. `/c/{slug}` on the server still answers COLP clients (collection-metadata Accept or `Collection-Protocol-Version`) with the canonical tombstone; any other Accept answers `resource_not_found`.
- E-mail subjects, chrome and signatures say "COLP Server" instead of the hosted service's name (sent only when the e-mail feature and SMTP are configured). The Manifest `title` default is "COLP Server" (`PUBLICATION_TITLE` still overrides it).
- Removed the public collections sitemap (`/sitemap-collections.xml`), which was registered unconditionally and listed collections under the hosted service's origin instead of this server's, and the Open Graph card renderer (`/c/{slug}/og-image.png`), which only served the public shell that the self-hosted preset keeps off; `satori` and `@resvg/resvg-js` leave the runtime image with it. Caddy already answered the sitemap paths with 404.
- The OAuth `invalid_client` message for an opaque `client_id` points at this server's Agents page and `deploy/INSTALL.md`, not at the hosted service.
- A malformed `/reports/...` URL answers the same JSON problem as any other bad path; the branded HTML page for the removed reports feature is gone.
- Removed features that are off in the self-hosted edition and have no user story: IndexNow, the Explore shell, publishing insights, readable replicas, AI organize plans, export jobs, email without `COLP_SMTP_URL`, and classification with credits. Their routes, workers, settings and OpenAPI entries are gone; migrations are untouched. Library export (`colp-server export`, `/api/v1/collections/{id}/export`) is unaffected.
- A rejected agent commit says why (the collection changed after the plan, not yet approved, expired, denied) instead of "MCP write operation rejected."
- `changes.get` reports `requiresApproval: false` and `approvedBy: "policy"` for a plan a trusted policy approved, matching what `nodes.move` returned.
- Product route timeouts answer "This operation is temporarily unavailable."
- `/api/v1/auth/key-token` answers `401 invalid_grant` for a well-formed key that is unknown, revoked or expired, so a script can tell a revoked key from a missing endpoint. Malformed requests still answer 404.
- The Docker image installs the runtime stage from `runtime/` with `npm ci --omit=dev --omit=peer` and refuses to build when `vitest`, `tinypool`, `tsx` or `@vitest/mocker` are present; `npm prune --omit=dev` could not drop them because the dev lockfile marks them as optional peers of `better-auth`.

### Fixed

- Enabling an Automation can resume held runs with their pinned inputs, and usage views include owner-held runs. Archiving releases rule quota; current rule scans stay separate from archived history.
- Worker reads, claims and bounded owner-maintenance sweeps converge invalid ready jobs to stale. Manual slices yield under lock contention, device bundles are reused, referenced evidence is retained, and health reflects unresolved delivery incidents.
- Automation commands retain their IDs until write responses validate, active run reads invalidate stale data, and failed or rate-limited session checks no longer send signed-in owners back to Sign in.
- Idle sync replicas accept Acks for the current Session-issued checkpoint cursor, extending the lease without entering a repeated Session-renewal recovery loop.
- Favicon uploads share the command transaction when bytes are stored in PostgreSQL, avoiding nested pool acquisition. External upload failures retire orphan objects after rollback, including failures during receipt/commit; lost commit acknowledgements preserve live objects.
- Favicon jobs recover an already-bound missing icon after a crash, fence node revisions during fetch, honor the deployment flag, and apply force-online to future bookmarks with a recoverable original state. Shared site-logo caches are projected again.
- Favicon settings preserve unsaved provider drafts across other setting changes and use the existing discard guard. Removed the unrelated children time-sort surface from the favicon restoration.

- Browser session reads recover the current cookie across multiple rotations and reject revoked sessions instead of reporting stale Better Auth predecessors as usable. This lets extensions refresh credentials after missing a rotation.
- Agents supports HTTPS CIMD client IDs (including Codex's metadata URL) in the web list, policy, audit and revoke routes.
- MCP compatibility tool results omit fractional annotation priorities, fixing `collections.get_snapshot` failing with `Unexpected response type` in Codex 0.162.1. Snapshot data, resource links and other annotations are preserved.
- Collection pages retry database-aborted reads during concurrent bookmark sync, instead of immediately returning 503. Each attempt keeps the shared collection lock, repeatable-read snapshot, authorization and cursor revision checks; persistent conflicts still fail after three attempts.
- IP-based HTTPS works through Docker's TLS ingress when the client omits SNI. Both TLS Compose services derive Caddy's default certificate selection name from `COLP_SERVER_ORIGIN` (IPv4, IPv6 and DNS, with optional ports), without an extra operator setting. CI verifies real certificate-chain and identity checks against the production Compose configuration.
- Web: copying on the Agents page falls back to a selection copy when the Clipboard API is unavailable or rejects access, and reports a failure when neither method works.
- Web: a visitor on a shared collection link is no longer offered "Search your library" (it only answered with a sign-in wall) or a breadcrumb into the owner's Library.
- Web: the first-run "no owner account yet" note on Sign in is an informational notice with a "Create the owner account" button instead of an error band.
- Web: the Sync center's error state no longer repeats "Couldn't load sync status" as both title and description.
- Agent plans affecting a collection with more than 2,000 live folders and bookmarks are rejected before mutation in both manual and trusted mode. Manual commits no longer silently skip history and Undo; capacity failures report the limit and leave the plan available to cancel. Failed commits roll back their approval claim, and idempotent replays keep returning the original result without capturing history again.
- An agent's OAuth sign-in works when the owner is not yet signed in: `/oauth2/authorize` sends the browser to `/login` instead of answering JSON 401, and `/login` resumes the authorization after sign-in instead of dropping it.
- `/sitemap.xml`, `/sitemap-*.xml`, `/llms.txt` and `/llms-full.txt` answer 404 in all Caddy profiles instead of the web app's HTML.
- The static contract tests referenced Know-N paths that are not part of this package; they are adapted to the self-hosted repository (Caddy ingress, PostgreSQL project, in-package frozen lists) or removed with their module (see `tests/EXTRACTION.md`).
- `colp-server export` no longer overwrites a collection's snapshot with the directory catalog when the collection's title or publication slug is `index`: the `index` stem is reserved for `index.json`, stems are de-duplicated case-insensitively, and suffixed names keep their `-<id>` tail at the 200-character limit (maximum-length duplicate slugs could previously loop forever).
- Link health probes plain `http://` bookmarks instead of recording every one as broken/denied. Only the bookmark probe opts in; every other outbound fetch stays HTTPS-only, and HTTP hops pass the same address, metadata-host, userinfo, pinning and per-redirect checks as HTTPS.
- Hardened egress keeps `HEAD` as `HEAD` across 301/302/303 redirects, so a link-health HEAD probe no longer turns into a GET that downloads the redirected body. Other methods keep the existing bodyless-GET downgrade.
- The development filesystem ledger-archive store writes every byte of each chunk before linking the content-addressed object; a short write could previously publish a truncated object under the full digest, and a zero-progress write now fails without installing the key.

### Security

- The self-hosted preset no longer opens a rolling seven-day plaintext legacy session-token window on every start. `BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL` is honoured only when the operator sets it explicitly.
- `fastify` 5.12.5 (GHSA HTTP/2 trailer DoS), `fast-uri` 3.1.8 / 4.1.5 (authority injection, host confusion, case normalization), `source-map-js` 1.2.2 and `fflate` 0.7.5 via overrides. The runtime install audits clean; `vitest` 4.1.11 clears the dev-tree `tinypool`/`@vitest/mocker` advisories.

### Upgrade notes

From 0.1.0-rc.5, update the checkout and `deploy/` files from the same revision,
set `COLP_IMAGE_TAG=0.1.0-rc.6`, and recreate the server. Migrations
`202610310900_automation_ready_input_checks` and
`202610311000_automation_bundle_retention` run at startup. Existing enabled
rules keep their execution policy when edited unless removal is explicit;
review the editor's choice before resuming held work.

The IP HTTPS fix requires the updated `deploy/compose.yaml`, both TLS Caddyfiles
and `deploy/caddy-entrypoint.sh` from the same revision. Update the checkout
(`git pull --ff-only`), then recreate the active ingress:
`docker compose --profile tls-internal up -d --no-deps --force-recreate caddy-tls-internal`
(use `tls-auto` / `caddy-tls-auto` for automatic HTTPS). Existing Caddy volumes
retain their CA and certificates, so this update does not require a new CA import.

Operators who relied on the implicit plaintext legacy session window must set `BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL` explicitly; new installations are unaffected.

Migration `202610290100_link_preview_object_bytes` adds the preview byte table. The self-hosted preset now defaults `DATABASE_POOL_MAX` to 12 and caps the worker's shared-pool reserve at 9 (two connections for link previews; `LINK_PREVIEW_CONCURRENCY`, default 2). An explicit `DATABASE_POOL_MAX` below 10 must be raised, or set `KNOWN_FEATURE_LINK_PREVIEW=false`.

Migration `202610260000_mcp_plan_receipt_owner_approval` widens a check constraint and runs at start. Rolling back past it deletes owner-approved Undo receipts (their saved versions stay in History). Scripts that treated a 404 from `/api/v1/auth/key-token` as "bad key" should also accept 401.

## [0.1.0-rc.5]

### Added

- Automations file new bookmarks into folders by Owner rules. The web app has an Automations page, a rule editor with side-effect-free preview, Run once with an explicit start, rule and run pages showing waiting work and the remaining allowance, Digests with an Unread filter, and per-bookmark run history. Automation plans appear in Approvals with effect-specific Undo.
- Agents can opt in as automation workers from the Agents page, pair with scoped targets and take jobs from an authenticated queue, either by polling or through MCP Events wake-ups delivered as signed HTTPS callbacks. Rules support explicit execution policies and optional daily work budgets.
- The self-hosted preset turns Automation on (`KNOWN_FEATURE_AUTOMATION_RULES`, `_CAPTURE`, `_ADMISSION`, `_WORK`, `KNOWN_FEATURE_MCP_WRITE` and `KNOWN_FEATURE_MCP_EVENTS`). Set any of these to `false` in `.env` to turn that stage off; each later stage requires the earlier ones.

### Changed

- The server depends on the published `@know-n/colp` 0.2.0 and uses its approval interactions directly; the image no longer copies a vendored build.
- Bulk canonical writes and large manual runs are batched and committed in resumable chunks.
- Dependency security patches for the server runtime and web app; Vitest coverage is migrated.

### Fixed

- Navigating settings keeps pending approvals in view, and the OAuth consent page no longer issues settings queries.

### Upgrade notes

From 0.1.0-rc.4, update the checkout and `deploy/` files from the same revision (`.env.example`, `INSTALL.md` and `restore.sh` changed), set `COLP_IMAGE_TAG=0.1.0-rc.5`, and recreate the server. Additive Automation migrations `202610300100` through `202610310800` run at startup.

With Events on and `AUTOMATION_WEBHOOK_MASTER_KEY` empty, the callback-signing key is derived from `COLP_SERVER_SECRET`; a set key must be canonical base64 of 32 bytes, or startup fails. `deploy/restore.sh` now pauses Automation after a restore, marks leased external attempts uncertain and requires event subscriptions to revalidate. The final 0.1.0 release has not been accepted.

## [0.1.0-rc.4]

### Added

- Restored favicon uploads, removal, source settings and durable missing-icon filling, with PostgreSQL storage by default, authenticated private reads and recoverable jobs.
- Gallery fetches bookmark preview images and serves validated copies from PostgreSQL on this server. Private collections request previews only when their owner or an editor opens Gallery.
- Approvals identify the requesting agent and preserve its stated reason. MCP write tools support URL elicitation for approval, resumable fallback and explicit write outcomes, with updated nodes available on request.

### Changed

- Sync supports ordered push batches with singleton recovery and incremental snapshot-capacity accounting. MCP reuses scoped tool catalogs and static tool definitions, and search results include node summaries and consistent page metadata.
- Refined Library sharing, visitor navigation, setup flows, Agents, consent and approval cards, profile names, and action feedback.

### Fixed

- Rotated browser sessions recover the current cookie and reject revoked credentials. Sync recovery uses fresh request authorization, renews retained checkpoints through Session negotiation, and accepts current-checkpoint Acks after idle renewal.
- MCP accepts calls without nonstandard client capabilities, validates parameter headers against advertised schemas, supports HTTPS CIMD agents, and keeps compatibility annotations and write receipt schemas valid for strict clients.
- Public pages no longer request third-party favicons. Favicon uploads use the command transaction, and failed external uploads and interrupted jobs recover without leaking orphan objects.
- Upgrades retain lazy-loaded web assets and prevent cached HTML from being served as stylesheets. The setup checklist shares the collection currently on screen.

### Upgrade notes

From 0.1.0-rc.3, update the checkout and `deploy/` files from the same revision, set `COLP_IMAGE_TAG=0.1.0-rc.4`, and recreate the server and active ingress. Database migrations run at startup, including the ordered-sync-batch migration and `202610290100_link_preview_object_bytes` for preview storage.

The self-hosted database pool now defaults to 12 connections. If `DATABASE_POOL_MAX` is explicitly below 10, raise it or set `KNOWN_FEATURE_LINK_PREVIEW=false`. `LINK_PREVIEW_CONCURRENCY` defaults to 2. The final 0.1.0 release has not been accepted.

## [0.1.0-rc.3]

### Changed

- Release candidate for the 0.1.0 acceptance runs, built from `main` with every change listed under Unreleased since 0.1.0-rc.2. Highlights: a manually approved agent plan saves a version and can be undone; `nodes.move` moves up to 50 nodes in one plan; plans on a collection over the 2,000-node history limit are rejected before they change anything; an agent's OAuth sign-in works when the owner is signed out; IP-based HTTPS works without SNI; link health probes plain `http://` bookmarks; the web UI is redesigned; Product API 1.93.0 adds `nodeKind` to search results and `username` to `/api/v1/me`.

### Upgrade notes

From 0.1.0-rc.2, update the `deploy/` files from the same revision (`git pull --ff-only`) and recreate the active TLS ingress, for example
`docker compose --profile tls-internal up -d --no-deps --force-recreate caddy-tls-internal`
(`caddy-tls-auto` for the `tls-auto` profile). Migration `202610260000_mcp_plan_receipt_owner_approval` runs at start. An operator who relied on the implicit plaintext legacy session window must set `BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL` explicitly. The final 0.1.0 release has not been accepted.

## [0.1.0-rc.2]

### Fixed

- Release smoke selects the AMD64/ARM64 child manifests from the exact candidate index, avoiding Docker's cross-platform index-digest pull conflict. Promotion still publishes the tested parent index without rebuilding.

### Upgrade notes

Pre-release for image-publication verification, including the latest main security fixes. The final 0.1.0 release has not been accepted.

## [0.1.0-rc.1]

### Added

- Release-workflow candidate for the self-hosted server, with HTML bookmark import, preview, destination-folder selection, and duplicate skipping.
- Production-stack browser acceptance for sign-in, editing, anonymous sharing, import, export, Sync center, and About.

### Upgrade notes

Pre-release for installation and image-publication verification. The final 0.1.0 release has not been accepted.

## [0.1.0]

### Added

- Self-hosted server.
- Username owner.
- Browser bookmark sync.
- MCP approval.
- Collection export.
- `colp-server ready` and `colp-server setup-token`.

### Changed

- Plain HTTP is allowed only on `127.0.0.1`, `localhost`, or `[::1]`, as COLP requires; the `http` profile publishes its port on 127.0.0.1. A LAN uses `tls-internal`.
- `backup.sh` writes `colp-backup-<timestamp>.dump`; `restore.sh` recreates the database and waits until the server is ready.
- An agent's trusted or manual policy belongs to the account that set it.

### Fixed

- Undo of a trusted agent plan refuses when the collection changed after the plan (sync, web edit, another agent) unless forced.
- The About page links to the shipped `CHANGELOG.md` and `INSTALL.md`.

### Security

- Plain HTTP stays off until `COLP_INSECURE_HTTP=true` acknowledges that transport.
- The first account needs the setup token printed in the server log, and the database admits only one owner.
- `COLP_MULTI_USER=true` is refused until invite codes ship in 0.3.0.

### Upgrade notes

none
