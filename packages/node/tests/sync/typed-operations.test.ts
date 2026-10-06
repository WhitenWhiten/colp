import { describe, expect, it } from 'vitest';

import {
  SyncTypedUpdateSemanticError,
  assertSyncTypedUpdateOperationPayload,
  validateSyncTypedUpdateOperationPayload,
  type SyncTypedUpdateOperation,
} from '../../src/sync/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import type {
  AnnotationUpdateOperationPayload,
  AttachmentUpdateOperationPayload,
  CollectionMetadataUpdateOperationPayload,
  NodeContentUpdateOperationPayload,
  RelationUpdateOperationPayload,
  StrictOperation,
} from '../../src/types/index.js';

const timestamp = '2026-07-18T00:00:00Z';

const collectionPayload = {
  base: { title: 'Before', tags: ['old'] },
  value: { title: 'After', tags: ['new'] },
} satisfies CollectionMetadataUpdateOperationPayload;

const nodePayload = {
  base: { title: 'Before', visibility: 'private' },
  value: { title: 'After', visibility: 'protected' },
} satisfies NodeContentUpdateOperationPayload;

const annotationPayload = {
  base: { format: 'text/plain', value: 'Before' },
  value: { value: 'After', format: 'text/markdown' },
} satisfies AnnotationUpdateOperationPayload;

const attachmentPayload = {
  base: { title: 'Before', mimeType: 'text/plain' },
  value: { mimeType: 'text/markdown', title: 'After' },
} satisfies AttachmentUpdateOperationPayload;

const relationPayload = {
  base: { type: 'related', label: 'Before' },
  value: { label: 'After', type: 'supports' },
} satisfies RelationUpdateOperationPayload;

const typedOperations = [
  {
    opId: 'op-collection',
    replicaId: 'replica-1',
    sequence: 1,
    collectionId: 'collection-1',
    type: 'update_collection_metadata',
    targetId: 'collection-1',
    baseRevision: 'revision-1',
    occurredAt: timestamp,
    payload: collectionPayload,
  },
  {
    opId: 'op-node',
    replicaId: 'replica-1',
    sequence: 2,
    collectionId: 'collection-1',
    type: 'update_node_content',
    targetId: 'node-1',
    baseRevision: 'revision-1',
    occurredAt: timestamp,
    payload: nodePayload,
  },
  {
    opId: 'op-annotation',
    replicaId: 'replica-1',
    sequence: 3,
    collectionId: 'collection-1',
    type: 'update_annotation',
    targetId: 'annotation-1',
    baseRevision: 'revision-1',
    occurredAt: timestamp,
    payload: annotationPayload,
  },
  {
    opId: 'op-attachment',
    replicaId: 'replica-1',
    sequence: 4,
    collectionId: 'collection-1',
    type: 'update_attachment',
    targetId: 'attachment-1',
    baseRevision: 'revision-1',
    occurredAt: timestamp,
    payload: attachmentPayload,
  },
  {
    opId: 'op-relation',
    replicaId: 'replica-1',
    sequence: 5,
    collectionId: 'collection-1',
    type: 'update_relation',
    targetId: 'relation-1',
    baseRevision: 'revision-1',
    occurredAt: timestamp,
    payload: relationPayload,
  },
] as const satisfies (
  readonly SyncTypedUpdateOperation[] & readonly StrictOperation[]
);

const invalidAnnotationFieldMapping = {
  base: {
    // @ts-expect-error tags belongs to Node/Collection writes, not Annotation writes
    tags: ['cross-resource'],
  },
  value: {},
} satisfies AnnotationUpdateOperationPayload;
void invalidAnnotationFieldMapping;

type TypedOperationType = SyncTypedUpdateOperation['type'];

const wireCases = typedOperations.map((operation) => ({
  label: operation.type,
  operation,
}));

function operationFor(
  type: TypedOperationType,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    opId: `op-${type}`,
    replicaId: 'replica-1',
    sequence: 7,
    collectionId: 'collection-1',
    type,
    targetId: 'target-1',
    baseRevision: 'revision-1',
    occurredAt: timestamp,
    payload,
  };
}

function semanticOperation(payload: unknown): SyncTypedUpdateOperation {
  return operationFor(
    'update_node_content',
    payload as Readonly<Record<string, unknown>>,
  ) as unknown as SyncTypedUpdateOperation;
}

describe('SYNC-0003 typed update operations', () => {
  const validators = createValidatorRegistry();

  it.each(wireCases)(
    '[evidence:sync.typed-operations] accepts $label with targetId, baseRevision, and matching typed fields',
    ({ operation }) => {
      expect(validators.validate('operation', operation)).toEqual({ valid: true, errors: [] });
      expect(validateSyncTypedUpdateOperationPayload(operation)).toEqual({ valid: true });
      expect(() => assertSyncTypedUpdateOperationPayload(operation)).not.toThrow();
    },
  );

  it.each([
    {
      label: 'collection cannot use Annotation format',
      operation: operationFor('update_collection_metadata', {
        base: { format: 'text/plain' },
        value: { format: 'text/markdown' },
      }),
    },
    {
      label: 'node cannot use Attachment rel',
      operation: operationFor('update_node_content', {
        base: { rel: 'preview' },
        value: { rel: 'alternate' },
      }),
    },
    {
      label: 'annotation cannot use Node tags',
      operation: operationFor('update_annotation', {
        base: { tags: ['old'] },
        value: { tags: ['new'] },
      }),
    },
    {
      label: 'attachment cannot use Relation type',
      operation: operationFor('update_attachment', {
        base: { type: 'related' },
        value: { type: 'supports' },
      }),
    },
    {
      label: 'relation cannot use Attachment url',
      operation: operationFor('update_relation', {
        base: { url: 'https://example.com/before' },
        value: { url: 'https://example.com/after' },
      }),
    },
  ])(
    '[evidence:sync.typed-operations] canonical wire validator rejects cross-resource field: $label',
    ({ operation }) => {
      expect(validators.validate('operation', operation).valid).toBe(false);
    },
  );

  it.each([
    {
      label: 'JSON Pointer changes',
      payload: { changes: [{ path: '/title', base: 'Before', value: 'After' }] },
    },
    {
      label: 'server-managed revision',
      payload: { base: { revision: 'r-1' }, value: { revision: 'r-2' } },
    },
    {
      label: 'server-managed updatedAt',
      payload: { base: { updatedAt: timestamp }, value: { updatedAt: timestamp } },
    },
    {
      label: 'server-managed collectionId',
      payload: {
        base: { collectionId: 'collection-1' },
        value: { collectionId: 'collection-2' },
      },
    },
    {
      label: 'move-only parentId',
      payload: { base: { parentId: 'folder-1' }, value: { parentId: 'folder-2' } },
    },
    {
      label: 'move-only position',
      payload: { base: { position: 'a' }, value: { position: 'b' } },
    },
    {
      label: 'move-only newParentId',
      payload: {
        base: { newParentId: 'folder-1' },
        value: { newParentId: 'folder-2' },
      },
    },
    {
      label: 'reorder-only childIds',
      payload: { base: { childIds: ['node-1'] }, value: { childIds: ['node-2'] } },
    },
  ])(
    '[evidence:sync.typed-operations] canonical wire validator rejects $label',
    ({ payload }) => {
      expect(
        validators.validate('operation', operationFor('update_node_content', payload)).valid,
      ).toBe(false);
    },
  );

  it.each([
    { label: 'targetId', missing: 'targetId' },
    { label: 'baseRevision', missing: 'baseRevision' },
  ] as const)(
    '[evidence:sync.typed-operations] canonical wire validator rejects missing $label',
    ({ missing }) => {
      const operation = operationFor('update_node_content', nodePayload);
      delete operation[missing];
      expect(validators.validate('operation', operation).valid).toBe(false);
    },
  );

  it('[evidence:sync.typed-operations] reports stable 422 invalid_document for unequal base/value keys', () => {
    const operation = semanticOperation({
      base: { title: 'Before', tags: ['old'] },
      value: { title: 'After' },
    });

    expect(validators.validate('operation', operation)).toEqual({ valid: true, errors: [] });
    const result = validateSyncTypedUpdateOperationPayload(operation);
    expect(result).toMatchObject({ valid: false, status: 422, code: 'invalid_document' });
    expect(Object.isFrozen(result)).toBe(true);

    let thrown: unknown;
    try {
      assertSyncTypedUpdateOperationPayload(operation);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SyncTypedUpdateSemanticError);
    expect(thrown).toMatchObject({ status: 422, code: 'invalid_document' });
  });

  it.each([
    {
      label: 'single-field sets',
      payload: { base: { title: 'Before' }, value: { title: 'After' } },
    },
    {
      label: 'multi-field sets in different insertion order',
      payload: {
        base: { title: 'Before', tags: ['old'], visibility: 'private' },
        value: { visibility: 'protected', title: 'After', tags: ['new'] },
      },
    },
  ])(
    '[evidence:sync.typed-operations] post-wire semantics accept $label',
    ({ payload }) => {
      const operation = semanticOperation(payload);
      expect(validators.validate('operation', operation)).toEqual({ valid: true, errors: [] });
      expect(validateSyncTypedUpdateOperationPayload(operation)).toEqual({
        valid: true,
      });
    },
  );

  it('[evidence:sync.typed-operations] rejects custom prototypes and inherited fields', () => {
    const inherited = { title: 'Inherited' };
    const base = Object.create(inherited) as Record<string, unknown>;
    base.tags = ['old'];

    expect(
      validateSyncTypedUpdateOperationPayload(
        semanticOperation({ base, value: { tags: ['new'] } }),
      ).valid,
    ).toBe(false);
  });

  it('[evidence:sync.typed-operations] accepts matching null-prototype data objects', () => {
    const base = Object.assign(Object.create(null) as Record<string, unknown>, {
      title: 'Before',
    });
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      title: 'After',
    });

    expect(
      validateSyncTypedUpdateOperationPayload(semanticOperation({ base, value })),
    ).toEqual({ valid: true });
  });

  it('[evidence:sync.typed-operations] rejects accessors without triggering getters', () => {
    let calls = 0;
    const base = {};
    Object.defineProperty(base, 'title', {
      enumerable: true,
      get() {
        calls += 1;
        return 'Before';
      },
    });

    expect(
      validateSyncTypedUpdateOperationPayload(
        semanticOperation({ base, value: { title: 'After' } }),
      ).valid,
    ).toBe(false);
    expect(calls).toBe(0);

    const operation = operationFor('update_node_content', nodePayload);
    Object.defineProperty(operation, 'payload', {
      enumerable: true,
      get() {
        calls += 1;
        return nodePayload;
      },
    });
    expect(
      validateSyncTypedUpdateOperationPayload(operation as unknown as SyncTypedUpdateOperation)
        .valid,
    ).toBe(false);
    expect(calls).toBe(0);
  });

  it('[evidence:sync.typed-operations] rejects non-enumerable typed fields', () => {
    const base = { title: 'Before' };
    Object.defineProperty(base, 'hidden', { enumerable: false, value: 'secret' });
    const value = { title: 'After' };
    Object.defineProperty(value, 'hidden', { enumerable: false, value: 'secret' });

    expect(
      validateSyncTypedUpdateOperationPayload(semanticOperation({ base, value })).valid,
    ).toBe(false);
  });

  it('[evidence:sync.typed-operations] rejects symbol-keyed typed fields', () => {
    const privateField = Symbol('private');
    const base = { title: 'Before', [privateField]: 'old' };
    const value = { title: 'After', [privateField]: 'new' };

    expect(
      validateSyncTypedUpdateOperationPayload(semanticOperation({ base, value })).valid,
    ).toBe(false);
  });

  it('[evidence:sync.typed-operations] leaves operation and payload inputs unchanged', () => {
    const base = Object.freeze({ title: 'Before', tags: Object.freeze(['old']) });
    const value = Object.freeze({ tags: Object.freeze(['new']), title: 'After' });
    const payload = Object.freeze({ base, value });
    const operation = Object.freeze(
      operationFor('update_node_content', payload) as unknown as SyncTypedUpdateOperation,
    );
    const before = {
      operation: Object.getOwnPropertyDescriptors(operation),
      payload: Object.getOwnPropertyDescriptors(payload),
      base: Object.getOwnPropertyDescriptors(base),
      value: Object.getOwnPropertyDescriptors(value),
    };

    expect(validateSyncTypedUpdateOperationPayload(operation)).toEqual({ valid: true });
    expect(Object.getOwnPropertyDescriptors(operation)).toEqual(before.operation);
    expect(Object.getOwnPropertyDescriptors(payload)).toEqual(before.payload);
    expect(Object.getOwnPropertyDescriptors(base)).toEqual(before.base);
    expect(Object.getOwnPropertyDescriptors(value)).toEqual(before.value);
  });

});
