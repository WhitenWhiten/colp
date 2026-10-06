/**
 * Pure durable Replica checkpoint transitions and the larger command-branch
 * executors used by {@link coordinateReplicaLifecycle}.
 *
 * Internal to `packages/node/src/sync` — not part of the public package surface.
 */

import { requirePromise } from './internal-guards.js';
import {
  exactLifecycleObject as exactObject,
  lifecycleInstant as instant,
  lifecycleNonEmpty as nonEmpty,
  lifecycleOrdinal as ordinal,
} from './replica-lifecycle-parsing.js';
import type {
  AuthoritativeSnapshotBinding,
  DurableReplicaCheckpoint,
  ReplicaLifecycle,
  ReplicaLifecycleCommand,
  ReplicaLifecycleCoordinatorResult,
  ReplicaLifecycleKey,
  ReplicaLifecycleProblemCode,
  ReplicaLifecycleTransaction,
  ReplicaRetentionBoundary,
  ReplicaRetentionWindow,
  ReplicaSnapshotAck,
} from './replica-lifecycle.js';

/**
 * Legacy pure-reducer checkpoint shape.
 *
 * @deprecated Prefer {@link DurableReplicaCheckpoint} with
 * {@link coordinateReplicaLifecycle}. This shape does not establish adapter
 * persistence or authority.
 */
export interface ReplicaCheckpoint {
  readonly replicaId: string;
  readonly collectionId: string | null;
  readonly leaseId: string;
  readonly generation: string;
  readonly lastSeenAt: string;
  readonly leaseExpiresAt: string;
  readonly acknowledgedCursor: string | null;
  readonly lifecycle: ReplicaLifecycle;
}

/**
 * @deprecated Prefer durable {@link coordinateReplicaLifecycle} commands.
 * Pure lifecycle events do not establish adapter persistence or authority.
 */
export type ReplicaLifecycleEvent =
  | { readonly type: 'lease_expired' }
  | {
      readonly type: 'resume_checked';
      readonly windowComplete: boolean;
      readonly leaseId: string;
      readonly generation: string;
      readonly lastSeenAt: string;
      readonly leaseExpiresAt: string;
    }
  | { readonly type: 'recovery_required' }
  | {
      readonly type: 'bootstrap_acked';
      readonly collectionId: string;
      readonly acknowledgedCursor: string;
      readonly leaseId: string;
      readonly generation: string;
      readonly lastSeenAt: string;
      readonly leaseExpiresAt: string;
    }
  | { readonly type: 'retire' };

function renewedCheckpoint(
  checkpoint: ReplicaCheckpoint,
  event: Extract<ReplicaLifecycleEvent, { readonly type: 'resume_checked' | 'bootstrap_acked' }>,
): ReplicaCheckpoint {
  return {
    ...checkpoint,
    leaseId: event.leaseId,
    generation: event.generation,
    lastSeenAt: event.lastSeenAt,
    leaseExpiresAt: event.leaseExpiresAt,
    lifecycle: 'active',
  };
}

/**
 * Compatibility-only pure reducer. It does not establish adapter persistence or authority.
 *
 * @deprecated Use {@link coordinateReplicaLifecycle} for durable, authoritative
 * Replica transitions.
 */
export function transitionReplicaLifecycle(
  checkpoint: ReplicaCheckpoint,
  event: ReplicaLifecycleEvent,
): ReplicaCheckpoint {
  if (checkpoint.lifecycle === 'retired') {
    throw new Error('A retired Replica is terminal and cannot transition.');
  }
  if (event.type === 'retire') return { ...checkpoint, lifecycle: 'retired' };
  if (event.type === 'lease_expired') {
    if (checkpoint.lifecycle !== 'active') throw new Error('Only an active Replica lease can expire.');
    return { ...checkpoint, lifecycle: 'expired' };
  }
  if (event.type === 'recovery_required') return { ...checkpoint, lifecycle: 'recovery_required' };
  if (event.type === 'resume_checked') {
    if (checkpoint.lifecycle !== 'expired') throw new Error('Only an expired Replica can be checked for resume.');
    return event.windowComplete
      ? renewedCheckpoint(checkpoint, event)
      : { ...checkpoint, lifecycle: 'recovery_required' };
  }
  if (checkpoint.lifecycle !== 'recovery_required') {
    throw new Error('Only a recovery-required Replica can complete bootstrap.');
  }
  return {
    ...renewedCheckpoint(checkpoint, event),
    collectionId: event.collectionId,
    acknowledgedCursor: event.acknowledgedCursor,
  };
}

function immutableBoundary(value: unknown, label: string): ReplicaRetentionBoundary {
  const candidate = exactObject(value, new Set(['cursor', 'commitOrdinal']), label);
  return Object.freeze({
    cursor: candidate.cursor === null ? null : nonEmpty(candidate.cursor, `${label} Cursor`),
    commitOrdinal: ordinal(candidate.commitOrdinal, `${label} commit ordinal`).wire,
  });
}

function immutableWindow(value: unknown, collectionId: string): ReplicaRetentionWindow {
  const candidate = exactObject(value, new Set(['collectionId', 'earliestPull', 'purgedThrough', 'snapshotUrl']), 'Replica retention window');
  if (candidate.collectionId !== collectionId) throw new TypeError('Retention window belongs to a different Collection.');
  const earliestPull = immutableBoundary(candidate.earliestPull, 'Earliest Pull boundary');
  const purgedThrough = immutableBoundary(candidate.purgedThrough, 'Purged-through boundary');
  return Object.freeze({ collectionId, earliestPull, purgedThrough, snapshotUrl: nonEmpty(candidate.snapshotUrl, 'Snapshot URL') });
}

function immutableSnapshot(value: unknown, expectedCollectionId: string, expectedSnapshotId: string): AuthoritativeSnapshotBinding {
  const candidate = exactObject(value, new Set(['snapshotId', 'collectionId', 'revision', 'cursor', 'commitOrdinal']), 'Authoritative Snapshot binding');
  if (candidate.snapshotId !== expectedSnapshotId || candidate.collectionId !== expectedCollectionId) {
    throw new TypeError('Authoritative Snapshot binding has a mismatched identity.');
  }
  return Object.freeze({
    snapshotId: expectedSnapshotId,
    collectionId: expectedCollectionId,
    revision: nonEmpty(candidate.revision, 'Snapshot revision'),
    cursor: nonEmpty(candidate.cursor, 'Snapshot Cursor'),
    commitOrdinal: ordinal(candidate.commitOrdinal, 'Snapshot commit ordinal').wire,
  });
}

function immutableAck(value: unknown, expected: ReplicaSnapshotAck): ReplicaSnapshotAck {
  const candidate = exactObject(value, new Set([
    'snapshotId', 'collectionId', 'revision', 'cursor', 'commitOrdinal', 'replicaId', 'appliedAt',
  ]), 'Replica Snapshot Ack');
  const ack = Object.freeze({
    ...immutableSnapshot({
      snapshotId: candidate.snapshotId,
      collectionId: candidate.collectionId,
      revision: candidate.revision,
      cursor: candidate.cursor,
      commitOrdinal: candidate.commitOrdinal,
    }, expected.collectionId, expected.snapshotId),
    replicaId: nonEmpty(candidate.replicaId, 'Snapshot Ack Replica ID'),
    appliedAt: instant(candidate.appliedAt, 'Snapshot Ack appliedAt').wire,
  });
  if (ack.replicaId !== expected.replicaId || ack.revision !== expected.revision
    || ack.cursor !== expected.cursor || ack.commitOrdinal !== expected.commitOrdinal
    || ack.appliedAt !== expected.appliedAt) {
    throw new TypeError('Snapshot Ack read-back differs from the committed Ack.');
  }
  return ack;
}

// ─── Coordinator result builders ─────────────────────────────────────────────

export function replicaLifecycleDenied(
  code: ReplicaLifecycleProblemCode,
  checkpoint?: DurableReplicaCheckpoint,
  snapshotUrl?: string,
): ReplicaLifecycleCoordinatorResult {
  return Object.freeze({
    state: 'denied' as const,
    code,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(snapshotUrl === undefined ? {} : { snapshotUrl }),
  });
}

export function replicaLifecycleCommitted(
  checkpoint: DurableReplicaCheckpoint,
): ReplicaLifecycleCoordinatorResult {
  return Object.freeze({ state: 'committed' as const, checkpoint });
}

// ─── Pure durable checkpoint transitions ─────────────────────────────────────

export interface FreshReplicaLease {
  readonly leaseId: string;
  readonly generation: string;
  readonly leaseExpiresAt: string;
}

export interface AuthoritativeInstant {
  readonly wire: string;
  readonly order: number;
}

/** Initial active checkpoint for a successful `register` command. */
export function buildRegisteredReplicaCheckpoint(
  key: ReplicaLifecycleKey,
  command: Extract<ReplicaLifecycleCommand, { readonly type: 'register' }>,
  now: AuthoritativeInstant,
): DurableReplicaCheckpoint {
  return Object.freeze({
    replicaId: key.replicaId,
    collectionId: command.collectionId,
    leaseId: command.leaseId,
    generation: command.generation,
    lastSeenAt: now.wire,
    leaseExpiresAt: command.leaseExpiresAt,
    acknowledgedCursor: null,
    acknowledgedCommitOrdinal: null,
    lifecycle: 'active',
  });
}

/** Pure: active → expired (lease elapsed or explicit expire path pre-state). */
export function buildExpiredReplicaCheckpoint(
  checkpoint: DurableReplicaCheckpoint,
): DurableReplicaCheckpoint {
  return Object.freeze({ ...checkpoint, lifecycle: 'expired' });
}

/** Pure: any non-terminal → retired. */
export function buildRetiredReplicaCheckpoint(
  checkpoint: DurableReplicaCheckpoint,
): DurableReplicaCheckpoint {
  return Object.freeze({ ...checkpoint, lifecycle: 'retired' });
}

/** Pure: active|expired → recovery_required. */
export function buildRecoveryRequiredReplicaCheckpoint(
  checkpoint: DurableReplicaCheckpoint,
): DurableReplicaCheckpoint {
  return Object.freeze({ ...checkpoint, lifecycle: 'recovery_required' });
}

/** Pure: extend an active lease (renew). */
export function buildRenewedReplicaCheckpoint(
  checkpoint: DurableReplicaCheckpoint,
  lastSeenAt: string,
  leaseExpiresAt: string,
): DurableReplicaCheckpoint {
  return Object.freeze({ ...checkpoint, lastSeenAt, leaseExpiresAt });
}

/**
 * Pure: bind Snapshot cursor/ordinal onto a recovery_required checkpoint
 * before applying a fresh lease.
 */
export function buildSnapshotAcknowledgedReplicaCheckpoint(
  checkpoint: DurableReplicaCheckpoint,
  snapshot: Pick<AuthoritativeSnapshotBinding, 'cursor' | 'commitOrdinal'>,
): DurableReplicaCheckpoint {
  return Object.freeze({
    ...checkpoint,
    acknowledgedCursor: snapshot.cursor,
    acknowledgedCommitOrdinal: snapshot.commitOrdinal,
  });
}

/**
 * Apply a fresh lease ID/generation and mark lifecycle active.
 * Throws when lease identity is reused or expiry is not after authoritative time.
 */
export function buildFreshActiveLeaseCheckpoint(
  checkpoint: DurableReplicaCheckpoint,
  command: FreshReplicaLease,
  now: AuthoritativeInstant,
): DurableReplicaCheckpoint {
  if (command.leaseId === checkpoint.leaseId || command.generation === checkpoint.generation) {
    throw new TypeError('A resumed Replica requires a fresh lease ID and lease generation.');
  }
  if (instant(command.leaseExpiresAt, 'Lease expiry').order <= now.order) {
    throw new TypeError('Fresh lease expiry must be later than authoritative time.');
  }
  return Object.freeze({
    ...checkpoint,
    leaseId: command.leaseId,
    generation: command.generation,
    lastSeenAt: now.wire,
    leaseExpiresAt: command.leaseExpiresAt,
    lifecycle: 'active',
  });
}

/**
 * Pure retention completeness check for resume.
 * `ack` is the acknowledged commit ordinal as bigint, or null when unset.
 */
export function isResumeRetentionComplete(
  ack: bigint | null,
  earliestPullCommitOrdinal: string,
  purgedThroughCommitOrdinal: string,
): boolean {
  return ack !== null
    && ack >= ordinal(earliestPullCommitOrdinal, 'Earliest Pull commit ordinal').order
    && ack >= ordinal(purgedThroughCommitOrdinal, 'Purged-through commit ordinal').order;
}

/** Shared auth/success gate for authorized lifecycle commands. */
export function denyUnlessAuthorizedRequest(
  command: { readonly authenticated: boolean; readonly succeeded: boolean },
  checkpoint?: DurableReplicaCheckpoint,
): ReplicaLifecycleCoordinatorResult | undefined {
  if (!command.authenticated) return replicaLifecycleDenied('unauthorized', checkpoint);
  if (!command.succeeded) return replicaLifecycleDenied('request_failed', checkpoint);
  return undefined;
}

// ─── Persist port (implemented by coordinateReplicaLifecycle) ────────────────

export type SaveAndVerifyReplicaCheckpoint = (
  transaction: ReplicaLifecycleTransaction,
  key: ReplicaLifecycleKey,
  checkpoint: DurableReplicaCheckpoint,
) => Promise<DurableReplicaCheckpoint>;

export interface ReplicaCommandTransitionContext {
  readonly transaction: ReplicaLifecycleTransaction;
  readonly key: ReplicaLifecycleKey;
  readonly checkpoint: DurableReplicaCheckpoint;
  readonly now: AuthoritativeInstant;
  readonly saveAndVerify: SaveAndVerifyReplicaCheckpoint;
}

// ─── Largest command branches ────────────────────────────────────────────────

type RenewCommand = Extract<ReplicaLifecycleCommand, { readonly type: 'renew' }>;
type ResumeCommand = Extract<ReplicaLifecycleCommand, { readonly type: 'resume' }>;
type AcknowledgeCommand = Extract<ReplicaLifecycleCommand, { readonly type: 'acknowledge' }>;
type CompleteRecoveryCommand = Extract<ReplicaLifecycleCommand, { readonly type: 'complete_recovery' }>;

/** `renew` command branch — requires active lifecycle and a strictly extended lease. */
export async function applyRenewReplicaCommand(
  ctx: ReplicaCommandTransitionContext,
  command: RenewCommand,
): Promise<ReplicaLifecycleCoordinatorResult> {
  const authDenial = denyUnlessAuthorizedRequest(command, ctx.checkpoint);
  if (authDenial !== undefined) return authDenial;
  if (ctx.checkpoint.lifecycle !== 'active') {
    return replicaLifecycleDenied('stale_replica', ctx.checkpoint);
  }
  const expiry = instant(command.leaseExpiresAt, 'Renewed lease expiry');
  if (
    expiry.order <= ctx.now.order
    || expiry.order <= instant(ctx.checkpoint.leaseExpiresAt, 'Current lease expiry').order
  ) {
    // Renewal must strictly extend the lease beyond authoritative time.
    return replicaLifecycleDenied('invalid_lease_expiry', ctx.checkpoint);
  }
  const renewed = await ctx.saveAndVerify(
    ctx.transaction,
    ctx.key,
    buildRenewedReplicaCheckpoint(ctx.checkpoint, ctx.now.wire, command.leaseExpiresAt),
  );
  return replicaLifecycleCommitted(renewed);
}

/**
 * `acknowledge` command branch — advances the durable Pull acknowledgement of
 * an active Replica. An older position is accepted without a write, so
 * retried or reordered acknowledgements never move it backwards.
 */
export async function applyAcknowledgeReplicaCommand(
  ctx: ReplicaCommandTransitionContext,
  command: AcknowledgeCommand,
): Promise<ReplicaLifecycleCoordinatorResult> {
  const authDenial = denyUnlessAuthorizedRequest(command, ctx.checkpoint);
  if (authDenial !== undefined) return authDenial;
  if (ctx.checkpoint.lifecycle !== 'active') {
    return replicaLifecycleDenied('stale_replica', ctx.checkpoint);
  }
  const requested = ordinal(command.commitOrdinal, 'Acknowledged commit ordinal').order;
  const current = ctx.checkpoint.acknowledgedCommitOrdinal === null
    ? null
    : ordinal(ctx.checkpoint.acknowledgedCommitOrdinal, 'Replica acknowledged commit ordinal').order;
  if (current !== null && requested <= current) {
    if (requested === current && command.cursor !== ctx.checkpoint.acknowledgedCursor) {
      throw new TypeError('Acknowledged Cursor conflicts with the stored Cursor at the same commit ordinal.');
    }
    return replicaLifecycleCommitted(ctx.checkpoint);
  }
  const acknowledged = await ctx.saveAndVerify(ctx.transaction, ctx.key, Object.freeze({
    ...ctx.checkpoint,
    acknowledgedCursor: command.cursor,
    acknowledgedCommitOrdinal: command.commitOrdinal,
    lastSeenAt: ctx.now.wire,
  }));
  return replicaLifecycleCommitted(acknowledged);
}

/**
 * `resume` command branch — retention-window check, then fresh lease or recovery.
 */
export async function applyResumeReplicaCommand(
  ctx: ReplicaCommandTransitionContext,
  command: ResumeCommand,
): Promise<ReplicaLifecycleCoordinatorResult> {
  const authDenial = denyUnlessAuthorizedRequest(command, ctx.checkpoint);
  if (authDenial !== undefined) return authDenial;
  if (ctx.checkpoint.lifecycle !== 'expired') {
    return replicaLifecycleDenied('invalid_replica_state', ctx.checkpoint);
  }
  const activation = await activateFromAcknowledgement(ctx, ctx.checkpoint, command);
  if (activation.state === 'invalid_lease') {
    return replicaLifecycleDenied('invalid_lease_expiry', ctx.checkpoint);
  }
  if (activation.state === 'stale') {
    const recovery = await ctx.saveAndVerify(
      ctx.transaction,
      ctx.key,
      buildRecoveryRequiredReplicaCheckpoint(ctx.checkpoint),
    );
    return replicaLifecycleDenied('stale_replica', recovery, activation.snapshotUrl);
  }
  const resumed = await ctx.saveAndVerify(
    ctx.transaction,
    ctx.key,
    activation.checkpoint,
  );
  return replicaLifecycleCommitted(resumed);
}

/**
 * `complete_recovery` command branch — Snapshot Ack + fresh active lease.
 */
export async function applyCompleteRecoveryReplicaCommand(
  ctx: ReplicaCommandTransitionContext,
  command: CompleteRecoveryCommand,
): Promise<ReplicaLifecycleCoordinatorResult> {
  const authDenial = denyUnlessAuthorizedRequest(command, ctx.checkpoint);
  if (authDenial !== undefined) return authDenial;
  if (ctx.checkpoint.lifecycle !== 'recovery_required') {
    return replicaLifecycleDenied('invalid_replica_state', ctx.checkpoint);
  }
  const rawSnapshot = await requirePromise(
    ctx.transaction.loadAuthoritativeSnapshot(command.snapshotId),
    'Authoritative Snapshot load',
  );
  if (rawSnapshot === undefined) {
    return replicaLifecycleDenied('stale_replica', ctx.checkpoint);
  }
  const snapshot = immutableSnapshot(rawSnapshot, ctx.checkpoint.collectionId, command.snapshotId);
  const ack = Object.freeze({
    ...snapshot,
    replicaId: ctx.key.replicaId,
    appliedAt: ctx.now.wire,
  });
  const activation = await activateFromAcknowledgement(
    ctx,
    buildSnapshotAcknowledgedReplicaCheckpoint(ctx.checkpoint, snapshot),
    command,
  );
  if (activation.state === 'invalid_lease') {
    return replicaLifecycleDenied('invalid_lease_expiry', ctx.checkpoint);
  }
  if (activation.state === 'stale') {
    return replicaLifecycleDenied('stale_replica', ctx.checkpoint, activation.snapshotUrl);
  }
  await requirePromise(ctx.transaction.saveSnapshotAck(structuredClone(ack)), 'Snapshot Ack save');
  const ackReadback = await requirePromise(
    ctx.transaction.loadSnapshotAck(ctx.key.replicaId),
    'Snapshot Ack transaction-local read-back',
  );
  if (ackReadback === undefined) throw new TypeError('Snapshot Ack was not persisted by the adapter.');
  immutableAck(ackReadback, ack);
  const persisted = await ctx.saveAndVerify(ctx.transaction, ctx.key, activation.checkpoint);
  const finalAck = await requirePromise(
    ctx.transaction.loadSnapshotAck(ctx.key.replicaId),
    'Snapshot Ack final transaction-local read-back',
  );
  if (finalAck === undefined) throw new TypeError('Snapshot Ack disappeared before lifecycle commit.');
  immutableAck(finalAck, ack);
  return replicaLifecycleCommitted(persisted);
}

/** Both activation paths require an acknowledgement inside the locked retention window. */
async function activateFromAcknowledgement(
  ctx: ReplicaCommandTransitionContext,
  checkpoint: DurableReplicaCheckpoint,
  command: FreshReplicaLease,
): Promise<
  | { readonly state: 'ready'; readonly checkpoint: DurableReplicaCheckpoint }
  | { readonly state: 'stale'; readonly snapshotUrl: string }
  | { readonly state: 'invalid_lease' }
> {
  // Checked before the retention decision so a lapsed request adds no recovery
  // transition. The coordinator may already have persisted automatic expiry.
  if (instant(command.leaseExpiresAt, 'Lease expiry').order <= ctx.now.order) {
    return { state: 'invalid_lease' };
  }
  const window = immutableWindow(
    await requirePromise(
      ctx.transaction.loadRetentionWindow(checkpoint.collectionId),
      'Retention window load',
    ),
    checkpoint.collectionId,
  );
  const ack = checkpoint.acknowledgedCommitOrdinal === null
    ? null
    : ordinal(checkpoint.acknowledgedCommitOrdinal, 'Acknowledged commit ordinal').order;
  const complete = isResumeRetentionComplete(
    ack,
    window.earliestPull.commitOrdinal,
    window.purgedThrough.commitOrdinal,
  );
  return complete
    ? { state: 'ready', checkpoint: buildFreshActiveLeaseCheckpoint(checkpoint, command, ctx.now) }
    : { state: 'stale', snapshotUrl: window.snapshotUrl };
}
