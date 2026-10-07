/**
 * Thin Sync host composition helpers.
 *
 * Production hosts should call {@link createSyncHost} from `./host.js` (exported
 * on `@collection-protocol/node/sync`). That builder requires a branded Session
 * and returns a typed dispatcher that can own **either** Sequence **or** Push.
 *
 * Session-bound helpers below remain the primitives the host wraps. Bare
 * Push/Pull/Sequence data-plane coordinators live only in `./sync/unsafe`.
 * The public barrel also exposes trusted-host bootstrap, tombstone maintenance,
 * and Replica lifecycle primitives; these are not raw HTTP handlers. Their
 * adapters own admission/fencing, and lifecycle mutations require branded proof.
 * Import `./sync/unsafe` only from tests and adapter fixtures.
 */

import { samePrincipal } from '../shared/protocol-vocabulary.js';
import type { Operation, OperationResult } from '../types/index.js';
import {
  bindCompactSyncPushBatchId, compactSyncPushBatchMatchesSession,
  readCompactSyncPushBatchBinding, type CompactSyncPushBatchBinding,
} from './compact-push-batch-binding.js';
import { immutableRequest as immutablePushRequest } from './push-transaction-guards.js';
import {
  coordinatePushTransaction,
  type PurePushPreflight,
  type PushConflictRecord,
  type PushOperationIdOwner,
  type PushTransactionRequest,
  type PushTransactionResult,
} from './push-transaction.js';
import {
  coordinateSyncPull,
  withRecommendedSnapshotUrlHostPolicy,
  type SyncPullCoordinatorResult,
  type SyncPullCursorStore,
  type SyncPullEventStore,
  type SyncPullRequestContext,
  type SyncPullSnapshotUrlOptions,
} from './pull.js';
import {
  coordinateSequenceOperation,
  type SequenceCoordinatorResult,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceEvaluation,
  type SequenceEvaluationContext,
  type SequenceOperationRequest,
} from './sequence.js';
import {
  asReplicaAuthenticatedCommand,
  coordinateReplicaLifecycle,
  createReplicaAuthProofFromVerifiedSession,
  requiredReplicaLifecycleScope,
  type ReplicaAuthenticatedLifecycleCommandInput,
  type ReplicaLifecycleCoordinatorResult,
  type ReplicaLifecycleKey,
  type ReplicaLifecycleOwnershipVerifier,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
} from './replica-lifecycle.js';
import type { SyncTransaction, SyncUnitOfWork } from './index.js';
import {
  isVerifiedSyncSession,
  requireVerifiedSyncSession,
  SyncSessionGateDeniedError,
  type VerifiedSyncSession,
  type VerifySyncSessionContextInput,
  type SyncSessionStore,
} from './session.js';
import type { ScopeName } from '../types/index.js';
import { requirePromise } from './internal-guards.js';

export type {
  SyncSessionGateDenial,
  SyncSessionGateDenialState,
  VerifiedSyncSession,
} from './session.js';
export {
  SyncSessionGateDeniedError,
  assertVerifiedSyncSession,
  isVerifiedSyncSession,
  requireVerifiedSyncSession,
} from './session.js';

export type SessionBoundVerifyInput =
  | {
      readonly kind: 'verify';
      readonly store: SyncSessionStore;
      readonly input: VerifySyncSessionContextInput;
      /** Optional lifecycle-only ownership verifier for direct composition. */
      readonly ownershipVerifier?: ReplicaLifecycleOwnershipVerifier;
    }
  | {
      readonly kind: 'verified';
      readonly session: VerifiedSyncSession;
      /** Optional lifecycle-only ownership verifier for direct composition. */
      readonly ownershipVerifier?: ReplicaLifecycleOwnershipVerifier;
    };

async function resolveVerifiedSession(gate: SessionBoundVerifyInput): Promise<VerifiedSyncSession> {
  if (gate.kind === 'verified') {
    // Runtime brand required: TypeScript brands alone cannot protect HTTP entrypoints.
    if (!isVerifiedSyncSession(gate.session)) {
      throw new SyncSessionGateDeniedError({
        state: 'request_binding_mismatch',
        detail:
          'VerifiedSyncSession must be package-minted via assertVerifiedSyncSession / '
          + 'requireVerifiedSyncSession (runtime brand required). Prefer kind: "verify" on HTTP paths.',
      });
    }
    if (gate.session.status !== 'active') {
      throw new SyncSessionGateDeniedError({
        state: 'request_binding_mismatch',
        detail: 'VerifiedSyncSession must remain active.',
      });
    }
    return gate.session;
  }
  return requireVerifiedSyncSession(gate.store, gate.input);
}

function assertSessionScope(
  session: VerifiedSyncSession,
  required: ScopeName,
): void {
  if (!session.authorizationScopes.includes(required)) {
    throw new SyncSessionGateDeniedError({ state: 'scope_missing', requiredScope: required });
  }
}

async function assertReplicaOwnership(
  verifier: ReplicaLifecycleOwnershipVerifier | undefined,
  session: VerifiedSyncSession,
  key: ReplicaLifecycleKey,
  command: ReplicaAuthenticatedLifecycleCommandInput,
): Promise<void> {
  if (verifier === undefined) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail:
        'Replica lifecycle requires an ownershipVerifier that proves the requested '
        + 'Replica belongs to the verified Session principal before authentication proof minting.',
    });
  }
  if (typeof verifier !== 'function') {
    throw new TypeError('Replica lifecycle ownershipVerifier must be a function.');
  }
  const candidate = verifier(session, key, command);
  const verdict = candidate instanceof Promise
    ? await requirePromise(candidate, 'Replica lifecycle ownershipVerifier')
    : candidate;
  if (verdict === false) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Replica ownership does not belong to the verified Session principal.',
    });
  }
  if (verdict !== true && verdict !== undefined) {
    throw new TypeError('Replica lifecycle ownershipVerifier must return boolean or void.');
  }
}

/**
 * Persistence key for a Collection Sequence lane. Hosts that store one lane
 * per Collection use this value as `sequenceScope`; generic
 * COLP tests may still address the same Collection by its raw ID.
 *
 * Do not change this encoding: existing receipts and next-sequence counters
 * are keyed by it for the Replica lifetime.
 */
export function collectionSequenceScopeKey(collectionId: string): string {
  return `collection:${collectionId}`;
}

/** True when `sequenceScope` names `collectionId`, as raw ID or persistence key. */
export function sequenceScopeMatchesCollection(
  sequenceScope: string,
  collectionId: string,
): boolean {
  return sequenceScope === collectionId
    || sequenceScope === collectionSequenceScopeKey(collectionId);
}

function assertPullRequestMatchesSession(
  session: VerifiedSyncSession,
  request: SyncPullRequestContext,
): void {
  if (request.sessionId !== session.sessionId) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Pull sessionId does not match the verified Session.',
    });
  }
  if (!samePrincipal(session.principal, request.principal)) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Pull principal does not match the verified Session principal.',
    });
  }
  // Ordinary Pull reads one Collection's log, so it needs a Collection-bound
  // Session. Instance Sessions exist only for the create-Collection bootstrap
  // (coordinateSessionBootstrap) and never Pull, whatever scopes they carry.
  if (session.sessionScope !== 'collection' || session.collectionId === null) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Pull requires a Collection-bound Session; Instance Sessions cannot Pull.',
    });
  }
  if (request.collectionId !== session.collectionId) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Pull collectionId does not match the verified Session collection binding.',
    });
  }
  if (request.protocolVersion !== session.protocolVersion) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Pull protocolVersion does not match the verified Session protocolVersion.',
    });
  }
}

/**
 * Versioned Push batch binding. Wire label `b1` is {@link SYNC_PUSH_BATCH_BINDING_VERSION}.
 *
 * `b1.<sessionLength>.<sessionId>.<suffix>`
 *
 * `sessionLength` is the canonical decimal length of the full session id (no
 * sign, no leading zero). The suffix is an independent non-empty opaque
 * segment and may contain `.`. Parsing consumes exactly `sessionLength`
 * characters, so session `a` and session `a.b` do not accept each other's ids.
 * The whole value is one wire opaqueId (`^[A-Za-z0-9._~-]{1,128}$`).
 * If that framing cannot fit, mint `b2.<sessionDigest>.<suffixDigest>` instead.
 * Domain-separated SHA-256 digests cover the full ASCII opaque inputs, keeping
 * every legal 128-character Session/local ID usable within 90 wire characters.
 * b1 output is unchanged when it fits, including already-issued retry IDs.
 *
 * A legacy `sessionId` or `sessionId.<suffix>` string is not a unique binding:
 * opaqueId allows `.`. {@link legacySyncPushBatchInReceiptScope} is the only
 * compatibility entry, and it matches a retry only when the full session,
 * principal, endpoint, and digest agree. A host that derives its own
 * server batch id still scopes that receipt by Session; a client batchId does
 * not authorize one.
 */
const OPAQUE_ID_MAX_LENGTH = 128;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]+$/u;

export const SYNC_PUSH_BATCH_BINDING_VERSION = 1;
const SYNC_PUSH_BATCH_WIRE_VERSION = `b${SYNC_PUSH_BATCH_BINDING_VERSION}`;

interface ReversibleSyncPushBatchBinding {
  readonly version: typeof SYNC_PUSH_BATCH_BINDING_VERSION;
  readonly sessionId: string;
  readonly suffix: string;
}

export type SyncPushBatchBinding = ReversibleSyncPushBatchBinding | CompactSyncPushBatchBinding;

/** Scope compared by the legacy batch-id compatibility entry. Not a wire document. */
export interface SyncPushBatchReceiptScope {
  readonly sessionId: string;
  readonly principal: { readonly type: string; readonly id: string };
  readonly endpoint: string;
  readonly digest: string;
}

function isOpaqueId(value: string): boolean {
  return value.length <= OPAQUE_ID_MAX_LENGTH && OPAQUE_ID_PATTERN.test(value);
}

function requireOpaqueSegment(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (!isOpaqueId(value)) {
    throw new TypeError(`${label} must match the opaqueId wire schema.`);
  }
  return value;
}

/** Mint a versioned batch id bound to the full `sessionId`. The suffix must be non-empty. */
export function bindSyncPushBatchId(sessionId: string, opaqueLocalId: string): string {
  const session = requireOpaqueSegment(sessionId, 'sessionId');
  const suffix = requireOpaqueSegment(opaqueLocalId, 'opaqueLocalId');
  const batchId = `${SYNC_PUSH_BATCH_WIRE_VERSION}.${session.length}.${session}.${suffix}`;
  return isOpaqueId(batchId) ? batchId : bindCompactSyncPushBatchId(session, suffix);
}

/** Read a canonical binding. b1 is reversible; b2 exposes digests, never guessed raw IDs. */
export function readSyncPushBatchBinding(batchId: string): SyncPushBatchBinding | undefined {
  if (typeof batchId !== 'string' || !isOpaqueId(batchId)) return undefined;
  const compact = readCompactSyncPushBatchBinding(batchId);
  if (compact) return compact;
  const prefix = `${SYNC_PUSH_BATCH_WIRE_VERSION}.`;
  if (!batchId.startsWith(prefix)) return undefined;
  const rest = batchId.slice(prefix.length);
  const lengthDot = rest.indexOf('.');
  if (lengthDot <= 0) return undefined;
  const lengthText = rest.slice(0, lengthDot);
  if (!/^[1-9]\d*$/u.test(lengthText)) return undefined;
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length) || String(length) !== lengthText) return undefined;
  const sessionStart = lengthDot + 1;
  const sessionEnd = sessionStart + length;
  if (sessionEnd >= rest.length || rest.charAt(sessionEnd) !== '.') return undefined;
  const sessionId = rest.slice(sessionStart, sessionEnd);
  const suffix = rest.slice(sessionEnd + 1);
  if (suffix.length === 0 || !isOpaqueId(sessionId) || !isOpaqueId(suffix)) return undefined;
  let canonical: string;
  try {
    canonical = bindSyncPushBatchId(sessionId, suffix);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
  if (canonical !== batchId) return undefined;
  return Object.freeze({
    version: SYNC_PUSH_BATCH_BINDING_VERSION,
    sessionId,
    suffix,
  });
}

function requireScopeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function readReceiptScope(
  scope: SyncPushBatchReceiptScope,
  label: string,
): SyncPushBatchReceiptScope {
  const principal = scope?.principal;
  return Object.freeze({
    sessionId: requireScopeText(scope?.sessionId, `${label} sessionId`),
    principal: Object.freeze({
      type: requireScopeText(principal?.type, `${label} principal type`),
      id: requireScopeText(principal?.id, `${label} principal id`),
    }),
    endpoint: requireScopeText(scope?.endpoint, `${label} endpoint`),
    digest: requireScopeText(scope?.digest, `${label} digest`),
  });
}

function sameReceiptScope(
  left: SyncPushBatchReceiptScope,
  right: SyncPushBatchReceiptScope,
): boolean {
  return left.sessionId === right.sessionId
    && left.principal.type === right.principal.type
    && left.principal.id === right.principal.id
    && left.endpoint === right.endpoint
    && left.digest === right.digest;
}

function isLegacyBatchShape(batchId: string, sessionId: string): boolean {
  // A canonical versioned id belongs to the decoded session only.
  if (readSyncPushBatchBinding(batchId) !== undefined) return false;
  if (batchId === sessionId) return true;
  const dotPrefix = `${sessionId}.`;
  return batchId.startsWith(dotPrefix) && batchId.length > dotPrefix.length;
}

/**
 * Legacy `sessionId` / `sessionId.<suffix>` retry. The dot prefix is not unique.
 * Returns true only when `attempt` and `stored` share the full session,
 * principal, endpoint, and digest, and `batchId` is that legacy shape for the
 * full session id. A versioned id is not a legacy retry. This does not give
 * the client batchId receipt authority.
 */
export function legacySyncPushBatchInReceiptScope(
  batchId: string,
  attempt: SyncPushBatchReceiptScope,
  stored: SyncPushBatchReceiptScope,
): boolean {
  requireScopeText(batchId, 'Push batchId');
  const attemptScope = readReceiptScope(attempt, 'attempt');
  const storedScope = readReceiptScope(stored, 'stored');
  if (!sameReceiptScope(attemptScope, storedScope)) return false;
  return isLegacyBatchShape(batchId, attemptScope.sessionId);
}

/**
 * Session-bound Push accepts only a canonical versioned binding for the full
 * session id. Equality with `sessionId` and a `sessionId.` prefix are not
 * accepted: opaqueId may contain `.`, so those forms alias session `a` and
 * session `a.b`.
 *
 * Bare {@link coordinatePushTransaction} does not enforce this rule.
 */
export function assertSyncPushBatchBoundToSession(
  batchId: string,
  session: VerifiedSyncSession | { readonly sessionId: string },
): void {
  if (typeof batchId !== 'string' || batchId.length === 0) {
    throw new TypeError('Push batchId must be a non-empty string.');
  }
  const sessionId = session.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('session.sessionId must be a non-empty string.');
  }
  const binding = readSyncPushBatchBinding(batchId);
  if (binding !== undefined && isOpaqueId(sessionId)
    && (binding.version === 1 ? binding.sessionId === sessionId
      : compactSyncPushBatchMatchesSession(binding, sessionId))) return;
  throw new SyncSessionGateDeniedError({
    state: 'request_binding_mismatch',
    detail:
      'Push batchId must be bindSyncPushBatchId output for this full sessionId '
      + '(binding version 1 or its compact version 2 fallback). A sessionId prefix is not unique. '
      + 'A legacy retry matches only a receipt with the same session, principal, endpoint, and digest.',
  });
}

/**
 * Session-bound Push: verify Session (unless already branded), require
 * `sync:push`, assert `request.batchId` is bound to the verified Session, then
 * call `coordinatePushTransaction`.
 *
 * Does **not** run Sequence continuity. Hosts that need gap/blocked semantics
 * must use Sequence as the sole opId owner for that path instead of Push.
 *
 * Does **not** rewrite `batchId`. Mint ids with {@link bindSyncPushBatchId}.
 * Bare `coordinatePushTransaction` does not enforce this binding. A legacy
 * prefix is not unique; compare old retries with
 * {@link legacySyncPushBatchInReceiptScope}.
 */
export async function coordinateSessionBoundPush<
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
  Transaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>,
>(
  gate: SessionBoundVerifyInput,
  unitOfWork: SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, Transaction>
    & PushOperationIdOwner,
  candidateRequest: PushTransactionRequest,
  preflight: PurePushPreflight<Transaction, Conflict, Audit, Outbox>,
): Promise<{ readonly session: VerifiedSyncSession; readonly result: PushTransactionResult }> {
  const session = await resolveVerifiedSession(gate);
  assertSessionScope(session, 'sync:push');
  assertSyncPushBatchBoundToSession(candidateRequest.batchId, session);
  const request = immutablePushRequest(candidateRequest);
  if (session.sessionScope !== 'collection' || session.collectionId === null
      || request.operations.some(item => item.operation.collectionId !== session.collectionId
        || !sequenceScopeMatchesCollection(item.sequenceScope, session.collectionId!))) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Every Push Operation and Sequence lane must match the verified Collection Session.',
    });
  }
  const result = await coordinatePushTransaction(unitOfWork, request, preflight);
  return Object.freeze({ session, result });
}

/**
 * Session-bound Pull: verify Session (unless already branded), require
 * `sync:pull`, enforce principal/collection/session/protocol binding against the
 * verified Session, then call `coordinateSyncPull`.
 *
 * When `snapshotUrlOptions.assertSnapshotUrlSafe` is omitted, installs
 * {@link withRecommendedSnapshotUrlHostPolicy} so private/local Snapshot URL
 * literals fail closed on the production session-bound path. Bare
 * `coordinateSyncPull` remains transport-only when the hook is omitted.
 * Pass an explicit hook (allowlist or no-op) to override.
 */
export async function coordinateSessionBoundPull(
  gate: SessionBoundVerifyInput,
  request: SyncPullRequestContext,
  cursorStore: SyncPullCursorStore,
  eventStore: SyncPullEventStore,
  snapshotUrlOptions?: SyncPullSnapshotUrlOptions,
): Promise<{ readonly session: VerifiedSyncSession; readonly result: SyncPullCoordinatorResult }> {
  const session = await resolveVerifiedSession(gate);
  assertSessionScope(session, 'sync:pull');
  assertPullRequestMatchesSession(session, request);
  const result = await coordinateSyncPull(
    request,
    cursorStore,
    eventStore,
    withRecommendedSnapshotUrlHostPolicy(snapshotUrlOptions),
  );
  return Object.freeze({ session, result });
}

/**
 * Session-bound Sequence: verify Session (unless already branded), require
 * `sync:push` and its Collection lane binding (mutating Sequence evaluation), then call
 * `coordinateSequenceOperation`.
 *
 * The generic Session model has no Replica identity: the host must verify
 * request.replicaId against its durable Session/Replica binding inside its UoW.
 * Instance bootstrap uses coordinateSessionBootstrap, not this Collection lane.
 * Sequence remains the sole opId reservation owner for this path. Do not also
 * call Push for the same operation boundary.
 */
export async function coordinateSessionBoundSequence<
  Result,
  Transaction extends SequenceCoordinatorTransaction<Result> = SequenceCoordinatorTransaction<Result>,
>(
  gate: SessionBoundVerifyInput,
  unitOfWork: SequenceCoordinatorUnitOfWork<Result, Transaction>,
  request: SequenceOperationRequest,
  evaluate: (
    context: SequenceEvaluationContext<Result>,
    transaction: Transaction,
  ) => Promise<SequenceEvaluation<Result>>,
): Promise<{ readonly session: VerifiedSyncSession; readonly result: SequenceCoordinatorResult<Result> }> {
  const session = await resolveVerifiedSession(gate);
  assertSessionScope(session, 'sync:push');
  if (session.sessionScope !== 'collection' || session.collectionId === null
      || !sequenceScopeMatchesCollection(request.sequenceScope, session.collectionId)) {
    throw new SyncSessionGateDeniedError({ state: 'request_binding_mismatch',
      detail: 'Sequence lane must match the verified Collection Session.' });
  }
  const result = await coordinateSequenceOperation(unitOfWork, request, evaluate);
  return Object.freeze({ session, result });
}

/**
 * Session-bound Replica lifecycle transition. The caller cannot self-assert
 * `authenticated: true`: this helper verifies the Session runtime brand,
 * enforces the command's authorization Scope and Collection binding, asks the
 * host's durable `ownershipVerifier` to prove the Replica belongs to the
 * Session principal, then mints the proof and enters the low-level durable
 * coordinator. Missing or negative ownership evidence fails before any
 * transaction is opened.
 */
export async function coordinateSessionBoundReplicaLifecycle<
  Transaction extends ReplicaLifecycleTransaction = ReplicaLifecycleTransaction,
>(
  gate: SessionBoundVerifyInput,
  unitOfWork: ReplicaLifecycleUnitOfWork<Transaction>,
  candidateKey: ReplicaLifecycleKey,
  candidateCommand: ReplicaAuthenticatedLifecycleCommandInput,
  ownershipVerifier?: ReplicaLifecycleOwnershipVerifier,
): Promise<{ readonly session: VerifiedSyncSession; readonly result: ReplicaLifecycleCoordinatorResult }> {
  const key = Object.freeze({ ...candidateKey });
  const command = Object.freeze({ ...candidateCommand });
  const session = await resolveVerifiedSession(gate);
  assertSessionScope(session, requiredReplicaLifecycleScope(command));
  // An unbound instance Session grants create_collection bootstrap only.
  // It is not a wildcard capability over existing Collections or Replicas.
  if (session.sessionScope !== 'collection' || session.collectionId === null
      || session.collectionId !== key.collectionId) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Replica lifecycle requires a Collection-bound Session matching the requested Collection.',
    });
  }
  await assertReplicaOwnership(
    ownershipVerifier ?? gate.ownershipVerifier,
    session,
    key,
    command,
  );
  const authenticated = asReplicaAuthenticatedCommand(
    Object.freeze({ ...command }),
    createReplicaAuthProofFromVerifiedSession(session),
  );
  const result = await coordinateReplicaLifecycle(unitOfWork, key, authenticated);
  return Object.freeze({ session, result });
}

/**
 * Documents the exclusive ownership choice for a host Sync write path.
 * This is a type-level / documentation aid only — it does not run coordinators.
 */
export type SyncWriteCoordinatorOwner = 'sequence' | 'push';

/**
 * Short migration guide. Exclusive ownership and Session gating
 * are enforced by `createSyncHost`, not by this checklist.
 */
export const SYNC_HOST_COMPOSITION_NOTES = Object.freeze({
  productionPath:
    'Production hosts call createSyncHost from @collection-protocol/node/sync with a branded VerifiedSyncSession and exactly one owner (sequence or push).',
  exclusiveOpIdOwner:
    'createSyncHost chooses exactly one write owner. The returned host cannot dispatch the other coordinator. There is no dual-owner sequenced-push facade.',
  sessionFirst:
    'createSyncHost requires a package-minted VerifiedSyncSession (verifySyncSessionContext / requireVerifiedSyncSession). HTTP paths verify first, then construct the host.',
  migration:
    'Composition-free coordinators are not on ./sync. Import @collection-protocol/node/sync/unsafe only from COLP tests and adapter fixtures. Production hosts must not import that subpath.',
} as const);
