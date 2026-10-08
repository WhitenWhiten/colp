/**
 * MCP owned-collection create catalog rejects name the failed field and
 * point the next retry at collections.create, not nodes.create.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { COLLECTION_KINDS } from '../../../src/modules/collections/index.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
  classifyPhase4bMcpWriteError,
  createPhase4bMcpOwnedCollectionCreateService,
  toPhase4bMcpWriteRequestError,
  writeErrorHintFrom,
} from '../../../src/modules/mcp/index.js';
import { CONTEXT } from '../../support/phase4b-mcp-low-risk-node-create-fixture.js';

const service = createPhase4bMcpOwnedCollectionCreateService({
  unitOfWork: {
    async execute() {
      throw new Error('collections.create must not persist after a catalog reject');
    },
  },
});

async function rejectCreate(
  input: Readonly<Record<string, unknown>>,
): Promise<Phase4bMcpLowRiskNodeCreateError> {
  try {
    await service.execute(input, CONTEXT);
  } catch (error) {
    assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
    return error;
  }
  throw new Error('expected collections.create to reject');
}

test('collections.create catalog rejects name the field and retry collections.create', async () => {
  const rows = Object.freeze([
    Object.freeze({ name: 'missing intent key', input: Object.freeze({ title: 'Library' }), field: 'idempotencyKey' }),
    Object.freeze({ name: 'malformed intent key', input: Object.freeze({ title: 'Library', idempotencyKey: 'invalid' }), field: 'idempotencyKey' }),
    Object.freeze({
      name: 'empty title',
      input: Object.freeze({ title: '' }),
      field: 'title',
    }),
    Object.freeze({
      name: 'missing title',
      input: Object.freeze({}),
      field: 'title',
    }),
    Object.freeze({
      name: 'summary not a string',
      input: Object.freeze({ title: '库', summary: 1 }),
      field: 'summary',
    }),
    Object.freeze({
      name: 'unknown kind',
      input: Object.freeze({ title: '库', kind: 'folder' }),
      field: 'kind',
    }),
  ]);
  for (const row of rows) {
    const error = await rejectCreate(row.input);
    assert.equal(error.code, 'invalid_catalog_input', row.name);
    assert.equal(error.field, row.field, row.name);
    assert.equal(error.nextTool, 'collections.create', row.name);
    const wire = toPhase4bMcpWriteRequestError(
      classifyPhase4bMcpWriteError(error),
      writeErrorHintFrom(error),
    );
    assert.deepEqual(wire.data, {
      code: 'invalid_params',
      field: row.field,
      allowedKinds: COLLECTION_KINDS,
      allowedVisibilities: Object.freeze(['private']),
      nextTool: 'collections.create',
    }, row.name);
    assert.notEqual(
      (wire.data as { nextTool?: string }).nextTool,
      'nodes.create',
      row.name,
    );
  }
});

test('collections.create returns canonical revision fences from bootstrap', async () => {
  const createdAt = '2026-08-29T08:00:00Z';
  const service = createPhase4bMcpOwnedCollectionCreateService({
    unitOfWork: {
      async execute() {
        return {
          kind: 'created' as const,
          collection: {
            id: 'col-created',
            kind: 'bookmarks' as const,
            title: '测试收藏夹',
            summary: null,
            visibility: 'private' as const,
            allowSearchIndexing: false as const,
            rootNodeId: 'root-created',
            revision: 'res-1',
            etag: '"res-1"',
            contentRevision: 'cnt-1',
            contentEtag: '"cnt-1"',
            policyRevision: 'pol-1',
            policyEtag: '"pol-1"',
            createdAt,
            updatedAt: createdAt,
          },
          root: {
            id: 'root-created',
            collectionId: 'col-created',
            kind: 'folder' as const,
            folderRole: 'root' as const,
            parentId: null,
            position: null,
            title: '测试收藏夹',
            description: null,
            tags: Object.freeze([]) as readonly [],
            visibility: 'inherit' as const,
            revision: 'root-res-1',
            etag: '"root-res-1"',
            readOnly: true as const,
            readOnlyReason: 'root_immutable' as const,
            childrenRevision: 'ch-1',
            childrenEtag: '"ch-1"',
            createdAt,
            updatedAt: createdAt,
          },
          operationId: 'op-1',
          commitOrdinal: 1n,
        };
      },
    },
  });
  const output = await service.execute(Object.freeze({ title: '测试收藏夹', idempotencyKey: crypto.randomUUID() }), CONTEXT);
  assert.deepEqual(output, {
    collectionId: 'col-created',
    rootNodeId: 'root-created',
    title: '测试收藏夹',
    visibility: 'private',
    revision: 'res-1',
    contentRevision: 'cnt-1',
    policyRevision: 'pol-1',
    rootRevision: 'root-res-1',
    childrenRevision: 'ch-1',
  });
});

test('collections.create replay preserves canonical revision fences', async () => {
  const body = new TextEncoder().encode(JSON.stringify({
    collection: {
      id: 'col-replay',
      rootNodeId: 'root-replay',
      title: 'Replay',
      revision: 'res-2',
      contentRevision: 'cnt-2',
      policyRevision: 'pol-2',
    },
    root: {
      revision: 'root-res-2',
      childrenRevision: 'ch-2',
    },
  }));
  const service = createPhase4bMcpOwnedCollectionCreateService({
    unitOfWork: {
      async execute() {
        return {
          kind: 'replay' as const,
          status: 201,
          body,
          stableHeaders: Object.freeze({}),
          mediaType: 'application/json',
          contractVersion: 'create-owned-collection/v1',
        };
      },
    },
  });
  const output = await service.execute(Object.freeze({ title: 'Replay', idempotencyKey: crypto.randomUUID() }), CONTEXT);
  assert.deepEqual(output, {
    collectionId: 'col-replay',
    rootNodeId: 'root-replay',
    title: 'Replay',
    visibility: 'private',
    revision: 'res-2',
    contentRevision: 'cnt-2',
    policyRevision: 'pol-2',
    rootRevision: 'root-res-2',
    childrenRevision: 'ch-2',
  });
});
