import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
  expandAuthoritativeEffectPageUrl,
  validateAuthoritativePullEvent,
} from '../../src/sync/index.js';

const pathTemplate = 'https://sync.example/colp/v0.1/sync/effects/{effectId}/pages/{pageNumber}';
const sentinelTemplate = 'https://sync.example/colp/v0.1/sync/effects/~{effectId}/pages/{pageNumber}';
const dotSegmentError = /path segment/u;

describe('authoritative effect-page URLs keep addressing the requested effect', () => {
  it.each(['.', '..'])('effectId %j is a valid wire ID', (effectId) => {
    expect(createValidatorRegistry().validate('opaqueId', effectId).valid).toBe(true);
  });

  it.each(['.', '..'])('rejects effectId %j in a path-segment template instead of returning a collapsing URL', (effectId) => {
    expect(() => expandAuthoritativeEffectPageUrl(pathTemplate, effectId, 1)).toThrow(TypeError);
    expect(() => expandAuthoritativeEffectPageUrl(pathTemplate, effectId, 1)).toThrow(dotSegmentError);
  });

  it.each([
    [sentinelTemplate, '..', 'https://sync.example/colp/v0.1/sync/effects/~../pages/3'],
    [sentinelTemplate, '.', 'https://sync.example/colp/v0.1/sync/effects/~./pages/3'],
    ['https://sync.example/effects?effect={effectId}&page={pageNumber}', '..', 'https://sync.example/effects?effect=..&page=3'],
    ['https://sync.example/effects/{effectId}.json?page={pageNumber}', '..', 'https://sync.example/effects/...json?page=3'],
    [pathTemplate, 'a.b', 'https://sync.example/colp/v0.1/sync/effects/a.b/pages/3'],
    [pathTemplate, '...', 'https://sync.example/colp/v0.1/sync/effects/.../pages/3'],
  ] as const)('keeps %s with effectId %j stable under URL normalization', (template, effectId, expected) => {
    const expanded = expandAuthoritativeEffectPageUrl(template, effectId, 3);
    expect(expanded).toBe(expected);
    expect(new URL(expanded).href).toBe(expanded);
  });
});

describe('paged subtree effects with a dot effectId', () => {
  function pagedEvent(effectId: string) {
    const operation = {
      opId: 'op-1', replicaId: 'replica-source', sequence: 7, collectionId: 'collection-1',
      type: 'delete_subtree' as const, targetId: 'node-1', baseRevision: 'r-8',
      occurredAt: '2026-07-27T00:00:00Z', payload: { reason: 'removed' },
    };
    const members = ['node-1'];
    const memberDigest = canonicalAuthoritativeMemberDigest(members);
    const pageInput = { effectId, pageNumber: 1, pageCount: 1, members, memberCount: 1,
      pageDigest: `sha-256=:${'A'.repeat(43)}=:`, previousPageDigest: null };
    const firstPageDigest = canonicalAuthoritativeEffectPageDigest(pageInput as never);
    const input = {
      effectId, status: 'applied' as const, opId: 'op-1', replicaId: 'replica-source', sequence: 7,
      collectionId: 'collection-1', operationDigest: canonicalOperationDigest(operation),
      effectDigest: `sha-256=:${'B'.repeat(43)}=:`, kind: 'subtree_deleted' as const,
      rootTombstone: {
        resourceType: 'node' as const, targetId: 'node-1', collectionId: 'collection-1',
        scope: 'subtree' as const, deletedAt: '2026-07-27T00:00:00Z', deleteRevision: 'delete-r-1',
        operationId: 'op-1', affectedCount: 1, purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'c',
      },
      memberCount: 1, memberDigest,
      effectRef: { pageCount: 1, memberCount: 1, memberDigest, firstPageDigest },
      parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-13' },
    };
    const effect = { ...input, effectDigest: canonicalAuthoritativeEffectDigest(input as never) };
    return { cursor: 'c', kind: 'operation', operation, effect } as never;
  }

  const authority = 'https://sync.example';

  it.each(['.', '..'])('is rejected when the trusted template would collapse effectId %j', (effectId) => {
    expect(() => validateAuthoritativePullEvent(pagedEvent(effectId), '0.2', {
      effectPageAuthority: authority, effectPageTemplate: pathTemplate,
    })).toThrow(dotSegmentError);
  });

  it.each(['.', '..'])('is accepted through a sentinel-bound template for effectId %j', (effectId) => {
    expect(validateAuthoritativePullEvent(pagedEvent(effectId), '0.2', {
      effectPageAuthority: authority, effectPageTemplate: sentinelTemplate,
    })).toMatchObject({ kind: 'operation' });
  });

  it('still accepts an ordinary effectId through the path template', () => {
    expect(validateAuthoritativePullEvent(pagedEvent('effect-pages'), '0.2', {
      effectPageAuthority: authority, effectPageTemplate: pathTemplate,
    })).toMatchObject({ kind: 'operation' });
  });
});
