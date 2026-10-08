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
