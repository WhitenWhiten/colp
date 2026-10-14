# Execution Contract: Boundaries That Must Not Drift

**Status:** normative design constraints for the proposed implementation; not evidence of deployed behavior. **Review date:** 2026-10-13. Preserve the architecture in chapter 01. Machine payloads live in the OpenAPI/JSON Schemas; task ownership lives in tasks.json. A conflict between them blocks the affected change until both are corrected. Neither a model nor a frontend may silently invent a third contract.

## 1. Scope and capability gates

M1 is deterministic placement with no agent. It accepts an intake rule with tasks=[], an empty target list and no executionPolicyId. Store a null execution-policy revision for an M1 run. Do not manufacture a worker, an execution policy, a model call, a zero-cost inference job or a subscription to satisfy an implementation shortcut. Shared definitions may describe later task kinds, but an M1 host rejects attempts to activate unsupported M2/M3/M4 functionality.

The first local backend slice supports draft creation, validation, current-state or supplied-facts preview and lifecycle control without executing bookmark effects. Runtime readiness must remain unavailable until the durable M1 composition is installed. A saved desired state is not proof that the engine is running. The frontend later renders backend desired/effective state and reasons; it does not implement those decisions.

MCP Events is the preferred hosted wake adapter, not an admission engine or a condition for running M1. A reachable local worker uses the same durable job contract by polling. This is not protocol events/poll. A hosted compatibility failure blocks that adapter's claim, not unrelated local development.

## 2. Authoritative identities and inputs

Use serverUuid/collectionId/nodeId for canonical resource identity. Folder labels and paths are presentation or portable-install inputs, not runtime identity. Renames never rebind to a same-name folder. Revalidate current permissions, ownership, live ancestry and sync range before an effect.

Native browser IDs, native observations and their generation mapping stay in the extension. A device receipt names canonical Sync operation IDs. For observed create-then-move, join both operationId and placementOperationId before accepting placement satisfaction. Verify the committed node namespace, device generation and pinned rule/binding/bundle. A receipt is advisory evidence, not authorization and not proof of summary/tags completion.

Job input digests include canonical identity, required revisions, the input-field allowlist, task/output-contract identity and accepted predecessor outputs. Never satisfy a predecessor by merely copying its type name. Read inputs through automation.jobs.inputs with current authority; unavailable input remains unavailable. A broad node-read tool separately granted to the same credential is not restricted by a job-only allowlist. Restricted workflows need dedicated least-privilege connection authority, not just a target with a private label.

## 3. Preview, activation and manual intent

supplied preview validates the provided bounded facts. currentState preview reads up to 200 authorized current bookmarks using existing canonical reads; it does not require the new historical-facts pipeline. retainedHistory is separately capability-gated and uses stored event-time facts. Never substitute one mode for another without saying so.

Preview performs no bookmark mutation, job creation or network/model execution. Persist only a short-lived preview record bound to Owner, normalized definition, bindings, policy when present, sampled inputs, relevant revisions and options. Enable requires that exact unexpired preview; changes require a new preview. The canonical committed ordinal supplies the activation fence even before the automation source reader is mounted.

Explicit user folder selection and later manual edits take precedence over rules. A root destination is a documented heuristic for unsorted intake, not proof that the user made no selection. A receipt grace-period timeout is not evidence of consent. The source adapter derives intake disposition from its verified command/receipt path; imported, restored, projected or unknown intent is not moved automatically. When the baseline cannot distinguish an explicit choice from a default, preserve the location and report the limitation rather than guessing.

The 3 s native-observation window is a proposed debounce policy. It is not a guaranteed signal that a browser dialog has closed. Subsequent manual edits always invalidate a conflicting automated move.

## 4. Canonical facts, admission and pause

The inspected baseline writes collection-lock → canonical-plan → allocation → resource → operation → audit → outbox (R03). Facts capture is a proposed addition, not an existing export. Capture before-state from locked planning inputs before mutation, capture after-state from the resulting canonical operation, append private facts after audit, and keep outbox scheduling last in the same database transaction. Do not add private data to closed/public COLP event payloads.

Automation ingestion uses a durable ordered route and an independent persisted inspection position. Inspection advances across irrelevant operations, without treating gaps in relevant facts as missing canonical ordinals. Admission deduplicates by the exact configured source/rule revision identity and pins immutable configuration. One retry of the same source produces no second run or effect. A failing rule is isolated from other rules.

Pause stops new admission/effects according to the explicit lifecycle state. Persist the inspected/skipped interval; resume takes a fresh committed high-water fence rather than accidentally replaying everything accumulated while paused. Pre-pause pending work is held/cancelled/resumed explicitly without silently rebasing its configuration. Capture of canonical facts can continue independently of admission.

An offline extension cannot learn a new server pause instantaneously. Rule bundles carry paused, a monotonic settingsRevision, expiry, profile, complete rule set and digest. Apply a full snapshot atomically; reject stale settings and expire locally. An older bundle cannot unpause a device that has learned a newer pause. Document the remaining offline exposure window instead of claiming instantaneous revocation.

## 5. Deterministic placement and M1 Undo

M1 canonical placement is authorized by the Owner's enabled rule and existing canonical write checks. It is not governed by the M2 per-agent Manual/Trusted policy. Record a placement effect with original destination only when proven, canonical operation identity, before/after revisions and explanation. Namespace nullable target partitions with an explicit sentinel so SQL NULL uniqueness cannot allow duplicate M1 effects.

AW-51 exposes a single effectReceiptId for Undo. A safe M1 Undo is a compensating canonical move under current Owner authority and conservative resource/content fences. It never deletes the newly created bookmark, guesses an unobserved original location or restores an entire collection over unrelated changes. Missing provenance or intervening edits yields undoAvailable=false with a reason or a conflict, not force restore.

Pre-save browser placement may not leave a separate canonical pre-placement state. Do not invent one. Show an explanation even when safe Undo cannot be established. Actual extension compensation remains extension-owned; the backend tests only the canonical receipt it can prove.

## 6. Worker identity, claim and recovery

Catalog memberships are independently opted-in standard, automationManager and automationWorker sets. An unpaired worker must be able to redeem an Owner-issued single-use pairing grant without manager scope or a pre-existing target binding. Pairing is available through MCP and authenticated worker HTTP. Job tools become visible only after the binding is established. The same authorization is enforced on calls, not merely listings.

The job ledger, not the webhook ledger, issues access handles in both wake modes. Handles locate work under current authentication; they are not bearer grants. Queue pagination/cursors bind the target and principal. Setup and reconnect reconcile through jobs.list; a missing wake event does not erase a durable job.

Claim increments a generation fence and returns a lease token; heartbeat and submission require that same generation/token and current authority. An expired lease does not prove an external model call had no effect or cost. Retry only under the explicit safe/uncertain policy. Budget reservations, accepted output reuse and retries share job/input/contract identity. Cancellation or revocation prevents new effects; it cannot undo an already sent external request.

## 7. Typed results and existing plan integration

A typed result is a proposal, never arbitrary operations or trusted executable instructions. Validate task/output contract, allowed input revisions, predecessor results, output bounds and subtree constraints. Revalidate immediately before canonical effects. Source content and model output are untrusted.

Do not assume the existing change-plan coordinator accepts an enclosing job database transaction. Persist a stable plan command identity and committing state, invoke the existing idempotent coordinator without holding the job lock across external work, then reconcile the canonical operation/version into a durable effect receipt. A crash after commit must look up the same plan/command; it must not create another plan because the job still looks leased. Unknown outcome remains committing/uncertain.

Manual policy leads to awaitingApproval; Trusted follows the existing reversible-plan rules (R07). Existing Undo is collection-version based with content fences, not arbitrary field-selective rollback. To expose a single-effect Undo, isolate an undoable plan unit and preserve conservative conflict checks. Do not expose force=true from automation. A multi-step job can be partial while its committed effect receipts remain visible.

Accepted metadata and run-level review/digest text do not need a fake canonical mutation plan. Store their typed outputs and lineage; show unread state only through the backend read model. M3 read markers name the last output actually viewed, not a wall-clock cutoff that swallows a concurrent new output.

## 8. Events and dot compatibility

The OpenAI webhook compatibility profile and the experimental upstream draft are distinct references; chapter 05 records the selected method/schema/error contract. In particular, do not replace the documented OpenAI callback error with a draft's provisional code. The pinned SDK must preserve capabilities.events and the method envelope; a docs reference is not a runtime test.

Sign exact serialized bytes. Reuse occurrence ID/body across retries and refresh the signing timestamp/signature each attempt. Reject unverified or non-public callback destinations at connection time, with no redirects or forwarded COLP credentials. A 2xx callback response is delivery acceptance, not claim, success or committed effect. In this design, 410 deactivates the subscription and 413 terminates that oversized occurrence; neither authorizes deletion of the durable job.

Reconcile pending jobs at bootstrap/reconnect, retain retryable wake state, and keep delivery failure separate from job failure. A host can group multiple events and receive duplicates or out-of-order events. Never assume bookmark:job:webhook:host-task is a 1:1 mapping. Use the summary-only fixture for a one-job assertion; the broader academic fixture declares three tasks.

A dot is an officially documented hosted-agent surface, not a new COLP credential class. Work/dot availability, identity isolation and the chosen network topology require actual account-specific evidence. No such hosted lifecycle was executed during this document review. Local fixtures prove only the fixture path.

## 9. Later features must not leak into the local starter

M3 count batches require a durable ordered remainder per pinned rule/epoch/partition, distinct-member admission, exactly N members per emitted batch and crash/concurrency tests (AW-57). A counter that loses the remainder is not a completed batch engine.

Run-once start submits an unexpired previewId/previewDigest for the exact immutable member/revision/options set. More than the v1 bounded maximum requires a smaller selection or an explicitly designed paginated operation; never silently truncate or re-query.

Portable templates strip runtime collection/target/policy authority and use symbolic install slots. Installation binds current identities and creates a draft with fresh validation/preview. The research-catalog example uses synthetic dataset accessions and research-group entity keys, with accepted metadata predecessors, controlled vocabulary and non-broadcast restricted targets. No real institution, person or catalog access is implied.

## 10. Evidence required to mark a task done

Record the checkout, schema version, actual command and observed result for the packet. Include negative tests and the relevant crash window, not just a success response. Backend-only evidence never counts as frontend, browser-store or real-host evidence. Offline document validation does not count as a production evaluator, PostgreSQL transaction, extension lifecycle or dot compatibility test. Use the independently scoped gates in chapters 12 and 13.
