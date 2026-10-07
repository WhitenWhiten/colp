import type { SyncPullCursorContext, SyncPullTuple } from './application/sync-pull.js';

export interface SyncRouteAuthorityContext {
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly sessionId: string;
  readonly leaseGeneration: string;
  readonly lifecycleRevision: string;
  readonly policyRevision: string;
  readonly protocolVersion: '0.1' | '0.2';
}

export function buildSyncRouteAuthorityContext(input: SyncRouteAuthorityContext): SyncRouteAuthorityContext {
  for (const value of [input.accountId, input.collectionId, input.replicaId, input.sessionId,
    input.policyRevision]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
      throw new TypeError('Sync route authority identity is invalid');
    }
  }
  for (const value of [input.leaseGeneration, input.lifecycleRevision]) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || value.length > 19) {
      throw new TypeError('Sync route authority revision is invalid');
    }
  }
  if (input.leaseGeneration === '0' || !['0.1', '0.2'].includes(input.protocolVersion)) {
    throw new TypeError('Sync route authority protocol or generation is invalid');
  }
  return Object.freeze({ accountId: input.accountId, collectionId: input.collectionId,
    replicaId: input.replicaId, sessionId: input.sessionId, leaseGeneration: input.leaseGeneration,
    lifecycleRevision: input.lifecycleRevision, policyRevision: input.policyRevision,
    protocolVersion: input.protocolVersion });
}

export function syncPullCursorContext(
  authority: SyncRouteAuthorityContext,
  purgeBoundary: SyncPullTuple,
  limit: number,
): SyncPullCursorContext {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError('Sync route authority page limit is invalid');
  }
  return Object.freeze({ replicaId: authority.replicaId, collectionId: authority.collectionId,
    leaseGeneration: authority.leaseGeneration, sessionId: authority.sessionId,
    principalId: authority.accountId, protocolVersion: authority.protocolVersion,
    policyRevision: authority.policyRevision, purgeBoundary, limit });
}

export function sameSyncRouteLineage(
  left: SyncRouteAuthorityContext,
  right: SyncRouteAuthorityContext,
): boolean {
  return left.accountId === right.accountId && left.collectionId === right.collectionId
    && left.replicaId === right.replicaId && left.leaseGeneration === right.leaseGeneration
    && left.policyRevision === right.policyRevision && left.protocolVersion === right.protocolVersion
    && BigInt(left.lifecycleRevision) <= BigInt(right.lifecycleRevision);
}
