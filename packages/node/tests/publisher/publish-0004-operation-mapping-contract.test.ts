import { describe, expect, it } from 'vitest';

import {
  mapPublisherSidecarOperation,
  type PublisherSidecarPayload,
} from '../../src/publisher/operation-mapping.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import type { Operation } from '../../src/types/index.js';

const evidence = 'publisher.operation-mapping';
const validators = createValidatorRegistry();

type Sidecar = 'annotation' | 'attachment' | 'relation';
type Action = 'create' | 'update' | 'delete';

const envelope = {
  operationId: 'op-publish-0004-001',
  replicaId: 'publisher-server',
  sequence: 73,
  collectionId: 'collection-a',
  occurredAt: '2026-07-19T08:00:00Z',
} as const;

const creates = {
  annotation: { format: 'plain', type: 'note', value: 'note', subject: { type: 'node', id: 'node-a' }, visibility: 'private', extensions: {} },
  attachment: { subject: { type: 'node', id: 'node-a' }, rel: 'enclosure', title: 'file.txt', mimeType: 'text/plain', size: 4, digest: 'sha-256:abc', url: 'https://example.test/file.txt', visibility: 'private', extensions: {} },
  relation: { type: 'supports', fromNodeId: 'node-a', toNodeId: 'node-b', visibility: 'private', extensions: {} },
} as const;

const payloads: Record<Sidecar, Record<Action, PublisherSidecarPayload>> = {
  annotation: {
    create: { annotation: creates.annotation },
    update: { base: { format: 'plain', value: 'before' }, value: { format: 'markdown', value: 'after' } },
    delete: { reason: 'publisher-delete' },
  },
  attachment: {
    create: { attachment: creates.attachment } as PublisherSidecarPayload,
    update: { base: { title: 'before.txt', mimeType: 'text/plain' }, value: { title: 'after.md', mimeType: 'text/markdown' } },
    delete: { reason: 'publisher-delete' },
  },
  relation: {
    create: { relation: creates.relation },
    update: { base: { type: 'related', label: 'before' }, value: { type: 'supports', label: 'after' } },
    delete: { reason: 'publisher-delete' },
  },
};

const expectedTypes: Record<Sidecar, Record<Action, Operation['type']>> = {
  annotation: { create: 'create_annotation', update: 'update_annotation', delete: 'delete_annotation' },
  attachment: { create: 'create_attachment', update: 'update_attachment', delete: 'delete_attachment' },
  relation: { create: 'create_relation', update: 'update_relation', delete: 'delete_relation' },
};

describe(`PUBLISH-0004 sidecar CRUD operation mapping [evidence:${evidence}]`, () => {
  it.each<readonly [Sidecar, Action]>([
    ['annotation', 'create'], ['annotation', 'update'], ['annotation', 'delete'],
    ['attachment', 'create'], ['attachment', 'update'], ['attachment', 'delete'],
    ['relation', 'create'], ['relation', 'update'], ['relation', 'delete'],
  ])('maps %s %s to its canonical Operation type with complete identity and payload [evidence:publisher.operation-mapping]', (sidecar, action) => {
    const targetId = action === 'create' ? undefined : `${sidecar}-a`;
    const baseRevision = action === 'create' ? null : `${sidecar}-revision-7`;
    const payload = payloads[sidecar][action];
    const operation = mapPublisherSidecarOperation({
      ...envelope,
      operationId: `${envelope.operationId}-${sidecar}-${action}`,
      sidecar,
      action,
      targetId,
      baseRevision,
      payload,
    });

    expect(operation).toMatchObject({
      opId: `${envelope.operationId}-${sidecar}-${action}`,
      replicaId: envelope.replicaId,
      sequence: envelope.sequence,
      collectionId: envelope.collectionId,
      occurredAt: envelope.occurredAt,
      type: expectedTypes[sidecar][action],
    });
    if (action === 'create') {
      expect(operation).not.toHaveProperty('targetId');
      expect(operation).toHaveProperty('baseRevision', null);
    } else {
      expect(operation).toHaveProperty('targetId', targetId);
      expect(operation).toHaveProperty('baseRevision', baseRevision);
    }
    expect(operation.payload).toEqual(payload);
    expect(validators.validate('operation', operation)).toEqual({ valid: true, errors: [] });
    expect(Object.keys(operation)).toEqual(expect.arrayContaining(['opId', 'replicaId', 'sequence', 'collectionId', 'type', 'occurredAt', 'baseRevision', 'payload']));
  });

  it(`preserves collection identity and operation IDs across sidecar writes [evidence:${evidence}]`, () => {
    const first = mapPublisherSidecarOperation({ ...envelope, operationId: 'op-a', baseRevision: null, sidecar: 'annotation', action: 'create', payload: payloads.annotation.create });
    const second = mapPublisherSidecarOperation({ ...envelope, operationId: 'op-b', collectionId: 'collection-b', baseRevision: null, sidecar: 'annotation', action: 'create', payload: payloads.annotation.create });
    expect(first.opId).not.toBe(second.opId);
    expect(first.collectionId).toBe('collection-a');
    expect(second.collectionId).toBe('collection-b');
    expect(first.payload).toEqual(second.payload);
  });

  it(`rejects illegal targets and unknown sidecar/action values fail closed [evidence:${evidence}]`, () => {
    const update = { ...envelope, sidecar: 'annotation', action: 'update', baseRevision: 'revision-a', payload: payloads.annotation.update } as const;
    expect(() => mapPublisherSidecarOperation({ ...update, targetId: undefined } as never)).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...update, targetId: '' })).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...update, targetId: 'annotation-a', baseRevision: null } as never)).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...envelope, targetId: 'annotation-a', baseRevision: null, sidecar: 'annotation', action: 'create', payload: payloads.annotation.create })).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...envelope, baseRevision: 'revision-a', sidecar: 'annotation', action: 'create', payload: payloads.annotation.create } as never)).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...envelope, baseRevision: null, sidecar: 'unknown', action: 'create', payload: {} } as never)).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...envelope, baseRevision: null, sidecar: 'relation', action: 'publish', payload: {} } as never)).toThrow();
  });

  it(`rejects envelopes that cannot be canonical Operations [evidence:${evidence}]`, () => {
    const create = { ...envelope, baseRevision: null, sidecar: 'annotation', action: 'create', payload: payloads.annotation.create } as const;
    expect(() => mapPublisherSidecarOperation({ ...create, operationId: 'bad id' })).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...create, replicaId: '' })).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...create, collectionId: 'collection/a' })).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...create, sequence: 0 })).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...create, occurredAt: '2026-07-19' })).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...create, dependencies: ['op-a', 'op-a'] })).toThrow();
    expect(() => mapPublisherSidecarOperation({ ...create, source: { unknown: true } as never })).toThrow();
  });

  it(`rejects payloads outside the resource DTO and reuses Sync typed-update semantics [evidence:${evidence}]`, () => {
    expect(() => mapPublisherSidecarOperation({
      ...envelope,
      baseRevision: null,
      sidecar: 'annotation',
      action: 'create',
      payload: { annotation: { ...creates.annotation, format: 'text/plain' } } as never,
    })).toThrow(/invalid canonical Operation/u);
    expect(() => mapPublisherSidecarOperation({
      ...envelope,
      targetId: 'attachment-a',
      baseRevision: 'revision-a',
      sidecar: 'attachment',
      action: 'update',
      payload: { base: { title: 'before.txt' }, value: { title: 'after.txt', collectionId: 'collection-b' } } as never,
    })).toThrow();
    expect(() => mapPublisherSidecarOperation({
      ...envelope,
      targetId: 'relation-a',
      baseRevision: 'revision-a',
      sidecar: 'relation',
      action: 'update',
      payload: { base: { label: 'before' }, value: { type: 'supports' } },
    })).toThrow(/identical own enumerable/u);
    expect(() => mapPublisherSidecarOperation({
      ...envelope,
      targetId: 'annotation-a',
      baseRevision: 'revision-a',
      sidecar: 'annotation',
      action: 'delete',
      payload: { reason: 'delete', extra: true } as never,
    })).toThrow();
  });
});
