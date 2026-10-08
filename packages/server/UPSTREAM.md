Copied from Know-N commit c34645710eb3d0067ef734cf7a674364df765687 on 2026-10-07T08:48:49-07:00; later ports are diffs from this hash.

A7 re-synced MCP, product transport, migrations, and OpenAPI from Know-N `b490f54b59328014b1b101e714cc96590a6a23c1` (`git diff c34645710eb3d0067ef734cf7a674364df765687..b490f54b59328014b1b101e714cc96590a6a23c1` on the card paths). The upstream base for those trees is `b490f54b59328014b1b101e714cc96590a6a23c1`; subsequent repair ports are recorded below.

Dropped hunks:

- `src/transport/mcp/mcp-strict-application-adapter.ts`: the E5 hunk passed `reportReadPort`, `reportWritePort`, `communityPort`, and `moderationPort` into `createPhase4bMcpApplicationFacade`. A2 deleted those modules. Those four lines were dropped. `nodesSearch` was kept.
- `migrations/202610220500_agent_policies.ts`: the `ALTER TABLE collection_tree_versions` hunks (add `cause`, add `collection_tree_versions_cause_check`, and the matching `down`) were dropped. G5's `202610230100_collection_version_cause.ts` already owns the column. `202610230200_agent_plan_version_cause.ts` widens that check so `agent-plan:<planId>` is valid and the G5 literal `agent-plan` still is.

No other hunk targeted a file A2 or A3 deleted. The diff did not touch report, community, moderation, or attachment files.

`openapi/fragments/agents.yaml` replaced the A4 list, audit, and revoke stubs in `openapi/colp-server-v1.yaml`. The original port left GET/PUT `/api/v1/me/agents/{clientId}/policy` pending; the 2026-10-08 repair adds their shipped schemas and the key-issuance endpoint. `npm run openapi:generate` refreshed `generated/openapi` from `openapi/product-v1.yaml`. Historical `openapi/baselines/product-v1.*.yaml` snapshots were not rewritten.

`src/infrastructure/database/postgres-mcp-oauth-revocation-store.ts` was outside the card paths. It implements `revokeClient` and checks `mcp_oauth_client_revocations` because the applied `McpOauthRevocationStore` port requires that method.

`src/infrastructure/search/postgres-nodes-search.ts` was outside the card paths. The applied `tests/unit/mcp/nodes-search.test.ts` imports `createPostgresNodesSearchPorts`. The port reads `SharedExposureFactsPort` from `modules/exposure` (A3 removed `modules/attachments`). `CollectionVersionCause` also accepts ``agent-plan:${string}`` so E4's pre-commit snapshot typechecks against G5's version column. Restore accepts `cause: 'undo'`. Manual version capture skips the cooldown for an `agent-plan:` cause.

Extra files, copied because `npm run typecheck` failed without them (`TS2307` on imports from `src`; `seed` and `scripts/evidence` were not copied):

- `generated/openapi/product-v1.ts` — imported by `src/transport/product-codes.ts` and `src/modules/identity/application/credit-ledger-read.ts`
- `generated/openapi/product-v1.routes.ts` — imported by `src/transport/product-route-manifest.ts`
- `generated/openapi/product-v1.client.ts` — imported by unit tests (`product-v1.client.js`) and read by OpenAPI contract tests
- `generated/openapi/product-v1.bundle.yaml` — read by OpenAPI catalog and sync-center contract tests
- `generated/openapi/product-v1.routes.json` — read by product route manifest and search OpenAPI contract tests

A2 moved the email delivery ports out of `modules/notifications` into `modules/email` so that module could be deleted while the kept mailer still typechecks.

A2 copied these because `npm run test:unit` could not load Vitest projects without them (Know-N `c34645710`):

- `vitest.workspace-projects.ts` — imported by `vitest.unit.config.ts` and the other project configs
- `scripts/vitest-project-files.mjs` — imported by `vitest.workspace-projects.ts`

A6 image (`packages/server/Dockerfile`): the web UI is built with `VITE_EDITION=self-hosted` and stored at `/srv/web`. Caddy serves it. `deploy/compose.yaml` mounts the named volume `colp-web` on `/srv/web` (read-only in each Caddy service). The Node process does not serve those files. An empty mount hides the image directory, so the same tree is also at `/opt/colp-web` and the entrypoint refreshes `/srv/web` on every start so upgrades replace the frontend and remove stale assets. No second server, Redis, object storage, or mail server. Migrations are esbuild-bundled to `dist/migrations/` by `npm run build` (D23) so the runtime image does not need TypeScript. The image runs `colp-server start`, which loads `dist/src/bootstrap/self-hosted.js`.


Execution audit fixes (2026-10-08): completed the missing production wiring for
node planning, search, agent policy/directory, trusted approval and Undo. Added
the omitted sync tombstone adapter and verified both folder/subtree and single
node deletion. Back-ports retain Know-N's social and attachment composition.

The self-hosted OAuth issuer now matches Better Auth's `/api/v1/auth` issuer and
publishes the read/commit scopes required by the mounted tools. Built-in JWKS
verification reads public issuer keys and automation public keys locally;
external issuer overrides continue through the network JWKS provider.

The exact `@know-n/colp` pin is 0.1.1, incorporating the main branch's security
fixes. Publication cursors bind their resource/collection, and Sequence writes
prove durable Replica ownership before receipt lookup. F2 protocol additions
remain local pending a separate package release.

Edition metadata uses the URI-named mount extension
`https://know-n.com/colp/extensions/server`; no undeclared protocol feature keys
are emitted. Web and extension readers also accept older feature metadata.
`deploy/smoke.sh` enforces the anonymous core+publication conformance runner.

The extracted integration inventory now follows `tests/EXTRACTION.md`.
Removed suites target deleted modules or private host acceptance/extension/seed
harnesses. Kept migration suites regain `scripts/lexical-migration-head.mjs`;
kept classification tests use a local golden fixture. Outbox tests assert the
remaining canonical/projection/purge events and sidecar work.

Named browser-issued agent keys reuse the existing command-receipt credential
issuer, bind the owner account, disclose the secret once, and exchange only for
MCP audiences. Policy reads and writes conceal agents owned by other accounts.

Publication snapshot pages use the producer's complete-scope authorization
before SDK serialization: a continuation page may legitimately reference nodes
on an earlier page. Anonymous pages require the public projection and apply
public-wire redaction, with Cookie/Authorization Vary and revalidation headers.
The same route repair and its HTTP regression assertions are back-ported.

Shared runtime repairs are back-ported in Know-N integration commit
`903b86113` (2026-10-08), verified with owner-bound key and production MCP
composition regressions. Self-hosted extraction/deploy/web changes stay here.

Drift and bug fixes from the 2026-10-08 execution review (07):

- Migration order. Kysely runs with `allowUnorderedMigrations` off, so a
  migration whose name sorts before the newest applied one makes every
  installed server refuse to start. A migration ported from Know-N keeps its
  name only when it sorts after the public head; otherwise rename it past the
  head and record the rename here. `202610230300_agent_policy_owner_and_commit_revision`
  is identical in both trees. `202610230400_colp_single_owner_guard` is
  public-only (D27).
- Shared runtime changes back-ported to the Know-N integration branch:
  agent policy keyed by `(principal_id, client_id)`; the plan commit records
  each touched collection's content revision in `mcp_plan_commit_revisions`
  inside the commit transaction, and Undo refuses with `newer_changes` when
  the live revision moved (unless forced); agent key issuance moved to
  `infrastructure/auth` and is injected by bootstrap; facade exports that keep
  `check-import-boundaries` green; test fixtures for `@know-n/colp` 0.1.1
  (cursor scope `collectionId`/`resourceId`, listen authorization, Replica
  ownership verifier, loopback egress policy).
- Public-only: setup token and single-owner trigger, loopback-only HTTP (D26),
  `COLP_MULTI_USER` refusal, deterministic automation signer, CLI symlink
  entry, backup/restore rewrite, web edition assets, and the restored
  integration suites listed in `tests/EXTRACTION.md`. The restored
  `phase2-publication-acceptance` runner omits Know-N's real-stack browser
  probe.


Self-hosted sync and search (2026-10-08, public-only):

- The preset turns on Sync Sessions. `parseExtensionAuthConfig` takes
  `allowLoopbackHttp`, the sync retire Manifest extension accepts a loopback
  http href, and the product route coverage check is skipped when
  `KNOWN_EDITION=self-hosted` (it lists Know-N's full route table).
- `allow_search_indexing` is only the public discovery opt-in. The owner and
  member search branches and the authority recheck no longer require it, and
  `202610240000_search_member_recall_without_opt_in` rebuilds the two
  collection member recall GINs without it in their predicate. Know-N still
  requires the opt-in for member search; port search changes with this in mind.

I2 browser acceptance (2026-10-08):

- Restored the server-sync and sync-push acceptance suites and their production
  HTTP/PostgreSQL runners. The conformance binding reads the published
  `dist/conformance/index.js`; source-only generated JSON is not in the npm
  artifact. That binding correction is also applied in Know-N.
- Public-only: the self-hosted built-in MCP issuer accepts private HTTPS when
  issuer, audience, metadata, and JWKS all stay on the configured server origin.
  The same assertion applies at config load and runtime re-assertion. Cloud
  production policy stays strict, and HTTP still requires the explicit
  acknowledgement and a loopback origin.

Remaining server acceptance restoration (2026-10-08):

- Ported profile conformance, MCP write acceptance, MCP snapshot resources and
  their necessary adapters from Know-N `be1fd1cec`. Direct evidence imports
  avoid restoring deleted domain harnesses. See `tests/EXTRACTION.md` for scope.
- Public-only: profile evidence validation uses the same five server probes as
  the extracted publication runner, instead of requiring Know-N's web browser
  probe. Source identity resolves the public repository root before provisioning
  a deployment; official COLP package evidence remains the final claim authority.
- Restored the profile-claim boundary unit suite and source identity helper;
  repaired the existing acceptance contract's obsolete browser assertions.
