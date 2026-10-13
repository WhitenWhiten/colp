# Automation backend

Reviewed specification: [design/13-backend-first.md](design/13-backend-first.md),
[execution contract](design/11-execution-contract.md), [review findings](design/14-review-findings.md).
Imported unchanged from ~/ref/colp-automation-design, contract 0.2.1-design (reviewed 2026-10-13).

Branch `feat/colp-automation`, based on `main` at f5817fa. The BE batches were originally
developed from e72b891 and merged; commits are per AW task, followed by review fixes R1–R16.

## Verified integration facts

* No differences from design baseline 2ee8397 in the inspected session, Origin/CSRF,
  route-manifest, OpenAPI README, migration README, config and Web router files.
* Session cookies: __Host-known_session (TLS), known_session (explicit insecure HTTP).
  Cookie writes use the existing mutation actor, Origin policy and x-csrf-token.
* Known-Command-Id is a lowercase UUID v4 (stricter than the design's generic string).
  Reuse host command receipts, scope/fingerprint, current owner authority and strong If-Match.
* Authoritative OpenAPI source is openapi/product-v1.yaml (Product 1.96.0 on this branch; main
  is 1.93.0). `scripts/sync-automation-openapi.mjs` mirrors the design's
  `design/api/automation.openapi.yaml` into `openapi/fragments/automations.yaml` and the owned
  inline blocks of product-v1.yaml (`npm run openapi:automation` checks it); the remaining
  bundle/routes/types are producer artifacts. No frontend client generation in BE-1.
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

BE-1 through BE-5 local backend packets are implemented, including polling, Events protocol fixtures, immutable manual previews, count batches and run outputs. UI/native browser runtime and real dot production acceptance remain separate gates.
Each [evidence record](evidence/) lists executed checks and limitations.
The [post-review fixes](evidence/post-review-fixes.md) list every review finding with its
commit, and the findings deliberately left unchanged.

## Running the configuration slice

The flags follow the design rollout order (07 §7); each requires the ones before it, and
API and worker must use the same values. `KNOWN_FEATURE_AUTOMATION_RULES=true` mounts the
authenticated `/api/v1/me/automations` routes (configuration/validation/preview only); default
false conceals the entire feature. `KNOWN_FEATURE_AUTOMATION_CAPTURE=true` records canonical facts
in shadow mode; with it off no bookmark mutation writes facts or automation Outbox rows.
`KNOWN_FEATURE_AUTOMATION_ADMISSION=true` (requires RULES and CAPTURE) enables runs and
deterministic intake after migrations; without it desired enabled remains blocked.
`KNOWN_FEATURE_AUTOMATION_WORK=true` (requires ADMISSION and `KNOWN_FEATURE_MCP_WRITE`) mounts the
worker surface, and `KNOWN_FEATURE_MCP_EVENTS=true` (requires WORK) adds Events wake-up. The
pre-design names `KNOWN_FEATURE_AUTOMATION_CONFIGURATION` and `_RUNTIME` are rejected at start-up. M1 creates no model jobs.
The deployment secret and existing Product session/CSRF configuration are reused.

## Resolved contract conflicts

* Reviewed ChangeInput requires executionPolicyId while M1 explicitly forbids a
  dummy policy. contract-adjustments.json makes it optional in generated core and
  backend mirrors; nonempty policies are rejected on the M1 host.
* The reviewed ScopeSpec schema permits an empty object. Semantic authorization
  requires an explicit collection or resolvable folder role; no all-owner scope is inferred.
* The design's fragment pipeline differs from this checkout. A deterministic sync
  script maintains producer mirror fragments/automations.yaml and owned inline
  blocks in product-v1.yaml; normal OpenAPI generation remains authoritative.
* Added GET /pause to discover the revision required by the existing If-Match
  contract, DELETE /rules/{id} as archival (immutable history retained), and DELETE
  /binding-sets/{id} only for never-referenced sets to fulfill the requested CRUD.
* Updating an enabled definition pauses that configuration; fresh preview/enable
  is required. Paused/archived operations remain available after dependency loss.
* Current-state previews use clearly identified hypothetical current snapshots;
  unknown intake intent preserves placement. No history or consent is fabricated.
* Pageable database timestamps preserve PostgreSQL microseconds in opaque cursors;
  wire display timestamps do not become pagination authority.

## BE-1 final boundary

M1 stores `tasks: []` as required by the reviewed schema; omission of the tasks
property is a shape error, while no agent task, policy, target or credential is required.
Semantic rebinding pauses every enabled referencing rule and invalidates its preview;
canonical label refresh leaves binding and rule revisions intact. Global resume captures
a new pinned-source ordinal even while current folder authority is blocked. This private
fence is never an authorization grant. Health recovery cannot repair acknowledged incidents
without passing current revalidation. No runtime execution profile is advertised.

Product 1.95.0 adds dependency/incident read and revalidation operations, preserving the
immutable 1.94.0 and 1.93.0 baselines. `/ready/features/automation` reports runtimeUnsupported
independently of the usable configuration API and the server's general readiness.

The vendored local package is refreshed with
`node packages/server/scripts/refresh-automation-package.mjs`; this builds/packs the actual
shared source, updates both locks and keeps Docker's dependency stages reproducible.
Public npm publication, real Chrome/MV3 CSP/store acceptance, real deployed restore and
BE-2 effect/admission/Undo evidence are separate future gates.

## Self-review correction

The [self-review report](evidence/self-review.md) supersedes the original unconditional
completion statement: it records eight reproduced and fixed defects, targeted regression
evidence, contract drift and remaining validation limits. New installations and existing
BE-1 installations apply the forward-only 202610300300 revision-delete guard migration.

The same report records the independent follow-up against 60fe77f: six additional
preview/dependency-health defects were reproduced and corrected with PostgreSQL
regressions. Configuration readiness still does not imply an installed effect runtime.

The foundation follow-up to 39e15f4 unifies stage binding assessment, separates typed
evaluation from preview presentation and activation policy, validates role dependency
graphs, and isolates health test fixtures. See ADR-BE1 and the final evidence section
for intent/satisfaction semantics, versioned preview fingerprints and executed checks.


## BE-2 runtime boundary

Canonical commits capture private event-time facts. The durable automation Outbox route waits
ten seconds for device evidence, inspects committed operations in order and admits pinned M1
runs. Proven-default Web/MCP root creates are placed through canonical moves; explicit folders,
imports, restores, unknown Sync intent, projection delivery and newer manual edits do not cause automatic reparenting.
The existing collection-version capacity (2,000 live members) applies: larger histories block
placement with an explanation rather than bypassing the history prerequisite. Worker model
budgets do not throttle deterministic placement.

Owner APIs expose runs, per-bookmark history (collectionId + nodeId), cancellation and conservative
single-effect Undo. Device routes reuse bearer + Origin + Known-Sync-Session, and mutations need
Known-Command-Id. Bundles carry complete finite definitions; host/tag hints are not semantic authority.
Pause skips admission intervals; resume uses fresh fences and durably wakes eligible pinned work.
Global pause does not overwrite explicit per-run holds. Explicit `continuePinned` applies to
pending runs across the rule's immutable revisions, preserving their original rule and binding pins.
Restored backups start paused. See per-task evidence for actual tests and remaining product gates.


The final BE-2 gate enforces the reviewed manual-intent rule: Product create accepts optional
`intakeDisposition: userDefault | userSelected`; omission is unknown and preserves even a root.
MCP create derives default only when parentId was omitted. Ordinary Sync creates have unknown
intent and are preserved; verified canonical device receipts still establish placement satisfaction.
This explicitly supersedes the root-only heuristic described in the initial AW-33 evidence.
Reviewed defaults are 10-second receipt grace and 7-day bundle expiry (clients should refresh every
5 minutes); offline pause exposure is bounded by that expiry, not instantaneous revocation.

Bundle `settingsRevision` orders all owner configuration changes, independently of the Pause API
ETag. Rule, binding and pause mutations advance that sequence; migration and restore advance it
past previously issued snapshots. Device bundles and receipts require the installed runtime flag.
The [BE-2 independent review](evidence/be2-review.md) records reproduced lifecycle/receipt defects,
their fixes, test-quality corrections and the final validation limits.

The [combined BE-1/BE-2 foundation review](evidence/foundation-review.md) checks the configuration
and runtime together. Reasserting an existing pause/enable state preserves the admission interval.
Editor configuration and preview remain available, but M1 activation, execution health and device
bundles require the current collection Owner. Run reads expose bounded explanations and explicit
holds; newly verified late effects advance the Run ETag without reviving cancelled work.

## Run-level output consumer contract (AW-58)

`GET /api/v1/me/automations/runs/{runId}/outputs` returns accepted digest/review
text with job and target provenance. `output.text` is **untrusted plain text**:
render with a text node / escaped text binding, never as HTML or executable Markdown.
The API returns JSON and does not rewrite evidence or the persisted model result.
If current Owner/collection access is unavailable, output reads fail closed rather than
returning retained private text. When a bookmark a job read is deleted, only that job's
outputs are withheld; other outputs of the run stay readable. Output pagination is stable
by `(createdAt,id)`.

Read the current Run ETag, then POST `/runs/{runId}/read` with
`{ "throughOutputId": "the-last-output-actually-viewed" }`, `If-Match`, CSRF and
`Known-Command-Id`. A later output remains unread. Output rows and read watermarks
persist across process restart; digest discovery does not depend on callbacks.
