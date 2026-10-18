# Changelog

All notable changes to COLP Server are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- The Sync center shows each browser's own report. `GET /api/v1/sync/status` adds optional `health` (`state`, `code`, `since`, `reportedAt`, `issueCount`; `null` before the first report or when retired) to each replica, and `GET /api/v1/sync/replicas/{replicaId}/issues` lists the items it set aside and its latest Ack warnings. The device card says Stopped with the reason in plain words, Needs attention with the items on request, or Paused. A change held behind a conflict (`conflict_hold`) reads as waiting for a conflict on that bookmark.
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
