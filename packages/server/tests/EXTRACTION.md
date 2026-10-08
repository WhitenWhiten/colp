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
