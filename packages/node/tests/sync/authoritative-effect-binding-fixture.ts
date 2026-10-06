/**
 * Shared fixtures for the assertEffectBinding guard-level evidence suites.
 * Extracted from authoritative-effect-binding.test.ts so the suites stay under
 * the test-granularity ceiling.
 */
import { createHash } from 'node:crypto';
import { vi } from 'vitest';

import type { AuthoritativePullEffect, Operation } from '../../src/types/index.js';
import { assertEffectBinding } from '../../src/sync/authoritative-effect-kind.js';
import {
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
} from '../../src/sync/index.js';

/**
 * Guard-level evidence for the authoritative Operation→effect binding. These
 * tests call assertEffectBinding directly so each semantic check is reachable
 * without the transport schema short-circuiting malformed wire shapes; every
 * counterexample recomputes real digests so only the intended guard can fire.
 */
export const evidence = '[evidence:sync.authoritative-pull-effects]';

export const timestamp = '2026-07-27T00:00:00Z';
export const WRONG_DIGEST = `sha-256=:${'B'.repeat(43)}=:`;
export const urlHashOf = (url: string) =>
  `sha-256=:${createHash('sha256').update(url).digest('base64')}:`;

export const operationBase = {
  opId: 'op-1',
  replicaId: 'replica-1',
  sequence: 7,
  collectionId: 'collection-1',
  occurredAt: timestamp,
};

export const folderNode = {
  id: 'node-1',
  collectionId: 'collection-1',
  kind: 'folder' as const,
  parentId: 'folder-2',
  position: 'a',
  title: 'Node',
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 'r-9',
};

export const placement = { parentId: 'folder-2', afterId: null, beforeId: null, position: 'a' };
export const parentRevision = { parentId: 'folder-2', childrenRevision: 'cr-12' };

export function tombstone(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: 'node' as const,
    targetId: 'node-1',
    collectionId: 'collection-1',
    scope: 'single' as const,
    deletedAt: timestamp,
    deleteRevision: 'delete-r-1',
    operationId: 'op-1',
    deleteCursor: 'cursor-delete-1',
    affectedCount: 1,
    purgeAfter: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

export const effectBinding = {
  effectId: 'effect-1',
  status: 'applied' as const,
  opId: operationBase.opId,
  replicaId: operationBase.replicaId,
  sequence: operationBase.sequence,
  collectionId: operationBase.collectionId,
  operationDigest: WRONG_DIGEST,
  effectDigest: WRONG_DIGEST,
};

export type EffectKind = 'create_node' | 'update_node_content' | 'move_node'
  | 'delete_node' | 'delete_subtree' | 'restore_node';

export function fixture(type: EffectKind): { operation: Operation; effect: AuthoritativePullEffect } {
  switch (type) {
    case 'create_node':
      return {
        operation: {
          ...operationBase, type, baseRevision: null,
          payload: { parentId: 'folder-2', node: { kind: 'folder', title: 'Node' } },
        } as Operation,
        effect: {
          ...effectBinding, kind: 'node_created', node: folderNode, placement,
          parentRevision, nodeChildrenRevision: 'cr-node-1',
        } as unknown as AuthoritativePullEffect,
      };
    case 'update_node_content':
      return {
        operation: {
          ...operationBase, type, targetId: 'node-1', baseRevision: 'r-8',
          payload: { base: { title: 'Before' }, value: { title: 'After' } },
        } as Operation,
        effect: {
          ...effectBinding, kind: 'node_content_updated', node: folderNode,
        } as unknown as AuthoritativePullEffect,
      };
    case 'move_node':
      return {
        operation: {
          ...operationBase, type, targetId: 'node-1', baseRevision: 'r-8',
          payload: {
            newParentId: 'folder-2', afterId: null, beforeId: null,
            baseSourceParentRevision: 'cr-7', baseTargetParentRevision: 'cr-11',
          },
        } as Operation,
        effect: {
          ...effectBinding, kind: 'node_moved', node: folderNode, placement,
          parentRevisions: [
            { parentId: 'folder-1', childrenRevision: 'cr-8' },
            { parentId: 'folder-2', childrenRevision: 'cr-12' },
          ],
        } as unknown as AuthoritativePullEffect,
      };
    case 'delete_node':
      return {
        operation: {
          ...operationBase, type, targetId: 'node-1', baseRevision: 'r-8',
          payload: { reason: 'removed' },
        } as Operation,
        effect: {
          ...effectBinding, kind: 'node_deleted',
          deletion: tombstone(), tombstone: tombstone(), parentRevision,
        } as unknown as AuthoritativePullEffect,
      };
    case 'delete_subtree':
      return {
        operation: {
          ...operationBase, type, targetId: 'node-1', baseRevision: 'r-8',
          payload: { reason: 'removed' },
        } as Operation,
        effect: {
          ...effectBinding, kind: 'subtree_deleted',
          rootTombstone: tombstone({ scope: 'subtree', affectedCount: 1 }),
          members: ['node-1'], memberCount: 1,
          memberDigest: canonicalAuthoritativeMemberDigest(['node-1']),
          parentRevision,
        } as unknown as AuthoritativePullEffect,
      };
    case 'restore_node':
      return {
        operation: {
          ...operationBase, type, targetId: 'node-1', baseRevision: 'delete-r-1',
          payload: { reason: 'restore' },
        } as Operation,
        effect: {
          ...effectBinding, kind: 'node_restored',
          node: { ...folderNode, revision: 'r-restored' }, placement, parentRevision,
          consumedTombstone: tombstone(),
        } as unknown as AuthoritativePullEffect,
      };
  }
}

/** Recomputes real digests so a counterexample can only fail the target guard. */
export function seal(operation: Operation, effect: object): AuthoritativePullEffect {
  const bound = { ...effect, operationDigest: canonicalOperationDigest(operation) };
  return {
    ...bound,
    effectDigest: canonicalAuthoritativeEffectDigest(bound),
  } as AuthoritativePullEffect;
}

export function binding(
  operation: Operation,
  effect: object,
  options: { authority?: string; template?: string; onPage?: (id: string, t?: string, a?: string) => void } = {},
) {
  return () => assertEffectBinding(
    operation,
    seal(operation, effect),
    options.authority,
    options.template,
    options.onPage ?? vi.fn(),
  );
}
