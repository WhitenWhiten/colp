import { describe, expect, it } from 'vitest';

import {
  assertSyncTypedUpdateOperationPayload,
  SyncTypedUpdateSemanticError,
  validateSyncTypedUpdateOperationPayload,
  type SyncTypedUpdateOperation,
} from '../../src/sync/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = '[evidence:sync.typed-update-merge-boundary]';
const occurredAt = '2026-07-18T00:00:00Z';

function operation(payload: unknown, type: SyncTypedUpdateOperation['type'] = 'update_node_content') {
  return {
    opId: 'op-sync-0017',
    replicaId: 'replica-1',
    sequence: 1,
    collectionId: 'collection-1',
    type,
    targetId: 'node-1',
    baseRevision: 'revision-1',
    occurredAt,
    payload,
  } as unknown as SyncTypedUpdateOperation;
}

describe(`SYNC-0017 typed-update merge boundary ${evidence}`, () => {
  const registry = createValidatorRegistry();

  type BoundaryCase = {
    readonly label: string;
    readonly payload: unknown;
    readonly semantic: boolean;
    readonly canonical: boolean;
  };

  it(`returns a stable frozen semantic result for an exact typed merge ${evidence}`, () => {
    const candidate = operation({
      base: { title: 'before', tags: ['old'] },
      value: { tags: ['new'], title: 'after' },
    });

    const first = validateSyncTypedUpdateOperationPayload(candidate);
    const second = validateSyncTypedUpdateOperationPayload(candidate);
    expect(first).toEqual({ valid: true });
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each<BoundaryCase>([
    {
      label: 'JSON Pointer member',
      payload: { base: { '/title': 'before' }, value: { '/title': 'after' } },
      semantic: false,
      canonical: false,
    },
    {
      label: 'prototype-polluting member',
      payload: { base: { constructor: 'before' }, value: { constructor: 'after' } },
      semantic: true,
      canonical: false,
    },
    {
      label: 'move-only parent context',
      payload: { base: { parentId: 'parent-a' }, value: { parentId: 'parent-b' } },
      semantic: true,
      canonical: false,
    },
    {
      label: 'reorder-only child sequence',
      payload: { base: { childIds: ['child-a'] }, value: { childIds: ['child-b'] } },
      semantic: true,
      canonical: false,
    },
  ])(`rejects the $label bypass at the appropriate validation boundary ${evidence}`, ({ payload, semantic, canonical }) => {
    const candidate = operation(payload);
    expect(registry.validate('operation', candidate).valid).toBe(canonical);
    expect(validateSyncTypedUpdateOperationPayload(candidate).valid).toBe(semantic);
  });

  it(`rejects inherited typed data and exposes the stable invalid-document error ${evidence}`, () => {
    const base = Object.create({ title: 'inherited' }) as Record<string, unknown>;
    base.tags = ['old'];
    const candidate = operation({ base, value: { tags: ['new'] } });

    const result = validateSyncTypedUpdateOperationPayload(candidate);
    expect(result).toMatchObject({ valid: false, status: 422, code: 'invalid_document' });
    expect(result).toBe(validateSyncTypedUpdateOperationPayload(candidate));
    expect(() => assertSyncTypedUpdateOperationPayload(candidate)).toThrow(
      SyncTypedUpdateSemanticError,
    );
  });
});
