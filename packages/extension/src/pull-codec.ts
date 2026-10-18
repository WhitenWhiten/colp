import { SyncFailureError } from './sync-failure-class.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AuthoritativeEffectPage, SyncPullEventV02 } from '@know-n/colp/types';
import { canonicalAuthoritativeEffectDigest, canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest, canonicalOperationDigest } from '@know-n/colp/sync/canonical';
import type { JsonObject } from './sync-state-store.js';
import { authoritativeEffectPage } from './generated/pull-effect-validators.js';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SyncFailureError('i_json_invalid');
  return encoded;
}

export function digest(value: unknown) {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(stable(value))))}`;
}

export function byteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function plainJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function assertUniqueEvents(events: readonly SyncPullEventV02[]) {
  const cursors = new Set<string>(); const operations = new Set<string>(); const effects = new Set<string>();
  const conflicts = new Set<string>();
  for (const event of events) {
    if (cursors.has(event.cursor)) throw new SyncFailureError('pull_event_duplicate'); cursors.add(event.cursor);
    if (event.kind === 'conflict') {
      if (conflicts.has(event.conflict.id)) throw new SyncFailureError('pull_event_duplicate');
      conflicts.add(event.conflict.id); continue;
    }
    if (operations.has(event.operation.opId) || effects.has(event.effect.effectId)) {
      throw new SyncFailureError('pull_event_duplicate');
    }
    operations.add(event.operation.opId); effects.add(event.effect.effectId);
  }
}

export function validatePullEvent(candidate: SyncPullEventV02): SyncPullEventV02 {
  if (candidate.kind === 'conflict') return candidate;
  const { operation, effect } = candidate;
  if (effect.opId !== operation.opId || effect.replicaId !== operation.replicaId
      || effect.sequence !== operation.sequence || effect.collectionId !== operation.collectionId
      || effect.operationDigest !== canonicalOperationDigest(operation)
      || effect.effectDigest !== canonicalAuthoritativeEffectDigest(effect as unknown as Record<string, unknown>)) {
    throw new SyncFailureError('pull_effect_binding_invalid');
  }
  if (effect.kind === 'node_created') {
    if (operation.type !== 'create_node' || effect.node.collectionId !== operation.collectionId
        || effect.placement.parentId !== operation.payload.parentId || effect.node.parentId !== effect.placement.parentId
        || effect.node.position !== effect.placement.position || effect.parentRevision.parentId !== effect.placement.parentId
        || (effect.node.kind === 'folder') !== (effect.nodeChildrenRevision !== null)) {
      throw new SyncFailureError('pull_effect_binding_invalid');
    }
  } else if (effect.kind === 'node_content_updated') {
    if (operation.type !== 'update_node_content' || effect.node.id !== operation.targetId
        || effect.node.collectionId !== operation.collectionId) throw new SyncFailureError('pull_effect_binding_invalid');
  } else if (effect.kind === 'node_moved') {
    const target = effect.parentRevisions.at(-1);
    if (operation.type !== 'move_node' || effect.node.id !== operation.targetId
        || effect.node.collectionId !== operation.collectionId || effect.placement.parentId !== operation.payload.newParentId
        || effect.node.parentId !== effect.placement.parentId || effect.node.position !== effect.placement.position
        || target?.parentId !== operation.payload.newParentId
        || (effect.parentRevisions.length === 2 && effect.parentRevisions[0]?.parentId === target.parentId)) {
      throw new SyncFailureError('pull_effect_binding_invalid');
    }
  } else if (effect.kind === 'node_deleted') {
    if (operation.type !== 'delete_node' || effect.deletion.targetId !== operation.targetId
        || effect.deletion.collectionId !== operation.collectionId || effect.deletion.operationId !== operation.opId
        || effect.deletion.scope !== 'single' || effect.deletion.affectedCount !== 1
        || stable(effect.deletion) !== stable(effect.tombstone)) throw new SyncFailureError('pull_effect_binding_invalid');
  } else if (effect.kind === 'node_restored') {
    if (operation.type !== 'restore_node' || effect.node.id !== operation.targetId
        || effect.node.collectionId !== operation.collectionId
        || effect.node.revision === effect.consumedTombstone.deleteRevision
        || effect.consumedTombstone.targetId !== operation.targetId
        || effect.consumedTombstone.collectionId !== operation.collectionId
        || typeof effect.consumedTombstone.deleteCursor !== 'string'
        || effect.consumedTombstone.deleteCursor.length === 0
        || effect.placement.parentId !== effect.node.parentId
        || effect.node.position !== effect.placement.position
        || effect.parentRevision.parentId !== effect.placement.parentId) {
      throw new SyncFailureError('pull_effect_binding_invalid');
    }
  } else if (effect.kind === 'subtree_deleted') {
    if (operation.type !== 'delete_subtree' || effect.rootTombstone.targetId !== operation.targetId
        || effect.rootTombstone.collectionId !== operation.collectionId || effect.rootTombstone.operationId !== operation.opId
        || effect.rootTombstone.scope !== 'subtree' || effect.rootTombstone.affectedCount !== effect.memberCount) {
      throw new SyncFailureError('pull_effect_binding_invalid');
    }
    if ('members' in effect && effect.members
        && (effect.members.length !== effect.memberCount
          || canonicalAuthoritativeMemberDigest(effect.members) !== effect.memberDigest)) {
      throw new SyncFailureError('pull_effect_binding_invalid');
    }
    if ('effectRef' in effect && effect.effectRef
        && (effect.effectRef.memberCount !== effect.memberCount
          || effect.effectRef.memberDigest !== effect.memberDigest)) throw new SyncFailureError('pull_effect_binding_invalid');
  } else throw new SyncFailureError('pull_effect_kind_invalid');
  return candidate;
}

export function validateEffectPages(pages: readonly AuthoritativeEffectPage[], reference: {
  readonly effectId: string; readonly pageCount: number; readonly memberCount: number;
  readonly memberDigest: string; readonly firstPageDigest: string;
}) {
  if (pages.length !== reference.pageCount) throw new SyncFailureError('effect_page_invalid');
  let previous: string | null = null; const members: string[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    if (!authoritativeEffectPage(page) || page.effectId !== reference.effectId || page.pageNumber !== index + 1
        || page.pageCount !== reference.pageCount || page.previousPageDigest !== previous
        || page.memberCount !== page.members.length
        || page.pageDigest !== canonicalAuthoritativeEffectPageDigest(page as unknown as Record<string, unknown>)) {
      throw new SyncFailureError('effect_page_invalid');
    }
    if (index === 0 && page.pageDigest !== reference.firstPageDigest) throw new SyncFailureError('effect_page_invalid');
    previous = page.pageDigest; members.push(...page.members);
  }
  if (members.length !== reference.memberCount || new Set(members).size !== members.length
      || canonicalAuthoritativeMemberDigest(members) !== reference.memberDigest) throw new SyncFailureError('effect_page_invalid');
}
