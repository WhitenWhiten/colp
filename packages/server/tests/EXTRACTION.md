# Self-hosted test scope

The extraction keeps runtime tests for the shipped modules. Tests of social,
reports, governance, attachments and delivery are removed with those modules.
Know-N host acceptance scripts, private-extension fixtures and demo seed bundles
are not shipped in this package; their acceptance suites stay in Know-N.

The migration-chain helper is retained because kept migration and sync tests
use it. Edition-specific assertions expect the primary canonical event and
publication purge, without the removed feed/public-activity handler rows.

Production integration coverage includes the real composition for move,
delete, trusted approval, Undo, agent management and owner-bound key issuance.
The anonymous protocol gate is enforced by `deploy/smoke.sh`.

Restored from Know-N because they cover shipped promises (2026-10-08):

- `phase3/phase3-sync-http-postgres` and `phase3/phase3-sequence-entry-postgres`
  (sync over HTTP), with their harness in `scripts/acceptance` and
  `scripts/evidence`. A committed node update writes one outbox event here
  (Know-N also writes feed and public-activity rows).
- `phase3/phase3-server-sync-acceptance` and `phase3/phase3-sync-push-acceptance`,
  including their production HTTP/PostgreSQL adapters and fail-closed controls.
  The server acceptance binds to the published COLP conformance entry rather
  than source-only generated JSON files.
- `phase2/phase2-publication-acceptance` (publication, 10k Snapshot, cache
  partition, cursor rotation, fences, 410 retention, purge). The runner omits
  Know-N's real-stack browser probe, which drives Know-N's web e2e.
- `search/search-authorization-postgres`, with only the visibility barrier:
  moderation controls belong to the governance module, which is not shipped.

`mcp/nodes-search` moved from the unit project to the integration project
because it needs PostgreSQL.

Restored server acceptance suites (2026-10-08 follow-up):

- `phase2/phase2-profile-conformance`: real PostgreSQL ID persistence/restart,
  canonical validation/cycle/subtree transactions, conditional publication
  HTTP, and source-bound official COLP profile claims. Its deployment adapter
  binds to a clean repository HEAD and retains every server acceptance probe.
  The evidence verifier now matches the extracted runner's five probes;
  Know-N's web browser probe is excluded from both. The profile-claim boundary
  unit suite is restored, and the existing acceptance contract matches this scope.
- `postgres/postgres-phase4b-mcp-write-acceptance`: official MCP client write,
  approval/commit/replay/cancel lifecycle, read regression and transport headers.
  The report-source invalidation case is omitted with the removed reports module.
- `postgres/postgres-phase4b-mcp-snapshot-resources`: public/private cache and
  access, bounded 10k-node snapshots, sidecar omission and continuation expiry.
  Upload/finalize attachment fixtures and their two metadata leak cases are
  omitted with the removed attachment module; empty attachments assertions remain.

The restored suites import their evidence modules directly, rather than the
Know-N evidence barrel that also loads deleted social/report harnesses.

`npm run test:acceptance:profiles` runs the source-bound profile suite with an
owned disposable PostgreSQL container (requires a clean repository HEAD). All
three restored integration files are also included by `test:integration:inner`
and the existing six-shard server integration CI job.

## Static contract lane (2026-10-09)

The `static` Vitest project (`tests/unit/**/*-static.test.ts`, `npm run
test:static`) was extracted but never wired into a script or CI, so 17 of its
files still referenced Know-N paths. It now runs in the server CI job. Each
file was triaged against this repository; contracts were adapted where the
promise still exists here and removed only where the subject left with its
module. Nothing that guards a shipped runtime behaviour was weakened.

Adapted (the shipped promise is still asserted, against repository paths):

- `ci/caddy-colp-proxy-static` replaces `ci/docker-nginx-colp-proxy-static`:
  the self-hosted ingress is Caddy (`deploy/Caddyfile.*`), not Know-N's nginx
  templates. Every Caddy variant must route `/api/*`, `/collections/*`,
  `/.well-known/*`, `/colp/*`, `/health`, `/ready` to the server before the
  SPA catch-all and never fall back to static files. The nginx-specific
  report-shell, sitemap and `mcp-compat` locations belong to Know-N's web.
- `sync/outbox-continuation-static`: the dedicated
  `test:phase5:outbox-continuation` with-postgres script does not exist here;
  the three layers are asserted to exist and to be covered by the `postgres`
  project that `test:integration` wraps. `notifications/
  social-notification-worker-route.ts` left with the social module and is
  dropped from the no-continuation route list; the other four routes stay.
- `postgres/operation-payload-split-static`: the attachment canonical
  mutation port left with the attachments module. The insert gate now scans
  every `src/**/*.ts` file instead of a fixed list, so a new inserter cannot
  bypass `appendOperationWithPayload`.
- `postgres/outbox-retention-floors-migration-static`: the social Feed
  rebuild-density case (`infrastructure/social/feed-worker-postgres.ts`) is
  removed; migration, repository and schema-slice contracts remain.
- `postgres/ledger-retention-policy-static` and
  `postgres/ledger-archive-segments-migration-static`: the catalog CLI
  (`scripts/ledger-retention-policy.ts`), ADR 0023 and the archive runbook are
  Know-N documentation. The runtime invariants (`sourceDeletionAuthorized:
  false`, additive migration, CAS-only repository) remain.
- `auth/better-auth-migration-static` and `auth/better-auth-oauth-schema-static`:
  the frozen decision JSON under `packages/docs/decisions` is not shipped; the
  in-package frozen filename lists are the contract.
- `identity/public-profile-projection-migration-static`: the Phase 2B status
  history row (`docs/09-phase-execution-status.md`) is project history.
- `phase4b/phase4b-mcp-entry-gate-contract-static`: the evidence document and
  the host/client/probe harness files are not shipped; only
  `scripts/evidence/phase4b-mcp-entry-contract.ts` remains. The catalog,
  SDK lock, replay digest and production-boundary scans still run.
- `sync/sync-admission-routes-static`, `sync/sync-operation-effects-http-static`,
  `sync/sync-pull-page-evidence-static`: assertions on Know-N's multi-replica
  `devops/docker-compose.yml` (AUTH_API_REPLICAS, shared Redis Sync limiters,
  effect-page limit override, evidence maintenance default) are removed. The
  self-hosted `deploy/compose.yaml` is single-instance and runs server
  defaults. Observation for maintainers: Know-N's compose enabled
  `SYNC_EVIDENCE_MAINTENANCE_ENABLED` by default; the self-hosted preset leaves
  it (and `SYNC_TOMBSTONE_PURGE_ENABLED`) at the server default `false`. That
  is a deployment decision, not changed here.

Removed (the subject is not part of this package):

- `email/email-capture-preview-catalog-static`: Know-N `devops/frontend_capture`.
- `identity/identity-migration-static`: Know-N monorepo
  `check-auth-migration-boundaries.mjs` gate over `Known-Backend/...` paths.
- `phase3/phase3-multi-device-recovery-contract-static`: the multi-device
  recovery acceptance runner scripts are not shipped (the evidence unit test
  for the same feature remains in the unit project).
- `phase3/phase3-sync-ui-real-stack-static`: Know-N's web real-stack e2e
  harness, already excluded from the restored acceptance scope above.
