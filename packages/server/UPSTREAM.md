Copied from Know-N commit c34645710eb3d0067ef734cf7a674364df765687 on 2026-10-07T08:48:49-07:00; later ports are diffs from this hash.

A7 re-synced MCP, product transport, migrations, and OpenAPI from Know-N `b490f54b59328014b1b101e714cc96590a6a23c1` (`git diff c34645710eb3d0067ef734cf7a674364df765687..b490f54b59328014b1b101e714cc96590a6a23c1` on the card paths). Current upstream for those trees is `b490f54b59328014b1b101e714cc96590a6a23c1`.

Dropped hunks:

- `src/transport/mcp/mcp-strict-application-adapter.ts`: the E5 hunk passed `reportReadPort`, `reportWritePort`, `communityPort`, and `moderationPort` into `createPhase4bMcpApplicationFacade`. A2 deleted those modules. Those four lines were dropped. `nodesSearch` was kept.
- `migrations/202610220500_agent_policies.ts`: the `ALTER TABLE collection_tree_versions` hunks (add `cause`, add `collection_tree_versions_cause_check`, and the matching `down`) were dropped. G5's `202610230100_collection_version_cause.ts` already owns the column. `202610230200_agent_plan_version_cause.ts` widens that check so `agent-plan:<planId>` is valid and the G5 literal `agent-plan` still is.

No other hunk targeted a file A2 or A3 deleted. The diff did not touch report, community, moderation, or attachment files.

`openapi/fragments/agents.yaml` replaced the A4 list, audit, and revoke stubs in `openapi/colp-server-v1.yaml`. GET/PUT `/api/v1/me/agents/{clientId}/policy` stay `x-colp-server-pending` (not in the fragment). `npm run openapi:generate` refreshed `generated/openapi` from `openapi/product-v1.yaml`. Historical `openapi/baselines/product-v1.*.yaml` snapshots were not rewritten.

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

A6 image (`packages/server/Dockerfile`): the web UI is built with `VITE_EDITION=self-hosted` and stored at `/srv/web`. Caddy serves it. `deploy/compose.yaml` mounts the named volume `colp-web` on `/srv/web` (read-only in each Caddy service). The Node process does not serve those files. An empty mount hides the image directory, so the same tree is also at `/opt/colp-web` and the entrypoint copies it into `/srv/web` only when that mount has no `index.html`. No second server, Redis, object storage, or mail server. Migrations are esbuild-bundled to `dist-migrations/` (D23) so the runtime image does not need TypeScript. The process is `node dist/src/bootstrap/self-hosted.js`.
