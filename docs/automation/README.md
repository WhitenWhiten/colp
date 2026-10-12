# Automation BE-1

Reviewed specification: [design/13-backend-first.md](design/13-backend-first.md),
[execution contract](design/11-execution-contract.md), [review findings](design/14-review-findings.md).
Imported unchanged from ~/ref/colp-automation-design, contract 0.2.1-design.
The reviewed date (2026-10-13) is one day after this environment's date; this is
specification provenance, not an assertion of execution date.

Baseline: e72b8912887c78e44018bfe4a8a8d29a826f993b, branch feat/automation-be1.
This worktree was explicitly authorized by the user's clarification; commits are per AW task.
The original checkout's CI edits and untracked extension are untouched.

## Verified integration facts

* No differences from design baseline 2ee8397 in the inspected session, Origin/CSRF,
  route-manifest, OpenAPI README, migration README, config and Web router files.
* Session cookies: __Host-known_session (TLS), known_session (explicit insecure HTTP).
  Cookie writes use the existing mutation actor, Origin policy and x-csrf-token.
* Known-Command-Id is a lowercase UUID v4 (stricter than the design's generic string).
  Reuse host command receipts, scope/fingerprint, current owner authority and strong If-Match.
* Authoritative OpenAPI source is openapi/product-v1.yaml (1.93.0), not a fragments pipeline.
  Generated bundle/routes/types are producer artifacts. No frontend client generation in BE-1.
* ProductErrorCode is frozen under ADR-0015. Add automation codes to the centralized
  drifted union and its status/recovery maps; use an automation-specific error schema
  for new routes without widening existing endpoints' error enum.
* Migration head: 202610290100_link_preview_object_bytes.ts. New migrations must
  sort after it; scripts/check-migration-order.mjs checks the pinned head or a supplied Git base.
* Whole-database pg_dump covers added tables. Restore must pause automation before server startup.
* Dependencies: independent npm packages (no root workspace). Shared automation is an optional
  @know-n/colp subpath; validate by local pack and consume through the server package lock.
* Extension reference 28acb4965 and external product-plan checkout are deferred.
  Untracked packages/extension in the original checkout is not an inspected baseline.
* Existing /ready reports installed composition readiness. BE-1 must separately expose
  automation runtime unavailable; a desired enabled rule remains effectively blocked.

## Scope and evidence

No UI, native browser runtime, worker, Events, models or canonical bookmark effects.
Each [evidence record](evidence/) lists executed checks and limitations.
