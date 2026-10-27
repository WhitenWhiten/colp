# Sync and ledger retention boundaries

This page fixes the boundary between evidence that maintenance may reclaim and
authority that must never be deleted automatically. It exists because a table
that is allowed to grow is still an operational problem, while deleting the
wrong authority is a correctness or compliance incident.

## Automatically reclaimed

The Sync evidence maintenance worker runs on a bounded schedule and may delete:

- Terminal Pull Ack receipts and the cursor/page evidence they had pinned.
- Terminated Sessions past the one-day grace window when no protocol child still
  references them, including their binding/scope/idempotency rows.
- Sequence lanes, claims and receipts belonging to retired Replicas.
- Expired bootstrap Snapshot pages, node rows, capabilities and headers; a
  recovery Ack receipt may retain only the small header and capability row.
- Expired Pull cursor evidence, recovery proofs, lineage and page evidence.
- Node revision history only below a materialized, archived history floor.

The worker is intentionally bounded. It uses `FOR UPDATE SKIP LOCKED`, row/time
limits, and small batches so a slow cleanup cannot block live Sync traffic.

## Never automatically reclaimed

The following are permanent or archive-gated authority. Maintenance does not
delete them:

- `operations`, `operation_payloads`, `audit_events` and
  `audit_event_payloads`: append-only correctness/compliance authority. Any
  physical purge requires the ledger archive control plane, verified archive
  evidence, legal-hold clearance and a fenced `ledger_payload_purge_jobs` job.
  The retention policy remains `correctness_blocked` or `compliance_blocked`
  until those gates are satisfied.
- `outbox_events`: the row that a fenced `ledger_payload_purge_jobs` job is
  authorized to remove. A normal maintenance transaction must not bypass the
  delete guard.
- `outbox_dispatch_claims`: permanent duplicate-delivery identity. The claim is
  deliberately retained after its queue row is purged; it is compact and is not
  a reclaimable payload.
- `resource_id_ledger` and other identity/non-reuse authority.

## Operational consequence

A deployment without ledger archive configured keeps operations, audit payloads
and dispatch claims indefinitely. That is the designed boundary, not a silent
cleanup bug. Capacity planning must account for the append-only ledger; the
operator should enable the archive/purge control plane and enqueue an authorized
purge job rather than issuing ad-hoc `DELETE` statements.

Sync-derived evidence listed under "Automatically reclaimed" is safe to leave to
the maintenance worker. Revision history and Outbox rows remain protected until
their respective floors/authorization exist.
