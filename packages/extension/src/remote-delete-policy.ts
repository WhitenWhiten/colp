import type { SyncPullEventV02 } from '@know-n/colp/types';
import { digestJson } from './bookmark-event-codec.js';
import type { QueueOperation, RemoteDeletePolicy } from './sync-state/types.js';

export type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

export function isRemoteDeletePolicy(value: unknown): value is RemoteDeletePolicy {
  return value === 'sync' || value === 'confirm' || value === 'keep_local';
}

export function isRemoteDeleteEffect(effect: OpEvent['effect']): effect is Extract<OpEvent['effect'],
  { kind: 'node_deleted' | 'subtree_deleted' }> {
  return effect.kind === 'node_deleted' || effect.kind === 'subtree_deleted';
}

export function remoteDeleteTargetId(effect: OpEvent['effect']): string | null {
  if (effect.kind === 'node_deleted') return effect.tombstone.targetId;
  if (effect.kind === 'subtree_deleted') return effect.rootTombstone.targetId;
  return null;
}

export function remoteDeleteMemberIds(event: OpEvent): readonly string[] {
  const effect = event.effect;
  if (effect.kind === 'node_deleted') return [effect.tombstone.targetId];
  if (effect.kind === 'subtree_deleted') {
    const members = 'members' in effect ? effect.members : undefined;
    const verified = (event as unknown as { readonly verifiedMembers?: readonly string[] }).verifiedMembers;
    return members ?? verified ?? [];
  }
  return [];
}

export function remoteDeleteRevision(effect: OpEvent['effect']): string | null {
  if (effect.kind === 'node_deleted') return effect.tombstone.deleteRevision;
  if (effect.kind === 'subtree_deleted') return effect.rootTombstone.deleteRevision;
  return null;
}

export function remoteDeleteDecisionId(eventId: string): string {
  return `rdd:${digestJson({ eventId }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

export function remoteDeleteRestoreOpId(decisionId: string): string {
  return `rdr.${digestJson({ decisionId }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

const STANDING_LOCAL_DELETE = new Set(['pending', 'claimed', 'deferred', 'terminal', 'gap', 'blocked', 'unknown', 'set_aside']);

/**
 * A server-supplied replica id is not proof this browser deleted the bookmark.
 * Skip confirmation only when the local queue still has this delete, committed or in flight.
 */
export function isSelfEchoDelete(event: OpEvent, replicaId: string, queued: QueueOperation | null): boolean {
  if (event.operation.replicaId !== replicaId || !isRemoteDeleteEffect(event.effect) || !queued) return false;
  if (queued.recovery?.resultStatus === 'rejected' || !STANDING_LOCAL_DELETE.has(queued.status)) return false;
  const type = event.effect.kind === 'subtree_deleted' ? 'delete_subtree' : 'delete_node';
  return queued.payload.type === type && queued.payload.targetId === remoteDeleteTargetId(event.effect);
}
