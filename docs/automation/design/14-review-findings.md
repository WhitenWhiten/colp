# Review Findings and Revision Summary

**Reviewed:** 2026-10-13. **Input authority:** the uploaded revised design pack. **Output:** corrected design/contracts and a separated implementation plan, not application code. The original overall direction is retained: pure deterministic intake, durable server orchestration, typed worker results through existing authorization/plans, and Events as the preferred hosted wake adapter with reachable-worker polling as an alternative.

## 1. Material corrections

| Finding in the supplied pack | Why it mattered | Revised contract / task |
|---|---|---|
| Hosted support, selected topology and COLP interoperability were not consistently separated | A documented provider feature could be mistaken for an already tested integration | Chapter 05 and provenance in chapter 08; AW-02/AW-46 distinguish real evidence from fixtures |
| OpenAI webhook profile and evolving experimental Events draft could be conflated | Method support and callback error numbers differ | Keep the documented OpenAI callback code/profile; do not import draft poll/push/control behavior |
| Worker catalog lacked a ready-queue list, and pairing depended on manager authority | A worker-only bootstrap/reconnect could not complete | automation.jobs.list plus worker-only MCP/HTTP pairing; 15 descriptors |
| Catalog selection behaved as mutually exclusive modes | Manager and worker permissions could not be composed clearly | Explicit catalogs[] with separate Owner opt-ins and scopes |
| M1 rule input required an M2 execution policy | The allegedly independent deterministic release needed a dummy agent configuration | Optional policy for M1, explicit null revision, tasks=[] and independent fixtures |
| Local receipt exposed browser-native observations/identities | Contradicted canonical/native separation and invited unverified satisfaction claims | Canonical-only receipt, server namespace and operation joins; only advisory classify.root satisfaction |
| Bundle contract omitted pause/settings state | Offline installations could keep using or reapply stale state | Full atomic snapshot, paused/settingsRevision and expiry; disconnected pause latency is explicit |
| Prefix matching could be approximated by contains | A condition could silently match unrelated paths | Literal startsWith in the bounded DSL and boundary fixtures |
| Capture/write-order description treated proposed facts as existing behavior | Risked modifying closed events or breaking transaction order | Preserve inspected canonical order; append private facts before final outbox scheduling |
| Source inspection, admission, pause and resume were not fully distinguished | Skipped intervals could be replayed unintentionally or inspection could stall | Durable inspected/skipped fences and fresh activation/resume high-water |
| Grace-period expiry/root placement was overinterpreted as user intent | Automation could override an explicit/manual choice | Verified source disposition; unknown/import/restore/projection not moved automatically |
| Plan effects were described as if an enclosing job transaction were already supported | A crash between canonical commit and job receipt could execute twice | Stable plan command plus committing/reconciliation; no presumed outer transaction API |
| Existing collection-version Undo was called effect-scoped without its constraints | Restoring one effect could revert unrelated changes | Conservative isolated plan unit for M2; separate compensating placement Undo for M1 (AW-51) |
| One bookmark, job, delivery and hosted run were presented too closely as 1:1 | Multiple declared tasks, retries and host event grouping invalidate that assumption | Separate summary-only one-job fixture from the broader three-task fixture |
| Run-once start repeated mutable selection rather than committing a pinned preview | Executed members could drift after the Owner reviewed them | previewId/previewDigest with immutable members, revisions and options |
| Count batching and digest persistence had no sufficiently explicit backend owner | UI work could conceal missing executable behavior | AW-57 aggregator and AW-58 output/unread storage, separate consumer tasks |
| Portable templates retained runtime identities or execution authority | Import could inadvertently bind to the wrong environment | Symbolic install slots, fresh binding and draft activation |
| Mixed packets combined service, Web and extension work | Each side could block or quietly reimplement the other | 66 single-lane packets; chapters 12/13; file-ownership.json |
| Package publication, live hosted M0 and full browser release gates blocked local backend progress | Local work inherited unnecessary external dependencies | Local package validation, BE-1–BE-5 schedule, AW-66 M1 backend gate, AW-64 polling gate |
| Current-state preview was in prose but not the wire enum | The first API slice could depend on an unbuilt historical-facts service | Explicit currentState mode with bounded canonical reads |
| Generated file map inferred “new” from a missing reviewer's local checkout | Existing paths could be mislabelled as new | Explicit verify-at-AW-01 status, never an absence-based repository claim |
| Informal catalog example was unsuitable for formal documentation | It obscured the reusable metadata/entity-map workflow | Synthetic institutional research dataset catalog, research-group directories and controlled vocabulary |

## 2. What was verified, and what was not

Primary OpenAI Events/dot references and the experimental MCP sketch were checked. Selected source was read at COLP commit 2ee8397cc20008e7865f2a080c91be2d38d323ae: canonical mutation order, the MCP SDK boundary, and agent policy/Undo. Foreground classification was read at the extension reference 28acb4965. Chapter 08 records the exact references and separates them from inherited baseline assertions.

The shared-chat body and local product-plan repository were not available as readable evidence. No codebase was rebased, deployed or modified. Remaining inherited repository paths/names are explicitly subject to checkout verification at AW-01 rather than silently presented as rechecked facts.

Only document/contract validation was executed here. Read validation/report.md for the actual check results. All AC acceptance scenarios remain planned_not_executed. There was no real database fault suite, browser lifecycle, model invocation, callback delivery, dot run or store approval during this review.

## 3. Using the revision

Begin at chapter 13 for backend-only local work. Read chapters 11 and 12 before implementing a packet. Use tasks.json and backend-batches.json for ownership/dependencies, OpenAPI/JSON Schemas for wire shapes, and the runnable validation scripts to catch drift after edits. Do not substitute prose, generated client assumptions or a provider demonstration for the canonical contract and test gates.

The corrected pack is a reviewed implementation plan with known external gates, not a guarantee that future code contains no defects. The remaining uncertainties are named and bounded so they cannot silently turn into claimed capabilities or runtime dependencies.
