/**
 * Closed Operation→effect kind binding for COLP 0.2 Authoritative Pull.
 * Extracted from pull.ts so restore_node / node_restored can land without
 * growing the grandfathered pull coordinator file.
 */

import { immutableJsonSnapshot } from '../shared/immutable-json.js';
import { validateNodeUrlHashSemantics } from '../semantic/bookmark-url-hash.js';
import type { AuthoritativePullEffect, Operation } from '../types/index.js';
import {
  AUTHORITATIVE_EFFECT_MAX_BYTES,
  AUTHORITATIVE_EFFECT_MAX_DEPTH,
  AUTHORITATIVE_EFFECT_MAX_MEMBERS,
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
  encodeCanonicalJson,
} from './canonical.js';

const authoritativeDigestPattern = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;

const effectKinds = new Map<string, string>([
  ['create_node', 'node_created'],
  ['update_node_content', 'node_content_updated'],
  ['move_node', 'node_moved'],
  ['delete_node', 'node_deleted'],
  ['delete_subtree', 'subtree_deleted'],
  ['restore_node', 'node_restored'],
]);

export type EffectPageTemplateAssert = (
  effectId: string,
  template: string | undefined,
  authority: string | undefined,
) => void;

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !authoritativeDigestPattern.test(value)) {
    throw new TypeError(`${label} must be an RFC 9530 sha-256 digest.`);
  }
}

export function assertEffectBinding(
  operation: Operation,
  effect: AuthoritativePullEffect,
  effectPageAuthority: string | undefined,
  effectPageTemplate: string | undefined,
  assertPagedTemplate: EffectPageTemplateAssert,
): void {
  immutableJsonSnapshot(effect, 'Authoritative Pull effect', {
    maxDepth: AUTHORITATIVE_EFFECT_MAX_DEPTH,
    maxMembers: AUTHORITATIVE_EFFECT_MAX_MEMBERS,
  });
  if (effect.opId !== operation.opId || effect.replicaId !== operation.replicaId
    || effect.sequence !== operation.sequence || effect.collectionId !== operation.collectionId) {
    throw new TypeError('Authoritative Pull effect does not match its source Operation binding.');
  }
  const expectedKind = effectKinds.get(operation.type);
  if (expectedKind === undefined || effect.kind !== expectedKind) {
    throw new TypeError('Authoritative Pull effect kind does not match its Operation type.');
  }
  assertDigest(effect.operationDigest, 'Authoritative Pull operationDigest');
  assertDigest(effect.effectDigest, 'Authoritative Pull effectDigest');
  if (effect.operationDigest !== canonicalOperationDigest(operation)) {
    throw new TypeError('Authoritative Pull operationDigest does not match the canonical Operation.');
  }
  if (effect.effectDigest !== canonicalAuthoritativeEffectDigest(effect)) {
    throw new TypeError('Authoritative Pull effectDigest does not match the canonical effect.');
  }
  if (Buffer.byteLength(encodeCanonicalJson(effect, 'Canonical JSON input'), 'utf8') > AUTHORITATIVE_EFFECT_MAX_BYTES) {
    throw new RangeError('Authoritative Pull effect exceeds its byte budget.');
  }
  if ('node' in effect) {
    if (effect.node.id === effect.node.parentId) {
      throw new TypeError('Authoritative Pull Node cannot be its own parent.');
    }
    if (!validateNodeUrlHashSemantics(effect.node).valid) {
      throw new TypeError('Authoritative Pull Node urlHash does not match its URL.');
    }
  }

  // effectKinds is a closed bijection: once the kind binding above holds, the
  // Operation type is fixed by effect.kind, so narrow it for payload access.
  if (effect.kind === 'node_created') {
    const create = operation as Extract<Operation, { type: 'create_node' }>;
    if (effect.node.kind !== create.payload.node.kind) {
      throw new TypeError('node_created effect Node kind does not match its create DTO.');
    }
    if (effect.node.collectionId !== create.collectionId
      || effect.placement.parentId !== create.payload.parentId
      || effect.node.parentId !== effect.placement.parentId
      || effect.node.position !== effect.placement.position
      || effect.parentRevision.parentId !== effect.placement.parentId) {
      throw new TypeError('node_created effect placement or parent revision is not authoritative.');
    }
    if ((effect.node.kind === 'folder') !== (effect.nodeChildrenRevision !== null)) {
      throw new TypeError('node_created effect has invalid Node children revision authority.');
    }
  } else if (effect.kind === 'node_content_updated') {
    const update = operation as Extract<Operation, { type: 'update_node_content' }>;
    if (effect.node.id !== update.targetId || effect.node.collectionId !== update.collectionId) {
      throw new TypeError('node_content_updated effect Node does not match its target.');
    }
  } else if (effect.kind === 'node_moved') {
    const move = operation as Extract<Operation, { type: 'move_node' }>;
    const payload = move.payload;
    const sourceRevision = effect.parentRevisions[0];
    const targetRevision = effect.parentRevisions.at(-1);
    if (effect.node.id !== move.targetId || effect.node.collectionId !== move.collectionId
      || effect.placement.parentId !== payload.newParentId
      || effect.node.parentId !== effect.placement.parentId
      || effect.node.position !== effect.placement.position
      || (effect.parentRevisions.length !== 1 && effect.parentRevisions.length !== 2)
      || targetRevision?.parentId !== payload.newParentId
      || (effect.parentRevisions.length === 2 && sourceRevision?.parentId === targetRevision.parentId)) {
      throw new TypeError('node_moved effect lacks authoritative source/target parent revisions.');
    }
  } else if (effect.kind === 'node_deleted') {
    const deleted = operation as Extract<Operation, { type: 'delete_node' }>;
    for (const authority of [effect.deletion, effect.tombstone]) {
      if (authority.resourceType !== 'node'
        || authority.targetId !== deleted.targetId || authority.collectionId !== deleted.collectionId
        || authority.operationId !== deleted.opId) {
        throw new TypeError('node_deleted authority is not bound to the Operation.');
      }
    }
    if (effect.deletion.scope !== 'single' || effect.deletion.affectedCount !== 1
      || encodeCanonicalJson(effect.deletion, 'Canonical JSON input')
        !== encodeCanonicalJson(effect.tombstone, 'Canonical JSON input')) {
      throw new TypeError('node_deleted authority must be one exact single-node Tombstone.');
    }
  } else if (effect.kind === 'node_restored') {
    const restored = operation as Extract<Operation, { type: 'restore_node' }>;
    if (effect.node.id !== restored.targetId || effect.node.collectionId !== restored.collectionId) {
      throw new TypeError('node_restored effect Node does not match its original target.');
    }
    if (effect.node.revision === effect.consumedTombstone.deleteRevision) {
      throw new TypeError('node_restored effect must carry a new Node revision.');
    }
    if (effect.consumedTombstone.resourceType !== 'node'
      || effect.consumedTombstone.targetId !== restored.targetId
      || effect.consumedTombstone.collectionId !== restored.collectionId
      || typeof effect.consumedTombstone.deleteCursor !== 'string'
      || effect.consumedTombstone.deleteCursor.length === 0) {
      throw new TypeError('node_restored consumed Tombstone is not bound to the Operation.');
    }
    if (effect.placement.parentId !== effect.node.parentId
      || effect.node.position !== effect.placement.position
      || effect.parentRevision.parentId !== effect.placement.parentId) {
      throw new TypeError('node_restored effect placement or parent revision is not authoritative.');
    }
  } else {
    const subtree = operation as Extract<Operation, { type: 'delete_subtree' }>;
    if (effect.rootTombstone.resourceType !== 'node'
      || effect.rootTombstone.targetId !== subtree.targetId
      || effect.rootTombstone.collectionId !== subtree.collectionId
      || effect.rootTombstone.operationId !== subtree.opId
      || effect.rootTombstone.scope !== 'subtree'
      || effect.rootTombstone.affectedCount !== effect.memberCount) {
      throw new TypeError('subtree_deleted root Tombstone is not bound to the Operation.');
    }
    if ('members' in effect && effect.members !== undefined && effect.members.length !== effect.memberCount) {
      throw new TypeError('subtree_deleted memberCount does not match exact inline members.');
    }
    if ('members' in effect && effect.members !== undefined && !effect.members.includes(subtree.targetId)) {
      throw new TypeError('subtree_deleted exact members must include the deleted root.');
    }
    if ('members' in effect && effect.members !== undefined
      && canonicalAuthoritativeMemberDigest(effect.members) !== effect.memberDigest) {
      throw new TypeError('subtree_deleted memberDigest does not match exact inline members.');
    }
    if ('effectRef' in effect && effect.effectRef !== undefined
      && (effect.effectRef.memberCount !== effect.memberCount
        || effect.effectRef.memberDigest !== effect.memberDigest)) {
      throw new TypeError('subtree_deleted effect page reference does not match member authority.');
    }
    if ('effectRef' in effect && effect.effectRef !== undefined) {
      assertPagedTemplate(effect.effectId, effectPageTemplate, effectPageAuthority);
    }
  }
}
