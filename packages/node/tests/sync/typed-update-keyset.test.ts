import { describe, expect, it } from 'vitest';

import {
  assertSyncTypedUpdateOperationPayload,
  SyncTypedUpdateSemanticError,
  validateSyncTypedUpdateOperationPayload,
  type SyncTypedUpdateOperation,
} from '../../src/sync/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = '[evidence:sync.typed-update-keyset]';
const timestamp = '2026-07-18T00:00:00Z';

function operation(payload: unknown, type: SyncTypedUpdateOperation['type'] = 'update_node_content') {
  return {
    opId: 'op-sync-0016',
    replicaId: 'replica-1',
    sequence: 1,
    collectionId: 'collection-1',
    type,
    targetId: 'node-1',
    baseRevision: 'revision-1',
    occurredAt: timestamp,
    payload,
  } as unknown as SyncTypedUpdateOperation;
}

describe('SYNC-0016 typed update base/value key-set equality', () => {
  const registry = createValidatorRegistry();

  it(`${evidence} accepts matching key sets for every typed update resource`, () => {
    const cases = [
      ['update_collection_metadata', { title: 'before' }, { title: 'after' }],
      ['update_node_content', { title: 'before', tags: ['old'] }, { tags: ['new'], title: 'after' }],
      ['update_annotation', { format: 'text/plain', value: 'before' }, { value: 'after', format: 'text/markdown' }],
      ['update_attachment', { title: 'before', mimeType: 'text/plain' }, { mimeType: 'text/markdown', title: 'after' }],
      ['update_relation', { type: 'related', label: 'before' }, { label: 'after', type: 'supports' }],
    ] as const;

    for (const [type, base, value] of cases) {
      expect(validateSyncTypedUpdateOperationPayload(operation({ base, value }, type)).valid).toBe(true);
    }
  });

  it(`${evidence} accepts the empty and one-field key-set boundaries`, () => {
    expect(validateSyncTypedUpdateOperationPayload(operation({ base: {}, value: {} })).valid).toBe(true);
    expect(
      validateSyncTypedUpdateOperationPayload(
        operation({ base: { title: 'before' }, value: { title: 'after' }}),
      ).valid,
    ).toBe(true);
  });

  it.each([
    ['missing value key', { base: { title: 'before', tags: ['old'] }, value: { title: 'after' } }],
    ['extra value key', { base: { title: 'before' }, value: { title: 'after', tags: ['new'] } }],
    ['different key names', { base: { title: 'before' }, value: { label: 'after' } }],
  ])(`${evidence} returns stable invalid_document for %s`, (_label, payload) => {
    const result = validateSyncTypedUpdateOperationPayload(operation(payload));
    expect(result).toMatchObject({ valid: false, status: 422, code: 'invalid_document' });
    expect(() => assertSyncTypedUpdateOperationPayload(operation(payload))).toThrow(
      SyncTypedUpdateSemanticError,
    );
  });

  it(`${evidence} compares own data keys independent of insertion order`, () => {
    const payload = {
      base: { title: 'before', tags: ['old'], visibility: 'private' },
      value: { visibility: 'protected', title: 'after', tags: ['new'] },
    };
    expect(validateSyncTypedUpdateOperationPayload(operation(payload))).toEqual({ valid: true });
  });

  it(`${evidence} rejects JSON Pointer changes at both semantic and canonical boundaries`, () => {
    const candidate = operation({ changes: [{ path: '/title', base: 'before', value: 'after' }] });
    expect(registry.validate('operation', candidate).valid).toBe(false);
    expect(validateSyncTypedUpdateOperationPayload(candidate).valid).toBe(false);
  });

  it.each([
    ['server-managed revision', { base: { revision: 'revision-1' }, value: { revision: 'revision-2' } }],
    ['server-managed updatedAt', { base: { updatedAt: timestamp }, value: { updatedAt: timestamp } }],
    ['server-managed collectionId', { base: { collectionId: 'collection-1' }, value: { collectionId: 'collection-2' } }],
  ])(`${evidence} rejects %s at the canonical schema boundary`, (_label, payload) => {
    const candidate = operation(payload);
    expect(registry.validate('operation', candidate).valid).toBe(false);
    // Matching keys do not authorize an alternate patch language or server-owned field.
    expect(validateSyncTypedUpdateOperationPayload(candidate).valid).toBe(true);
  });

  it(`${evidence} rejects inherited fields instead of treating them as part of the key set`, () => {
    const base = Object.create({ title: 'inherited' }) as Record<string, unknown>;
    base.tags = ['old'];
    const result = validateSyncTypedUpdateOperationPayload(
      operation({ base, value: { tags: ['new'] } }),
    );
    expect(result).toMatchObject({ valid: false, code: 'invalid_document' });
  });
});
