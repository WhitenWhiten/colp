import { describe, expect, it } from 'vitest';

import * as sync from '../../src/sync/index.js';
import { collectionProtocolSchema, createValidatorRegistry } from '../../src/schema/index.js';

const evidence = '[evidence:sync.operation-target-revision]';
const now = '2026-07-18T00:00:00Z';
const opaque = '0000000000000000000000000000000000000000000000000000000000000042';

const payloads: Record<string, Record<string, unknown>> = {
  update_collection_metadata: { base: { title: 'Before' }, value: { title: 'After' } },
  update_node_content: { base: { title: 'Before' }, value: { title: 'After' } },
  update_annotation: { base: { format: 'text/plain', value: 'Before' }, value: { value: 'After' } },
  update_attachment: { base: { title: 'Before', mimeType: 'text/plain' }, value: { title: 'After' } },
  update_relation: { base: { type: 'related' }, value: { type: 'supports' } },
  move_node: { newParentId: 'parent-1', baseSourceParentRevision: 'r-source', baseTargetParentRevision: 'r-target' },
  reorder_children: { parentId: 'parent-1', childIds: ['child-1'], baseChildrenRevision: 'r-children' },
  delete_collection: {}, delete_node: {}, delete_subtree: {}, delete_annotation: {}, delete_attachment: {}, delete_relation: {},
  restore_collection: {}, restore_node: {},
  publish_release: { release: { title: 'Release', notes: '', publishedAt: now } },
  create_collection: { collection: { kind: 'knowledge_collection', title: 'C', summary: '', visibility: 'private', publication: { feedMode: 'release', includeNodeContent: 'summary', includeRelations: true }, extensions: {} }, root: { title: 'Root', folderRole: 'root', extensions: {} } },
  create_node: { parentId: 'root', node: { title: 'N', folderRole: 'none', extensions: {} } },
  create_annotation: { annotation: { format: 'text/plain', value: 'A', extensions: {} } },
  create_attachment: { attachment: { title: 'A', mimeType: 'text/plain', size: 1, digest: 'd', url: 'https://example.com/a', extensions: {} } },
  create_relation: { relation: { type: 'related', fromNodeId: 'a', toNodeId: 'b', extensions: {} } },
};

type ExistingType = keyof typeof payloads;
const existing: ExistingType[] = [
  'update_collection_metadata', 'delete_collection', 'restore_collection',
  'update_node_content', 'move_node', 'reorder_children', 'delete_node', 'delete_subtree', 'restore_node',
  'update_annotation', 'delete_annotation', 'update_attachment', 'delete_attachment', 'update_relation', 'delete_relation',
];
const creates = [] as const;

function operation(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: `op-${type}`, replicaId: 'replica-1', sequence: type === 'create_collection' ? 1 : 2,
    collectionId: 'collection-1', type, occurredAt: now, payload: payloads[type] ?? {},
    targetId: opaque, baseRevision: opaque, ...overrides,
  };
}

describe('SYNC-0015 operation target and revision contract', () => {
  const validators = createValidatorRegistry();

  it.each(existing)(`${evidence} accepts %s with opaque targetId and baseRevision`, (type) => {
    expect(validators.validate('operation', operation(type))).toMatchObject({ valid: true });
  });

  it.each(existing.flatMap((type) => [
    [type, 'targetId'], [type, 'baseRevision'],
  ] as const))(`${evidence} rejects %s when %s is absent`, (type, missing) => {
    const value = operation(type); delete value[missing];
    expect(validators.validate('operation', value).valid).toBe(false);
  });

  it.each(existing.flatMap((type) => [
    [type, null], [type, ''], [type, 7], [type, {}], [type, []],
  ] as const))(`${evidence} rejects %s malformed target/revision value %j`, (type, bad) => {
    expect(validators.validate('operation', operation(type, { targetId: bad, baseRevision: opaque })).valid).toBe(false);
    expect(validators.validate('operation', operation(type, { targetId: opaque, baseRevision: bad })).valid).toBe(false);
  });

  it.each(creates)(`${evidence} accepts %s with null baseRevision and no targetId`, (type) => {
    const value = operation(type, { targetId: undefined, baseRevision: null });
    delete value.targetId;
    if (type === 'create_collection') { value.collectionId = null; value.sequence = 1; }
    expect(validators.validate('operation', value).valid).toBe(true);
  });

  it.each(creates)(`${evidence} rejects %s with targetId`, (type) => {
    const value = operation(type, { baseRevision: null });
    expect(validators.validate('operation', value).valid).toBe(false);
  });

  it.each(creates)(`${evidence} rejects %s with opaque baseRevision`, (type) => {
    const value = operation(type, { targetId: undefined, baseRevision: opaque }); delete value.targetId;
    if (type === 'create_collection') { value.collectionId = null; value.sequence = 1; }
    expect(validators.validate('operation', value).valid).toBe(false);
  });

  it(`${evidence} does not infer targetId or baseRevision from payload or collectionId`, () => {
    const value = operation('delete_node', { targetId: undefined, baseRevision: undefined, payload: { targetId: opaque, baseRevision: opaque } });
    delete value.targetId; delete value.baseRevision;
    expect(validators.validate('operation', value).valid).toBe(false);
  });

  it(`${evidence} preserves long decimal-looking opaque identifiers`, () => {
    const value = operation('delete_node', { targetId: opaque, baseRevision: '999999999999999999999999999999999999999999999999' });
    expect(validators.validate('operation', value).valid).toBe(true);
    expect(value.targetId).toBe(opaque);
  });

  it(`${evidence} schema exposes operation target and revision constraints`, () => {
    const operationSchema = collectionProtocolSchema.$defs.operation as Record<string, unknown>;
    expect(operationSchema).toHaveProperty('allOf');
    expect(JSON.stringify(operationSchema)).toContain('targetId');
    expect(JSON.stringify(operationSchema)).toContain('baseRevision');
  });

  it(`${evidence} rejects accessor-backed typed payload at Sync runtime`, () => {
    const value = operation('update_node_content', { payload: { base: {}, value: {} } });
    Object.defineProperty(value, 'payload', { enumerable: true, get: () => ({ base: {}, value: {} }) });
    expect(sync.validateSyncTypedUpdateOperationPayload(value as never).valid).toBe(false);
  });

  it(`${evidence} rejects symbol and unknown members at Sync runtime`, () => {
    const value = operation('update_node_content', { payload: { base: {}, value: {} } });
    Object.defineProperty(value, Symbol('unknown'), { enumerable: true, value: true });
    expect(validators.validate('operation', value).valid).toBe(false);
  });
});
