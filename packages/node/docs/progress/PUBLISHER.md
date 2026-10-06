# Publisher Progress

## Profile Quality Gate (2026-07-20)

- Dedicated coverage: `npm run test:coverage:publisher` executes every Publisher contract plus the Deletion Receipt Schema contract against all `src/publisher/**/*.ts`; 16 files / 471 tests pass with 88.35% statements, 88.43% branches, 98.66% functions, and 89.83% lines. The default `npm run check` enforces minimum Publisher thresholds independently of the repository-wide coverage gate.
- Semantic mutation: `npm run test:mutation:publisher` targets the security-, transaction-, identity-, and resource-budget decisions repaired during Publisher acceptance. Stryker executes 179 non-static, non-diagnostic-text mutants: 165 killed, 2 timed out, 12 survived, 0 without coverage, for a 93.30% score against an 80% break threshold. The surviving mutants are redundant preconditions or equivalent transformations whose removal does not change an observable protocol result.
- Package evidence: the clean source revision `17c0089a08a0394b262eddc1e6992384c8ddc26a` generated 168 verified records. Publisher has 100/100 verified records across its dependency closure and no missing MUST / MUST_NOT evidence.
- Property testing: canonical idempotency requests are generated as protocol-valid bounded I-JSON, including safe integer, Unicode scalar, depth, and prototype-key constraints; repeated randomized runs pass without shrinking to out-of-domain values.
- Security and dependency review: `npm audit` and `npm audit --omit=dev` report zero known vulnerabilities. The audit repaired unsafe canonical integer/depth/member handling, mutable replay snapshots, Header injection, adapter/UnitOfWork false-success paths, and incomplete deletion identity binding.
- Performance review: Publisher Move Position contexts and Core authoritative graph planning share explicit node budgets; a 3,000-level subtree regression verifies linear ancestry planning within the test timeout.
- Deployment boundary: library-level conformance does not prove a host's database durability, rollback, serializable isolation, cross-process uniqueness, Outbox atomicity, or unknown-commit reconciliation. A concrete deployment must pass `publisher.transaction-contracts` with opaque evidence from its real transaction adapter before claiming deployment-level Publisher conformance.

## PUBLISH-0016

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/node-delete.ts` snapshots the canonical DELETE request and hostile ports, derives exactly `delete_node` or `delete_subtree` from `recursive`, requires `nodes:delete` before authoritative graph traversal, composes PUBLISH-0013 concealment and the transaction-bound Core guard, binds the exact Core-derived deletion membership to one canonical Operation application, and verifies deleted post-state, the surviving Parent, application ledger, internal Watermark membership, cursor-free Deletion Receipt identity/revision/scope/`affectedCount`, and exact plan equality before commit; `src/server/node-write-guard.ts` supplies bounded authoritative Parent/Child traversal and per-member authorization, policy, and read-only enforcement; exported through `src/publisher/index.ts` and the package root
- Evidence tests: `publisher.node-delete-subtree` (`tests/publisher/publish-0016-node-delete-subtree.test.ts`, 55 tests), plus the 3,000-level linear ancestry regression in `tests/core/phase1-node-write-guard.test.ts`, 6,183 affected Publisher/Core/server/security/schema/sync tests and the full 7,933-test Vitest suite
- Initial/final dedicated result: initial 52 tests = 18 passed / 34 failed (including one 5,000 ms timeout); final 55 tests = 55 passed / 0 failed
- Acceptance repairs: corrected the Publisher boundary to derive `delete_subtree` from canonical `recursive=true` instead of requiring a caller-prelabelled `delete_subtree` action, mapped malformed canonical request envelopes to registered `422 invalid_document` without graph traversal, replaced the test-only direct mutation shortcut with the actual transaction-bound `applyOperations` and Core-plan ledger contract, corrected false-positive missing/repeated `If-Match` and application-internal TOCTOU expectations, added missing/extra/duplicate internal Watermark membership rollback coverage, and cached already-validated authoritative ancestry so subtree policy planning remains linear in member count
- Registry and generated assets: canonical and fixture PUBLISH-0016 map to implementation `[publisher, server]` and test ID `publisher.node-delete-subtree`; the bundled clean-revision evidence and generated traceability mark the requirement Verified.
- Acceptance count: 2 (fresh independent acceptance and performance re-acceptance)
- Commit subject recommendation: `feat(colp): enforce authoritative atomic node subtree deletion`
- Protocol-Correction: no
- Host-owned residual risk: the host must place its durable outer PUBLISH-0010 idempotency claim/replay boundary around this coordinator and implement the supplied unit of work as one real serializable database transaction or locked snapshot spanning scope authorization, concealment, authoritative Collection/Node/Parent/Child reads, Core plan binding, canonical Operation application, exact business deletion, Parent Children Revision advance, deletion ledger, internal Watermark, receipt, audit, Outbox, and commit. Durable isolation must serialize competing deletes and prevent cross-process TOCTOU; the application service must consume the bound member set exactly once and must not accept adapter descendants. This coordinator fails closed on malformed/partial/hostile results and unknown commit outcomes, but cannot prove host rollback, durability, cross-process isolation, or reconcile an unknown commit; retry/reconciliation remains host-owned under the same idempotency binding.

## PUBLISH-0015

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/node-move.ts` snapshots the request and hostile ports, composes the transaction-bound Publisher/Core security guard, validates authoritative Node/source Parent/target Root-or-Folder/anchor contexts and same-Collection/cycle/read-only rules, enforces Node `If-Match` plus both Children Revisions (equal for same-Parent moves), applies exactly one canonical atomic `move_node`, and validates its exact receipt, transformed Position, authoritative post-state, advanced Parent revisions, and `NodeMoveResult`; `src/server/node-write-guard.ts` includes authoritative source Parent and authorization-only sibling anchors in the Move plan without treating read-only anchors as mutated resources; exported through `src/publisher/index.ts` and the package root
- Evidence tests: `publisher.node-move-concurrency` (`tests/publisher/publish-0015-node-move-concurrency.test.ts`, 59 tests), plus 5,019 affected Publisher/Core/server/security/schema tests and the full 7,878-test Vitest suite
- Initial/final dedicated result: initial 58 tests = 39 passed / 19 failed; final 58 tests = 58 passed / 0 failed
- Acceptance repairs: preserved authorized authoritative Node revision/ETag recovery metadata on 428/412; classified stale/unequal Children Revision context as retryable registered `409 position_context_stale` while retaining post-precondition Operation conflicts as `409 revision_conflict`; removed the read-only mutation veto from authorization-only anchors; repaired a non-leakage assertion whose unbounded `source` pattern falsely matched `resource_not_found`; updated the concurrent-loser assertion for the exact 412 recovery result; bounded each complete authoritative Position context by the resolved `maxVisitedNodes` ceiling and mapped overflow to registered `413 payload_too_large` before application
- Registry and generated assets: canonical and fixture PUBLISH-0015 map to implementation `[publisher, server]` and test ID `publisher.node-move-concurrency`; the bundled clean-revision evidence and generated traceability mark the requirement Verified.
- Acceptance count: 2 (fresh independent acceptance and performance re-acceptance)
- Commit subject recommendation: `feat(colp): enforce atomic node move concurrency context`
- Protocol-Correction: no
- Host-owned residual risk: the host must implement the supplied unit of work as one real durable database transaction/locked snapshot covering authentication, authorization, concealment, authoritative Node/Collection/Parent/anchor reads, revision checks, canonical Operation application, resource mutation, receipt, audit, Outbox, and commit. Durable isolation must serialize concurrent movers and prevent cross-process TOCTOU; the application service must atomically advance both Parent Children Revisions (once for a same-Parent move) and return authoritative post-state. This coordinator fails closed on malformed ports/results and unknown commit outcomes, but cannot prove host rollback, durability, cross-process isolation, or reconcile an unknown commit; retry/reconciliation belongs behind the host idempotency binding.

## PUBLISH-0014

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/node-create.ts` snapshots the server-resolved Node ID and canonical `nodeCreateRequest`, composes the PUBLISH-0013 Publisher/Core security guard, resolves the authoritative Collection and Root/Folder Parent through the same transaction context as reservation and creation, permanently reserves the global Node ID, applies one canonical `create_node` Operation through the PUBLISH-0011 application path, and validates the exact Core plan, Operation receipt, created identity/content, and post-application authoritative references; exported through `src/publisher/index.ts` and the package root
- Evidence tests: `publisher.node-create-parent` (`tests/publisher/publish-0014-node-create-parent.test.ts`, 34 tests), plus 1,386 affected Publisher/Core/server/security/schema regression tests and the full 7,820-test Vitest suite
- Initial/final dedicated result: initial 28 tests = 23 passed / 5 failed (five false-positive rejected-promise expectations); final 34 tests = 34 passed / 0 failed
- Registry and generated assets: canonical and fixture PUBLISH-0014 map to implementation `[publisher, server]` and test ID `publisher.node-create-parent`; the bundled clean-revision evidence and generated traceability mark the requirement Verified.
- Acceptance count: 1 (fresh independent acceptance and repair)
- Commit subject recommendation: `feat(colp): enforce atomic ordinary node parent resolution`
- Protocol-Correction: no
- Host-owned residual risk: the host must resolve the server-selected `nodeId` before this boundary, place the outer PUBLISH-0010 idempotency claim/replay boundary around it, and back the supplied unit of work, authoritative Collection/Node reads, permanent global ID ledger, canonical Operation application, resource mutation, receipt, audit, and Outbox with one real durable database transaction. The host application service must create the preselected ID reported by the Operation result; the canonical `nodeCreateRequest` and `create_node` Operation intentionally do not carry a caller-controlled target ID. Durable constraints and transaction isolation must enforce lifetime uniqueness and serialize concurrent creates. Unknown commit outcomes require reconciliation by retrying the same host idempotency binding; this coordinator fails closed but cannot prove rollback, durability, cross-process isolation, or replay behavior supplied by the host.

## PUBLISH-0013

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/node-write.ts` composes Authentication, request-target Authorization, Concealment Policy, authoritative transaction-bound Core graph planning, affected-participant Authorization/Concealment, operation policy, read-only evaluation, and persistence; `src/server/node-write-guard.ts` snapshots authoritative resolver results and rejects Proxy/accessor/thenable resolver boundaries; exported through `src/publisher/index.ts` and the package root
- Evidence tests: `publisher.node-read-only-concealment` (`tests/publisher/publish-0013-node-read-only-concealment.test.ts`, 17 tests), plus affected Publisher/Core/server/security regression suites
- Acceptance count: 1 (fresh independent acceptance after replacing 13 false-positive tests that exercised only the Core guard)
- Commit subject recommendation: `feat(colp): enforce publisher read-only concealment ordering`
- Protocol-Correction: no
- Host-owned residual risk: the host must implement `PublisherNodeWriteUnitOfWork` as one real durable transaction/locked snapshot shared by authentication, authorization, concealment, authoritative Collection/Node/subtree reads, policy, and persistence. Authorization and concealment ports must derive decisions from that context and must not mutate external state. The coordinator fails closed on malformed or unknown adapter outcomes and prevents detached/double callback execution, but it cannot prove database isolation, rollback, commit durability, cross-process serialization, or reconcile an unknown commit after a defective host transaction returns a different outcome.

## PUBLISH-0012

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/index.ts` `executePublisherCollectionCreate`, its transaction-bound `PublisherCollectionCreateResources` port, permanent Collection/Root server-ID reservations, immutable request/binding snapshots, and schema-plus-identity validation for create and replay results; exported through `src/publisher/index.ts` and the package root
- Evidence tests: `publisher.collection-root-atomic` (`tests/publisher/publish-0012-collection-root-atomic-contract.test.ts`, 12 tests), with PUBLISH-0003/idempotency regression coverage in `tests/publisher/unit-of-work.test.ts` and `tests/publisher/publish-0010-idempotency-binding-contract.test.ts` (102 affected tests total)
- Acceptance count: 1
- Commit subject recommendation: `feat(colp): enforce atomic publisher collection and root creation`
- Protocol-Correction: no
- Host-owned residual risk: the host must back `PublisherUnitOfWork`, idempotency, both permanent server-ID reservations, and `createCollectionAndRoot` with one real durable database transaction. Durable constraints must enforce the global lifetime ID namespace, exactly one Root per Collection, and mutually consistent Collection `rootNodeId` / Root `collectionId`; no Collection or Root may be visible before commit. Unknown commit outcomes must reject and be reconciled by retrying the same binding. The coordinator validates and snapshots the command, binding, adapter result, and replay result, but intentionally does not fabricate a framework controller, database, transaction coordinator, or cross-process uniqueness mechanism.

## PUBLISH-0011

- Level: SHOULD
- Status: accepted
- Implementation: `src/publisher/operation-application.ts`, exported through `src/publisher/index.ts` and the package root; Node and Sidecar intents map to canonical Operations and the only exposed mutation capability is an atomic `applyOperations` application-service port
- Evidence tests: `publisher.operation-application` (`tests/publisher/publish-0011-operation-application-contract.test.ts`, 33 tests)
- Acceptance count: 1 (completed in the main thread at the user's direction)
- Protocol-Correction: no
- Host-owned residual risk: the host application service must implement `applyOperations` with the same authoritative authorization, conflict, Operation receipt, audit, Outbox, resource mutation, and idempotency/sequence stores inside one real transaction. HTTP, Sync, and MCP adapters must bind this single service rather than exposing direct resource mutation handles. The boundary enforces atomic canonical Node/Sidecar batches and validates immutable, ordered results, but does not fabricate a database, controller, or transaction coordinator.

## PUBLISH-0010

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/index.ts` complete Publisher idempotency binding/boundary and Manifest retention verification, including bounded I-JSON canonicalization, exact hostile claim/response validation, immutable stored response snapshots, native-Promise ports, and exact-once UnitOfWork callback/result binding; exported from the package root
- Evidence tests: `publisher.idempotency-binding` (`tests/publisher/publish-0010-idempotency-binding-contract.test.ts`, 75 tests)
- Acceptance count: 2 (security and transaction-integrity re-acceptance)
- Acceptance repairs: rejected unsafe integers, prototype-polluting keys and excessive canonical request nesting; prevented skipped/repeated/detached/replaced UnitOfWork callbacks from reporting a false durable result; rejected malformed claim shapes, non-native Promise ports, response field/header injection and non-I-JSON bodies; persisted and returned one detached deeply frozen response snapshot
- Protocol-Correction: no
- Host-owned residual risk: authorization and concealment must run before the idempotency boundary; adapters must derive the authenticated Principal and authoritative resource identity, and a durable cross-process store must enforce the documented uniqueness tuple, serialize claim/write/response completion in one transaction, retain immutable responses for at least the live Manifest declaration, and reconcile unknown commit outcomes by retrying the same binding. The retention verification is a startup composition check, so the host must fail readiness if live store guarantees later fall below the advertised minimum.

## PUBLISH-0005

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/deletion-receipt.ts` canonical `DeleteResult`, exact Method/Endpoint/target idempotency binding, internal deletion Watermark verification, hostile transaction-resource port validation, atomic idempotent delete coordinator, and replay validation; exported from `src/publisher/index.ts` and the package root; `deletionReceipt` remains a cursor-free wire schema distinct from `syncTombstone`
- Evidence tests: `schema.deletion-receipt` (`tests/schema/publish-0005-deletion-receipt-contract.test.ts`, 8 Schema tests; `tests/publisher/publish-0005-deletion-receipt-coordinator.test.ts`, 25 production coordinator tests)
- Acceptance count: 2 (production-boundary re-acceptance after replacing Schema-only evidence)
- Acceptance repairs: bound DELETE Method, Endpoint Key and canonical `collectionId[/targetId]` resource identity before transaction entry; required a non-Proxy transaction resource data method returning a native Promise; added real commit/replay/exact-once, rollback, immutable snapshot, hostile adapter, identity/scope and forged-cursor coverage
- Protocol-Correction: no
- Host-owned residual risk: adapters must persist the authoritative deletion and internal watermark atomically in the supplied PublisherUnitOfWork, and must return the same immutable response for idempotent replays. The coordinator fails closed on malformed receipt/watermark, identity/count/time mismatch, unknown idempotency outcomes, or forged Sync cursor fields; it never serializes the internal watermark.

## PUBLISH-0004

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/operation-mapping.ts`, exported from `src/publisher/index.ts` and the package root
- Evidence tests: `publisher.operation-mapping` (`tests/publisher/publish-0004-operation-mapping-contract.test.ts`, 13 tests)
- Acceptance count: 1
- Commit subject: `feat(colp): map publisher sidecar writes to canonical operations`
- Protocol-Correction: no
- Host-owned residual risk: the pure mapper validates complete canonical Operation structure and typed-update key equality, but IDs do not encode collection ownership. The host must resolve target sidecars and Annotation subjects / Attachment subjects / Relation endpoints against the authoritative `collectionId` inside the same PublisherUnitOfWork transaction before appending the Operation.

## PUBLISH-0003

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/index.ts` `executePublisherCollectionCreate`
- Evidence tests: `publisher.unit-of-work` PUBLISH-0003 block (7 tests) using real coordinator and in-memory Collection/Root resource adapter
- Acceptance count: 2 (re-acceptance after rejected false-positive evidence)
- Commit subject: `feat(colp): satisfy PUBLISH-0003 atomic collection and root creation`
- Protocol-Correction: no
- Host-owned residual risk: production adapters must implement `createCollectionAndRoot` with database locking and atomic commit semantics; coordinator fails closed on unknown UnitOfWork outcomes.

## PUBLISH-0001

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/preconditions.ts`, exported from `src/publisher/index.ts`
- Evidence tests: `publisher.preconditions` (`tests/publisher/publish-0001-preconditions-contract.test.ts`, 5 tests)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy PUBLISH-0001 publisher write preconditions`
- Protocol-Correction: no
- Host-owned residual risk: the host adapter must evaluate the authoritative revision and apply the mutation inside the same PublisherUnitOfWork transaction to avoid TOCTOU.

## PUBLISH-0002

- Level: MUST
- Status: accepted
- Implementation: canonical request digest and idempotent Publisher write validation in `src/publisher/index.ts`
- Evidence tests: `publisher.idempotency` in `tests/publisher/unit-of-work.test.ts` (16 tests)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy PUBLISH-0002 idempotent publisher writes`
- Protocol-Correction: no
- Host-owned residual risk: persistence adapters own retention/expiry policy and cross-process transaction durability; the port fails closed on unknown claim or commit outcomes.

## PUBLISH-0007

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/preconditions.ts`, `src/publisher/node-delete.ts`, `src/server/problems.ts`
- Evidence tests: `publisher.precondition-required` (`tests/publisher/publish-0007-precondition-required.test.ts`, 11 tests)
- Acceptance count: 2 (final Registry audit re-acceptance with hostile-input hardening)
- Commit subject: `fix(colp): harden PUBLISH-0007 precondition required boundary`
- Protocol-Correction: no
- Host-owned residual risk: the framework-neutral host still owns HTTP header extraction and must preserve omitted, null, empty, malformed, and repeated `If-Match` distinctions when constructing the Publisher request.

## PUBLISH-0008

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/preconditions.ts`, `src/publisher/node-move.ts`, `src/publisher/node-delete.ts`, `src/publisher/node-write.ts`, `src/server/node-write-guard.ts`, `src/server/problems.ts`, `src/server/publication-problems.ts`
- Evidence tests: `publisher.precondition-failed` (`tests/publisher/publish-0008-precondition-conflict.test.ts`, 54 tests)
- Acceptance count: 2 (independent acceptance repair for RFC entity-tag parsing, Move/Delete conflict ordering, affected-child concealment, and hostile boundary shapes)
- Commit subject: `fix(colp): harden PUBLISH-0008 precondition conflict boundary`
- Protocol-Correction: no
- Host-owned residual risk: the framework-neutral host must preserve raw repeated `If-Match` fields, supply authoritative current revision/ETag, and keep resolution plus persistence in the same transaction or locked snapshot.

## PUBLISH-0009

- Level: MUST
- Status: accepted
- Implementation: `src/publisher/index.ts` `evaluatePublisherIdempotencyKeyRequirement`, exported from the package root
- Evidence tests: `publisher.idempotency-key-required` (`tests/publisher/publish-0009-idempotency-key-required.test.ts`)
- Acceptance count: 1
- Protocol-Correction: no
- Host-owned residual risk: HTTP adapters must classify retryability before invoking the boundary and preserve raw repeated-header values. The boundary rejects missing, blank, repeated, comma-combined, non-visible-ASCII, and oversized keys with stable registered `428 precondition_required`, emits a complete canonical binding without caller extras, and does not expose rejected key or binding values.
