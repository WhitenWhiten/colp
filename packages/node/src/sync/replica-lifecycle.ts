import { requirePromise } from './internal-guards.js';
import {
  applyAcknowledgeReplicaCommand,
  applyCompleteRecoveryReplicaCommand,
  applyRenewReplicaCommand,
  applyResumeReplicaCommand,
  buildExpiredReplicaCheckpoint,
  buildRecoveryRequiredReplicaCheckpoint,
  buildRegisteredReplicaCheckpoint,
  buildRetiredReplicaCheckpoint,
  denyUnlessAuthorizedRequest,
  replicaLifecycleCommitted,
  replicaLifecycleDenied,
  type ReplicaCheckpoint,
} from './replica-lifecycle-transitions.js';
import {
  exactLifecycleObject as exactObject,
  lifecycleInstant as instant,
  lifecycleNonEmpty as nonEmpty,
  lifecycleOrdinal as ordinal,
  parseReplicaLifecycleCommand,
} from './replica-lifecycle-parsing.js';
import { isVerifiedSyncSession, type VerifiedSyncSession } from './session.js';
export type ReplicaLifecycle = 'active' | 'expired' | 'recovery_required' | 'retired';
export { type ReplicaCheckpoint } from './replica-lifecycle-transitions.js';

export interface DurableReplicaCheckpoint extends Omit<ReplicaCheckpoint, 'collectionId'> {
  readonly collectionId: string;
  /** Canonical internal ordering key. Wire Cursors are deliberately never ordered. */
  readonly acknowledgedCommitOrdinal: string | null;
}

export interface ReplicaRetentionBoundary {
  readonly cursor: string | null;
  readonly commitOrdinal: string;
}

export interface ReplicaRetentionWindow {
  readonly collectionId: string;
  readonly earliestPull: ReplicaRetentionBoundary;
  readonly purgedThrough: ReplicaRetentionBoundary;
  readonly snapshotUrl: string;
}

export interface AuthoritativeSnapshotBinding {
  readonly snapshotId: string;
  readonly collectionId: string;
  readonly revision: string;
  readonly cursor: string;
  readonly commitOrdinal: string;
}

export interface ReplicaSnapshotAck extends AuthoritativeSnapshotBinding {
  readonly replicaId: string;
  readonly appliedAt: string;
}

export interface ReplicaLifecycleKey {
  readonly replicaId: string;
  readonly collectionId: string;
}

export interface ReplicaLifecycleTransaction {
  loadReplica(replicaId: string): Promise<DurableReplicaCheckpoint | undefined>;
  saveReplica(checkpoint: DurableReplicaCheckpoint): Promise<void>;
  readAuthoritativeTime(): Promise<string>;
  /**
   * Read the current window and prevent retention/purge advancement until this
   * transaction completes (for example, lock the same collection row as purge).
   * Snapshot loading, Ack writes and Replica activation share this boundary.
   */
  loadRetentionWindow(collectionId: string): Promise<ReplicaRetentionWindow>;
  loadAuthoritativeSnapshot(snapshotId: string): Promise<AuthoritativeSnapshotBinding | undefined>;
  saveSnapshotAck(ack: ReplicaSnapshotAck): Promise<void>;
  loadSnapshotAck(replicaId: string): Promise<ReplicaSnapshotAck | undefined>;
}

export interface ReplicaLifecycleUnitOfWork<
  Transaction extends ReplicaLifecycleTransaction = ReplicaLifecycleTransaction,
> {
  /**
   * The adapter MUST serialize callbacks for one stable Replica ID across all processes,
   * commit every transaction port atomically, resolve only after commit is known, and
   * reject on rollback or an uncertain commit outcome.
   */
  execute<Value>(
    replicaId: string,
    work: (transaction: Transaction) => Promise<Value>,
  ): Promise<Value>;
}

interface FreshLease {
  readonly leaseId: string;
  readonly generation: string;
  readonly leaseExpiresAt: string;
}

interface SuccessfulAuthorizedRequest {
  /**
   * Authentication outcome. `true` is accepted only on a command built by
   * {@link asReplicaAuthenticatedCommand} from a {@link ReplicaAuthProof}; a
   * hand-written `authenticated: true` is rejected. `false` needs no proof and
   * is denied `unauthorized`.
   */
  readonly authenticated: boolean;
  readonly succeeded: boolean;
}

declare const replicaAuthProofBrand: unique symbol;

/**
 * Process-local identities of minted proofs and of the commands built from
 * them. Membership is object identity, so a spread copy carries neither.
 */
const replicaAuthProofs = new WeakSet<object>();
const authenticatedReplicaCommands = new WeakSet<object>();

export type ReplicaAuthProofSource = 'verified-session' | 'host-verified' | 'unverified-test';

/**
 * Branded proof that a Replica lifecycle caller was authenticated.
 *
 * Only package factories can mint this value, and the lifecycle coordinator
 * accepts `authenticated: true` only on a command built from one.
 */
export type ReplicaAuthProof = {
  readonly authenticated: true;
  readonly source: ReplicaAuthProofSource;
  readonly [replicaAuthProofBrand]: true;
};

function mintReplicaAuthProof(source: ReplicaAuthProofSource): ReplicaAuthProof {
  const proof = Object.freeze({ authenticated: true as const, source }) as ReplicaAuthProof;
  replicaAuthProofs.add(proof);
  return proof;
}

/**
 * Recommended production factory: mint auth proof only after a branded
 * {@link VerifiedSyncSession} from `verifySyncSessionContext` / composition helpers.
 */
export function createReplicaAuthProofFromVerifiedSession(
  verified: VerifiedSyncSession,
): ReplicaAuthProof {
  if (!isVerifiedSyncSession(verified)) {
    throw new TypeError(
      'Replica auth proof requires a package-minted VerifiedSyncSession '
        + '(assertVerifiedSyncSession / requireVerifiedSyncSession).',
    );
  }
  if (verified.status !== 'active') {
    throw new TypeError('Replica auth proof requires an active verified Sync Session.');
  }
  return mintReplicaAuthProof('verified-session');
}

/**
 * Explicit host-trust factory when Session verification is handled outside this
 * package (for example a deployment-specific authn adapter). Callers remain
 * responsible for failing closed before this returns.
 */
export function assertReplicaCallerAuthenticated(options: {
  readonly authenticated: true;
  readonly source: 'host-verified';
}): ReplicaAuthProof {
  if (options.authenticated !== true || options.source !== 'host-verified') {
    throw new TypeError('Replica caller authentication assertion requires authenticated: true and source host-verified.');
  }
  return mintReplicaAuthProof('host-verified');
}

/**
 * **Dangerous test-only** factory. Do not use in production hosts.
 *
 * Not re-exported from the package root or `sync` barrel — import from
 * `src/testing` (`createUnverifiedReplicaAuthProofForTests` /
 * `createTestReplicaAuthProof`) only.
 */
export function createUnverifiedReplicaAuthProofForTests(): ReplicaAuthProof {
  return mintReplicaAuthProof('unverified-test');
}

export function isReplicaAuthProof(value: unknown): value is ReplicaAuthProof {
  return typeof value === 'object' && value !== null && replicaAuthProofs.has(value);
}

export type ReplicaLifecycleCommand =
  | ({ readonly type: 'register'; readonly collectionId: string } & FreshLease & SuccessfulAuthorizedRequest)
  | ({ readonly type: 'require_recovery' } & SuccessfulAuthorizedRequest)
  | ({ readonly type: 'resume' } & FreshLease & SuccessfulAuthorizedRequest)
  | ({ readonly type: 'complete_recovery'; readonly snapshotId: string } & FreshLease & SuccessfulAuthorizedRequest)
  | {
      readonly type: 'renew';
      readonly leaseExpiresAt: string;
    } & SuccessfulAuthorizedRequest
  /**
   * Records how far an active Replica has durably applied the Pull log. The
   * host resolves `cursor` to its `commitOrdinal` through its Cursor store
   * (bound to this Replica's Session and Collection) before issuing the
   * command. The acknowledgement only moves forward: an older position is
   * accepted without a write. Resume and Tombstone purge both read it.
   */
  | ({
      readonly type: 'acknowledge';
      readonly cursor: string;
      readonly commitOrdinal: string;
    } & SuccessfulAuthorizedRequest)
  | ({ readonly type: 'retire' } & SuccessfulAuthorizedRequest);

/**
 * System-initiated commands accepted only by {@link coordinateReplicaDueExpiry}.
 * `expire` confirms an already-elapsed lease after the coordinator's automatic
 * due check; it carries no host authentication because no host request exists.
 * The host command surface rejects it outright.
 */
export type ReplicaLifecycleSystemCommand =
  | ReplicaLifecycleCommand
  | { readonly type: 'expire' };

type ReplicaAuthorizedCommand = Extract<ReplicaLifecycleCommand, { readonly authenticated: boolean }>;

type OmitReplicaAuthentication<Command> = Command extends unknown
  ? Omit<Command, 'authenticated'>
  : never;

/**
 * Caller input for an authenticated lifecycle transition. Production hosts
 * should pass this shape to `coordinateSessionBoundReplicaLifecycle` instead
 * of supplying an authentication boolean themselves.
 */
export type ReplicaAuthenticatedLifecycleCommandInput =
  OmitReplicaAuthentication<ReplicaAuthorizedCommand>;

/**
 * Host supplied proof that the requested Replica belongs to the verified
 * Session's principal (and any deployment-specific credential/tenant binding).
 *
 * This callback is deliberately evaluated before a `ReplicaAuthProof` is
 * minted and before the lifecycle UnitOfWork is entered.  A deployment should
 * resolve the durable principal → Replica binding inside its authorization
 * boundary and return `true` (or `undefined` for a void callback).  `false`
 * denies the request; any other return value is an adapter contract error.
 */
export type ReplicaLifecycleOwnershipVerifier = (
  session: VerifiedSyncSession,
  key: ReplicaLifecycleKey,
  command: ReplicaAuthenticatedLifecycleCommandInput,
) => Promise<boolean | void> | boolean | void;

/** Scope required by each host-facing Replica lifecycle operation. */
export function requiredReplicaLifecycleScope(
  command: Pick<ReplicaAuthenticatedLifecycleCommandInput, 'type'>,
): 'sync:bootstrap' | 'sync:pull' | 'sync:push' {
  switch (command.type) {
    case 'register':
      return 'sync:bootstrap';
    case 'acknowledge':
      return 'sync:pull';
    default:
      return 'sync:push';
  }
}

/**
 * Builds an authorized Replica lifecycle command with `authenticated: true`
 * only when a {@link ReplicaAuthProof} is supplied. Preferred over writing
 * `authenticated: true` literals at the call site.
 */
export function asReplicaAuthenticatedCommand<
  Command extends ReplicaAuthenticatedLifecycleCommandInput,
>(
  commandWithoutAuth: Command,
  proof: ReplicaAuthProof,
): Command & { readonly authenticated: true } {
  if (!isReplicaAuthProof(proof)) {
    throw new TypeError('asReplicaAuthenticatedCommand requires a package-minted ReplicaAuthProof.');
  }
  if (Object.prototype.hasOwnProperty.call(commandWithoutAuth, 'authenticated')) {
    throw new TypeError('Replica authenticated command input must not supply authenticated itself.');
  }
  const command = Object.freeze({
    ...commandWithoutAuth,
    authenticated: true as const,
  } as Command & { readonly authenticated: true });
  authenticatedReplicaCommands.add(command);
  return command;
}

/**
 * `invalid_lease_expiry`: a well-formed requested lease expiry is no longer
 * valid under the transaction's authoritative time (not later than it, or a
 * renewal that does not extend the current lease). No requested lease or
 * recovery changes are written. Automatic expiry of an elapsed active lease
 * is persisted first, even when resume is denied. The host may recompute the
 * expiry from fresh time and retry. Malformed input
 * (unparseable instants, reused lease identity) still throws `TypeError`.
 */
export type ReplicaLifecycleProblemCode =
  | 'replica_not_found'
  | 'replica_exists'
  | 'replica_retired'
  | 'stale_replica'
  | 'invalid_replica_state'
  | 'unauthorized'
  | 'request_failed'
  | 'invalid_lease_expiry';

export type ReplicaLifecycleCoordinatorResult =
  | { readonly state: 'committed'; readonly checkpoint: DurableReplicaCheckpoint }
  | {
      readonly state: 'denied';
      readonly code: ReplicaLifecycleProblemCode;
      readonly checkpoint?: DurableReplicaCheckpoint;
      readonly snapshotUrl?: string;
    };

export type ReplicaSyncBehavior =
  | 'establish_session'
  | 'pull'
  | 'push'
  | 'ack'
  | 'renew'
  | 'resume'
  | 'bootstrap'
  | 'register';

export type ReplicaSyncBehaviorDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'replica_retired' | 'stale_replica' };

const lifecycleValues = new Set<unknown>(['active', 'expired', 'recovery_required', 'retired']);

function immutableKey(value: ReplicaLifecycleKey): ReplicaLifecycleKey {
  const candidate = exactObject(value, new Set(['replicaId', 'collectionId']), 'Replica lifecycle key');
  return Object.freeze({
    replicaId: nonEmpty(candidate.replicaId, 'Replica ID'),
    collectionId: nonEmpty(candidate.collectionId, 'Collection ID'),
  });
}

function immutableCheckpoint(value: unknown, key: ReplicaLifecycleKey): DurableReplicaCheckpoint {
  const candidate = exactObject(value, new Set([
    'replicaId', 'collectionId', 'leaseId', 'generation', 'lastSeenAt', 'leaseExpiresAt',
    'acknowledgedCursor', 'acknowledgedCommitOrdinal', 'lifecycle',
  ]), 'Replica checkpoint');
  if (candidate.replicaId !== key.replicaId) throw new TypeError('Replica store returned a mismatched Replica ID.');
  // Collection identity is part of the durable key.  Validate it before any
  // lifecycle branch can return a denial carrying the loaded checkpoint (for
  // example `replica_exists` or `replica_retired`).
  if (candidate.collectionId !== key.collectionId) {
    throw new TypeError('Replica store returned a mismatched Collection ID.');
  }
  if (!lifecycleValues.has(candidate.lifecycle)) throw new TypeError('Replica checkpoint lifecycle is invalid.');
  const acknowledgedCursor = candidate.acknowledgedCursor === null
    ? null
    : nonEmpty(candidate.acknowledgedCursor, 'Replica acknowledged Cursor');
  const acknowledgedCommitOrdinal = candidate.acknowledgedCommitOrdinal === null
    ? null
    : ordinal(candidate.acknowledgedCommitOrdinal, 'Replica acknowledged commit ordinal').wire;
  if ((acknowledgedCursor === null) !== (acknowledgedCommitOrdinal === null)) {
    throw new TypeError('Replica acknowledged Cursor and commit ordinal must be present together.');
  }
  const lastSeenAt = instant(candidate.lastSeenAt, 'Replica lastSeenAt').wire;
  const leaseExpiresAt = instant(candidate.leaseExpiresAt, 'Replica leaseExpiresAt').wire;
  if (instant(leaseExpiresAt, 'Replica leaseExpiresAt').order <= instant(lastSeenAt, 'Replica lastSeenAt').order) {
    throw new TypeError('Replica leaseExpiresAt must be later than lastSeenAt.');
  }
  return Object.freeze({
    replicaId: key.replicaId,
    collectionId: nonEmpty(candidate.collectionId, 'Collection ID'),
    leaseId: nonEmpty(candidate.leaseId, 'Replica lease ID'),
    generation: nonEmpty(candidate.generation, 'Replica lease generation'),
    lastSeenAt,
    leaseExpiresAt,
    acknowledgedCursor,
    acknowledgedCommitOrdinal,
    lifecycle: candidate.lifecycle as ReplicaLifecycle,
  });
}

function sameCheckpoint(left: DurableReplicaCheckpoint, right: DurableReplicaCheckpoint): boolean {
  return left.replicaId === right.replicaId && left.collectionId === right.collectionId
    && left.leaseId === right.leaseId && left.generation === right.generation
    && left.lastSeenAt === right.lastSeenAt && left.leaseExpiresAt === right.leaseExpiresAt
    && left.acknowledgedCursor === right.acknowledgedCursor
    && left.acknowledgedCommitOrdinal === right.acknowledgedCommitOrdinal
    && left.lifecycle === right.lifecycle;
}

function sameResult(left: ReplicaLifecycleCoordinatorResult, right: ReplicaLifecycleCoordinatorResult): boolean {
  if (left.state !== right.state) return false;
  if (left.state === 'committed' && right.state === 'committed') return sameCheckpoint(left.checkpoint, right.checkpoint);
  if (left.state === 'denied' && right.state === 'denied') {
    return left.code === right.code && left.snapshotUrl === right.snapshotUrl
      && (left.checkpoint === undefined ? right.checkpoint === undefined : right.checkpoint !== undefined && sameCheckpoint(left.checkpoint, right.checkpoint));
  }
  return false;
}

async function saveAndVerify(transaction: ReplicaLifecycleTransaction, key: ReplicaLifecycleKey, checkpoint: DurableReplicaCheckpoint): Promise<DurableReplicaCheckpoint> {
  await requirePromise(transaction.saveReplica(structuredClone(checkpoint)), 'Replica checkpoint save');
  const reloaded = await requirePromise(transaction.loadReplica(key.replicaId), 'Replica checkpoint transaction-local read-back');
  if (reloaded === undefined) throw new TypeError('Replica checkpoint was not persisted by the adapter.');
  let verified: DurableReplicaCheckpoint;
  try {
    verified = immutableCheckpoint(reloaded, key);
  } catch (error) {
    // A transaction-local read-back with a forged Collection identity is a
    // write/read-back mismatch. Keep the generic durable-write error so the
    // adapter cannot use this path to disclose a checkpoint from another key.
    if (error instanceof TypeError && /mismatched Collection ID/u.test(error.message)) {
      throw new TypeError('Replica checkpoint read-back differs from the requested write.');
    }
    throw error;
  }
  if (!sameCheckpoint(checkpoint, verified)) throw new TypeError('Replica checkpoint read-back differs from the requested write.');
  return verified;
}

/** Pure behavior guard using time supplied by an authoritative server clock. */
export function evaluateReplicaSyncBehavior(
  checkpoint: Pick<DurableReplicaCheckpoint, 'lifecycle' | 'leaseExpiresAt'>,
  behavior: ReplicaSyncBehavior,
  authoritativeTime: string,
): ReplicaSyncBehaviorDecision {
  const candidate = exactObject(checkpoint, new Set(['lifecycle', 'leaseExpiresAt']), 'Replica behavior checkpoint');
  if (!lifecycleValues.has(candidate.lifecycle)) throw new TypeError('Replica behavior checkpoint lifecycle is invalid.');
  if (!new Set<ReplicaSyncBehavior>(['establish_session', 'pull', 'push', 'ack', 'renew', 'resume', 'bootstrap', 'register']).has(behavior)) {
    throw new TypeError('Replica Sync behavior is invalid.');
  }
  const now = instant(authoritativeTime, 'Authoritative behavior-check time').order;
  const leaseExpiresAt = instant(candidate.leaseExpiresAt, 'Replica lease expiry').order;
  if (candidate.lifecycle === 'retired') return Object.freeze({ allowed: false, code: 'replica_retired' });
  if (candidate.lifecycle === 'active') {
    if (now >= leaseExpiresAt) {
      return Object.freeze({ allowed: false, code: 'stale_replica' });
    }
    return new Set<ReplicaSyncBehavior>(['establish_session', 'pull', 'push', 'ack', 'renew']).has(behavior)
      ? Object.freeze({ allowed: true })
      : Object.freeze({ allowed: false, code: 'stale_replica' });
  }
  if (candidate.lifecycle === 'expired') return behavior === 'resume'
    ? Object.freeze({ allowed: true })
    : Object.freeze({ allowed: false, code: 'stale_replica' });
  return behavior === 'bootstrap'
    ? Object.freeze({ allowed: true })
    : Object.freeze({ allowed: false, code: 'stale_replica' });
}

/**
 * Coordinates one durable, authoritative, Replica-ID-serialized lifecycle transition.
 *
 * This is a low-level state-machine boundary that does not verify a Session
 * itself: `authenticated: true` must come from
 * {@link asReplicaAuthenticatedCommand}, and a hand-written flag throws.
 * Request handlers should use `coordinateSessionBoundReplicaLifecycle`.
 * Every host command requires `authenticated`/`succeeded` flags; the
 * system-initiated due-expiry path is not a host command — see
 * {@link coordinateReplicaDueExpiry}.
 */
export async function coordinateReplicaLifecycle<
  Transaction extends ReplicaLifecycleTransaction = ReplicaLifecycleTransaction,
>(unitOfWork: ReplicaLifecycleUnitOfWork<Transaction>, candidateKey: ReplicaLifecycleKey, candidateCommand: ReplicaLifecycleCommand): Promise<ReplicaLifecycleCoordinatorResult> {
  if (
    typeof candidateCommand === 'object' && candidateCommand !== null
    && Object.getOwnPropertyDescriptor(candidateCommand, 'authenticated')?.value === true
    && !authenticatedReplicaCommands.has(candidateCommand)
  ) {
    throw new TypeError(
      'Replica lifecycle authenticated: true must come from asReplicaAuthenticatedCommand with a ReplicaAuthProof.',
    );
  }
  return runReplicaLifecycleTransition(unitOfWork, candidateKey, candidateCommand, 'host');
}

/**
 * **System-initiated** due-expiry entry — not a host command surface.
 *
 * Runs the same serialized durable coordinator for the internal `expire`
 * transition: an already-elapsed active lease is confirmed `expired`; anything
 * else is denied `invalid_replica_state`. There is deliberately no command
 * payload — a host request cannot force a Replica into `expired`; only
 * authoritative time can. A host's background expiry scan calls this entry.
 */
export async function coordinateReplicaDueExpiry<
  Transaction extends ReplicaLifecycleTransaction = ReplicaLifecycleTransaction,
>(unitOfWork: ReplicaLifecycleUnitOfWork<Transaction>, candidateKey: ReplicaLifecycleKey): Promise<ReplicaLifecycleCoordinatorResult> {
  return runReplicaLifecycleTransition(unitOfWork, candidateKey, { type: 'expire' }, 'system');
}

async function runReplicaLifecycleTransition<
  Transaction extends ReplicaLifecycleTransaction = ReplicaLifecycleTransaction,
>(
  unitOfWork: ReplicaLifecycleUnitOfWork<Transaction>,
  candidateKey: ReplicaLifecycleKey,
  candidateCommand: ReplicaLifecycleSystemCommand,
  surface: 'host' | 'system',
): Promise<ReplicaLifecycleCoordinatorResult> {
  const key = immutableKey(candidateKey);
  const command = parseReplicaLifecycleCommand(candidateCommand, surface);
  if (command.type === 'register' && command.collectionId !== key.collectionId) {
    throw new TypeError('Replica registration targets a mismatched Collection ID.');
  }
  let invocations = 0;
  let callbackResult: ReplicaLifecycleCoordinatorResult | undefined;
  const outcome = await requirePromise(unitOfWork.execute(key.replicaId, async (transaction) => {
    invocations += 1;
    if (invocations !== 1) throw new TypeError('Replica lifecycle UnitOfWork must invoke its callback exactly once.');
    if (typeof transaction !== 'object' || transaction === null) throw new TypeError('Replica lifecycle UnitOfWork must provide a transaction object.');
    const now = instant(await requirePromise(transaction.readAuthoritativeTime(), 'Authoritative time read'), 'Authoritative time');
    const loaded = await requirePromise(transaction.loadReplica(key.replicaId), 'Replica checkpoint load');
    let checkpoint = loaded === undefined ? undefined : immutableCheckpoint(loaded, key);

    // Missing replica: only `register` may create one.
    if (checkpoint === undefined) {
      if (command.type !== 'register') return (callbackResult = replicaLifecycleDenied('replica_not_found'));
      const authDenial = denyUnlessAuthorizedRequest(command);
      if (authDenial !== undefined) return (callbackResult = authDenial);
      if (instant(command.leaseExpiresAt, 'Lease expiry').order <= now.order) {
        return (callbackResult = replicaLifecycleDenied('invalid_lease_expiry'));
      }
      const registered = await saveAndVerify(
        transaction,
        key,
        buildRegisteredReplicaCheckpoint(key, command, now),
      );
      return (callbackResult = replicaLifecycleCommitted(registered));
    }

    // Terminal / identity guards before command dispatch.
    if (checkpoint.lifecycle === 'retired') {
      return (callbackResult = replicaLifecycleDenied('replica_retired', checkpoint));
    }
    if (checkpoint.collectionId !== key.collectionId) {
      if (command.type === 'register') {
        return (callbackResult = replicaLifecycleDenied('replica_exists', checkpoint));
      }
      throw new TypeError('Replica store returned a checkpoint bound to a mismatched Collection ID.');
    }
    if (command.type === 'register') {
      return (callbackResult = replicaLifecycleDenied('replica_exists', checkpoint));
    }

    // Auto-expire an active lease that has elapsed under authoritative time.
    if (checkpoint.lifecycle === 'active' && now.order >= instant(checkpoint.leaseExpiresAt, 'Replica lease expiry').order) {
      checkpoint = await saveAndVerify(transaction, key, buildExpiredReplicaCheckpoint(checkpoint));
    }

    const commandCtx = { transaction, key, checkpoint, now, saveAndVerify };

    // Command dispatch trunk — large branches live in replica-lifecycle-transitions.
    switch (command.type) {
      case 'retire': {
        const authDenial = denyUnlessAuthorizedRequest(command, checkpoint);
        if (authDenial !== undefined) return (callbackResult = authDenial);
        const retired = await saveAndVerify(transaction, key, buildRetiredReplicaCheckpoint(checkpoint));
        return (callbackResult = replicaLifecycleCommitted(retired));
      }
      case 'expire': {
        if (checkpoint.lifecycle !== 'expired') {
          return (callbackResult = replicaLifecycleDenied('invalid_replica_state', checkpoint));
        }
        return (callbackResult = replicaLifecycleCommitted(checkpoint));
      }
      case 'require_recovery': {
        const authDenial = denyUnlessAuthorizedRequest(command, checkpoint);
        if (authDenial !== undefined) return (callbackResult = authDenial);
        if (checkpoint.lifecycle !== 'active' && checkpoint.lifecycle !== 'expired') {
          return (callbackResult = replicaLifecycleDenied('invalid_replica_state', checkpoint));
        }
        const recovery = await saveAndVerify(
          transaction,
          key,
          buildRecoveryRequiredReplicaCheckpoint(checkpoint),
        );
        return (callbackResult = replicaLifecycleCommitted(recovery));
      }
      case 'renew':
        return (callbackResult = await applyRenewReplicaCommand(commandCtx, command));
      case 'acknowledge':
        return (callbackResult = await applyAcknowledgeReplicaCommand(commandCtx, command));
      case 'resume':
        return (callbackResult = await applyResumeReplicaCommand(commandCtx, command));
      case 'complete_recovery':
        return (callbackResult = await applyCompleteRecoveryReplicaCommand(commandCtx, command));
      default:
        return (callbackResult = replicaLifecycleDenied('invalid_replica_state', checkpoint));
    }
  }), 'Replica lifecycle UnitOfWork execute');
  if (invocations !== 1 || callbackResult === undefined || outcome !== callbackResult || !sameResult(outcome, callbackResult)) {
    throw new TypeError('Replica lifecycle UnitOfWork returned a result other than its transaction callback result.');
  }
  return callbackResult.state === 'committed'
    ? replicaLifecycleCommitted(immutableCheckpoint(callbackResult.checkpoint, key))
    : replicaLifecycleDenied(
      callbackResult.code,
      callbackResult.checkpoint === undefined ? undefined : immutableCheckpoint(callbackResult.checkpoint, key),
      callbackResult.snapshotUrl,
    );
}
