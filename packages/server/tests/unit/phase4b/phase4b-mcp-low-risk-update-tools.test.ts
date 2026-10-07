/**
 * T1.2 low-risk `nodes.update` / `collections.update`: closed schema, dryRun
 * never writes, omit dryRun applies with ifMatch === baseRevision, stale and
 * conceal stay leak-safe through the existing write-error classifier.
 */
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createMcpToolInputValidator, McpToolInputError } from '../../support/mcp-tool-schema-validator.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  type LockedCollectionRow,
  type LockedNodeRow,
  type ProductCollectionCanonicalPorts,
  type ProductCollectionMutationUnitOfWork,
} from '../../../src/modules/collections/index.js';
import * as updateNodeModule from '../../../src/modules/collections/application/update-collection-node.js';
import * as updateMetadataModule from '../../../src/modules/collections/application/update-collection-metadata.js';
import {
  PHASE4B_MCP_COLLECTIONS_UPDATE_INPUT_SCHEMA,
  PHASE4B_MCP_NODES_UPDATE_INPUT_SCHEMA,
  PHASE4B_MCP_STALE_REVISION_MESSAGE,
  Phase4bMcpLowRiskNodeCreateError,
  classifyPhase4bMcpWriteError,
  createPhase4bMcpLowRiskCollectionUpdateService,
  createPhase4bMcpLowRiskNodeUpdateService,
  toPhase4bMcpWriteRequestError,
  writeErrorHintFrom,
  type Phase4bMcpLowRiskNodeCreateInspect,
  type Phase4bMcpLowRiskNodeCreateInspectPorts,
} from '../../../src/modules/mcp/index.js';
import {
  BINDING,
  CONTEXT,
} from '../../support/phase4b-mcp-low-risk-node-create-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const COL_ID = 'collection-1';
const NODE_ID = 'node-1';
const BASE_REVISION = 'rev-base-1';
const LEAK_ETAG = '"rev-LEAK-999"';
const NOW = new Date('2026-08-29T00:00:00.000Z');

const nodeUpdateInputValidator = createMcpToolInputValidator(PHASE4B_MCP_NODES_UPDATE_INPUT_SCHEMA);
const collectionUpdateInputValidator = createMcpToolInputValidator(
  PHASE4B_MCP_COLLECTIONS_UPDATE_INPUT_SCHEMA,
);

function nodeApplyInput(
  patch: Readonly<Record<string, unknown>> = Object.freeze({ title: 'Updated title' }),
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    collectionId: COL_ID,
    nodeId: NODE_ID,
    baseRevision: BASE_REVISION,
    patch,
    ...extra,
  });
}

function collectionApplyInput(
  patch: Readonly<Record<string, unknown>> = Object.freeze({ title: 'Updated library' }),
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    collectionId: COL_ID,
    baseRevision: BASE_REVISION,
    patch,
    ...extra,
  });
}

function collectionRow(overrides: Partial<LockedCollectionRow> = {}): LockedCollectionRow {
  return {
    id: COL_ID,
    ownerSubjectId: BINDING.principalId,
    title: 'Library',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: 'root-1',
    resourceRevision: BASE_REVISION,
    contentRevision: 'content-1',
    policyRevision: 'policy-1',
    commitOrdinal: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function nodeRow(overrides: Partial<LockedNodeRow> = {}): LockedNodeRow {
  return {
    id: NODE_ID,
    collectionId: COL_ID,
    parentId: 'root-1',
    kind: 'folder',
    isRoot: false,
    title: 'Folder',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: 'A',
    resourceRevision: BASE_REVISION,
    childrenRevision: 'children-1',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function unusedPort(name: string) {
  return async () => {
    throw new Error(`${name} is unused by the T1.2 unit-test UoW fake`);
  };
}

function fakePorts(options: {
  readonly collection?: LockedCollectionRow | null;
  readonly node?: LockedNodeRow | null;
  readonly nextRevision?: string;
} = {}): ProductCollectionCanonicalPorts {
  const collection = options.collection === undefined ? collectionRow() : options.collection;
  const node = options.node === undefined ? nodeRow() : options.node;
  const nextRevision = options.nextRevision ?? 'rev-next-2';
  return {
    receipts: {
      claim: async () => Object.freeze({ kind: 'claimed' as const }),
      complete: async () => undefined,
    },
    clock: {
      now: async () => NOW,
    },
    collections: {
      lockForUpdate: async () => collection,
    },
    nodes: {
      getNode: async () => node,
      listLiveSiblingPositions: unusedPort('nodes.listLiveSiblingPositions'),
    },
    accessPolicy: {
      loadCollectionFacts: async () => (collection === null ? null : Object.freeze({
        collectionId: COL_ID,
        ownerSubjectId: BINDING.principalId,
        visibility: 'private' as const,
        policyRevision: 'policy-1',
        membershipRole: 'owner' as const,
        deleted: false,
      })),
    },
    canonical: {
      execute: async (input) => Object.freeze({
        operationId: input.operationId,
        collectionId: input.collectionId,
        resourceId: input.mutation.target.resourceId,
        action: 'update' as const,
        allocation: Object.freeze({
          commitOrdinal: 2n,
          resourceRevision: nextRevision,
          contentRevision: 'content-2',
          policyRevision: 'policy-1',
          childrenRevisions: Object.freeze({}),
        }),
      }),
      bootstrapOwnedCollection: unusedPort('canonical.bootstrapOwnedCollection'),
    },
  };
}

function inspectFrom(ports: ProductCollectionCanonicalPorts): Phase4bMcpLowRiskNodeCreateInspect {
  return Object.freeze({
    execute: <Result>(
      work: (inspectPorts: Phase4bMcpLowRiskNodeCreateInspectPorts) => Promise<Result>,
    ) => work(Object.freeze({
      getCollection: (collectionId: string) => ports.collections.lockForUpdate(collectionId),
      getNode: (collectionId: string, nodeId: string) => ports.nodes.getNode(collectionId, nodeId),
      accessPolicy: ports.accessPolicy,
    })),
  });
}

function capturingUnitOfWork(
  ports: ProductCollectionCanonicalPorts,
  probe: { uowCalls: number },
): ProductCollectionMutationUnitOfWork {
  return Object.freeze({
    execute: async (work) => {
      probe.uowCalls += 1;
      return work(ports);
    },
  });
}

function throwingUnitOfWork(error: unknown, probe: { uowCalls: number }): ProductCollectionMutationUnitOfWork {
  return Object.freeze({
    execute: async () => {
      probe.uowCalls += 1;
      throw error;
    },
  });
}

test('nodes.update schema rejects extra properties, empty patch, and every visibility change', () => {
  const valid = nodeApplyInput();
  assert.doesNotThrow(() => nodeUpdateInputValidator(valid));
  assert.throws(
    () => nodeUpdateInputValidator({ ...valid, extra: true }),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => nodeUpdateInputValidator(nodeApplyInput(Object.freeze({}))),
    (error: unknown) => error instanceof McpToolInputError,
  );
  for (const visibility of ['inherit', 'protected', 'private', 'public', 'unlisted', null]) {
    assert.throws(
      () => nodeUpdateInputValidator(nodeApplyInput(Object.freeze({ visibility }))),
      (error: unknown) => error instanceof McpToolInputError,
    );
  }
});

test('nodes.update service rejects extra properties, empty patch, and every visibility change', async () => {
  const probe = { uowCalls: 0 };
  const service = createPhase4bMcpLowRiskNodeUpdateService({
    unitOfWork: capturingUnitOfWork(fakePorts(), probe),
  });
  await assert.rejects(
    service.execute({ ...nodeApplyInput(), extra: true }, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'invalid_catalog_input');
      return true;
    },
  );
  await assert.rejects(
    service.execute(nodeApplyInput(Object.freeze({})), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'invalid_catalog_input');
      return true;
    },
  );
  for (const visibility of ['inherit', 'protected', 'private', 'public', 'unlisted', null]) {
    await assert.rejects(
      service.execute(nodeApplyInput(Object.freeze({ visibility })), CONTEXT),
      (error: unknown) => {
        assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
        assert.equal(error.code, 'invalid_catalog_input');
        assert.equal(error.field, 'patch.visibility');
        return true;
      },
    );
  }
  assert.equal(probe.uowCalls, 0);
});

test('nodes.update dryRun true does not call the mutator or unit of work', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(updateNodeModule, 'updateCollectionNode');
  const ports = fakePorts();
  const service = createPhase4bMcpLowRiskNodeUpdateService({
    unitOfWork: capturingUnitOfWork(ports, probe),
    inspect: inspectFrom(ports),
  });
  const output = await service.execute(nodeApplyInput(undefined, { dryRun: true }), CONTEXT);
  assert.deepEqual(output, {
    resultType: 'preview',
    nodeId: NODE_ID,
    collectionId: COL_ID,
  });
  assert.equal(probe.uowCalls, 0);
  assert.equal(spy.mock.calls.length, 0);
});

test('nodes.update omit dryRun calls updateCollectionNode with ifMatch === baseRevision', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(updateNodeModule, 'updateCollectionNode');
  const service = createPhase4bMcpLowRiskNodeUpdateService({
    unitOfWork: capturingUnitOfWork(fakePorts({ nextRevision: 'rev-applied' }), probe),
  });
  const output = await service.execute(nodeApplyInput(), CONTEXT);
  assert.equal(output.resultType, 'complete');
  if (output.resultType !== 'complete') return;
  assert.equal(output.nodeId, NODE_ID);
  assert.equal(output.collectionId, COL_ID);
  assert.equal(output.revision, 'rev-applied');
  assert.equal(probe.uowCalls, 1);
  assert.equal(spy.mock.calls.length, 1);
  const input = spy.mock.calls[0]?.[1];
  assert.equal(input?.ifMatch, BASE_REVISION);
  assert.equal(input?.collectionId, COL_ID);
  assert.equal(input?.nodeId, NODE_ID);
});

test('nodes.update accepts ifMatch as the baseRevision alias', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(updateNodeModule, 'updateCollectionNode');
  const service = createPhase4bMcpLowRiskNodeUpdateService({
    unitOfWork: capturingUnitOfWork(fakePorts({ nextRevision: 'rev-applied' }), probe),
  });
  await service.execute(Object.freeze({
    collectionId: COL_ID,
    nodeId: NODE_ID,
    ifMatch: BASE_REVISION,
    patch: Object.freeze({ title: 'Updated title' }),
  }), CONTEXT);
  assert.equal(spy.mock.calls[0]?.[1]?.ifMatch, BASE_REVISION);
  await assert.rejects(
    service.execute(Object.freeze({
      collectionId: COL_ID,
      nodeId: NODE_ID,
      baseRevision: BASE_REVISION,
      ifMatch: 'other-rev',
      patch: Object.freeze({ title: 'Updated title' }),
    }), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'invalid_catalog_input');
      return true;
    },
  );
});

test('nodes.update stale CollectionPreconditionError classifies without current revision', async () => {
  const probe = { uowCalls: 0 };
  const service = createPhase4bMcpLowRiskNodeUpdateService({
    unitOfWork: throwingUnitOfWork(
      new CollectionPreconditionError({ currentEtag: LEAK_ETAG }),
      probe,
    ),
  });
  await assert.rejects(
    service.execute(nodeApplyInput(), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'stale_revision');
      assert.equal(error.message, PHASE4B_MCP_STALE_REVISION_MESSAGE);
      assert.equal(error.message.includes('LEAK'), false);
      assert.equal(JSON.stringify(error).includes('LEAK'), false);
      const classified = classifyPhase4bMcpWriteError(error);
      assert.equal(classified.stableClass, 'stale_revision');
      assert.equal(classified.safeMessage, PHASE4B_MCP_STALE_REVISION_MESSAGE);
      assert.equal(classified.safeMessage.includes('LEAK'), false);
      assert.notEqual(classified.stableClass, 'internal_error');
      return true;
    },
  );
  assert.equal(probe.uowCalls, 1);
});

test('nodes.update CollectionAuthorizationError conceal is leak-safe policy_rejected', async () => {
  const probe = { uowCalls: 0 };
  const secretId = 'col-secret-id-999';
  const service = createPhase4bMcpLowRiskNodeUpdateService({
    unitOfWork: throwingUnitOfWork(
      new CollectionAuthorizationError({
        outcome: 'conceal',
        reasonCategory: 'resource_missing',
      }),
      probe,
    ),
  });
  await assert.rejects(
    service.execute({
      ...nodeApplyInput(),
      collectionId: secretId,
    }, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'policy_denied');
      assert.equal(error.message.includes(secretId), false);
      const classified = classifyPhase4bMcpWriteError(error);
      assert.equal(classified.stableClass, 'policy_rejected');
      assert.notEqual(classified.stableClass, 'internal_error');
      assert.equal(classified.safeMessage.includes(secretId), false);
      const wire = toPhase4bMcpWriteRequestError(classified, writeErrorHintFrom(error));
      assert.equal(JSON.stringify(wire).includes(secretId), false);
      return true;
    },
  );
});

test('collections.update schema rejects extra properties and empty patch', () => {
  const valid = collectionApplyInput();
  assert.doesNotThrow(() => collectionUpdateInputValidator(valid));
  assert.throws(
    () => collectionUpdateInputValidator({ ...valid, extra: true }),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => collectionUpdateInputValidator(collectionApplyInput(Object.freeze({}))),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => collectionUpdateInputValidator(
      collectionApplyInput(Object.freeze({ title: 'x', visibility: 'private' })),
    ),
    (error: unknown) => error instanceof McpToolInputError,
  );
});

test('collections.update dryRun true does not call the mutator or unit of work', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(updateMetadataModule, 'updateCollectionMetadataCanonical');
  const ports = fakePorts();
  const service = createPhase4bMcpLowRiskCollectionUpdateService({
    unitOfWork: capturingUnitOfWork(ports, probe),
    inspect: inspectFrom(ports),
  });
  const output = await service.execute(collectionApplyInput(undefined, { dryRun: true }), CONTEXT);
  assert.deepEqual(output, {
    resultType: 'preview',
    collectionId: COL_ID,
    title: 'Updated library',
  });
  assert.equal(probe.uowCalls, 0);
  assert.equal(spy.mock.calls.length, 0);
});

test('collections.update omit dryRun applies title-only with ifMatch === baseRevision', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(updateMetadataModule, 'updateCollectionMetadataCanonical');
  const service = createPhase4bMcpLowRiskCollectionUpdateService({
    unitOfWork: capturingUnitOfWork(fakePorts({ nextRevision: 'rev-col-2' }), probe),
  });
  const output = await service.execute(collectionApplyInput(), CONTEXT);
  assert.equal(output.resultType, 'complete');
  if (output.resultType !== 'complete') return;
  assert.equal(output.collectionId, COL_ID);
  assert.equal(output.title, 'Updated library');
  assert.equal(output.revision, 'rev-col-2');
  assert.equal(probe.uowCalls, 1);
  assert.equal(spy.mock.calls.length, 1);
  const input = spy.mock.calls[0]?.[1];
  assert.equal(input?.ifMatch, BASE_REVISION);
  assert.deepEqual(input?.patch, { title: 'Updated library' });
  assert.equal(Object.hasOwn(input?.patch ?? {}, 'visibility'), false);
});

test('collections.update stale CollectionPreconditionError classifies without current revision', async () => {
  const probe = { uowCalls: 0 };
  const service = createPhase4bMcpLowRiskCollectionUpdateService({
    unitOfWork: throwingUnitOfWork(
      new CollectionPreconditionError({ currentEtag: LEAK_ETAG }),
      probe,
    ),
  });
  await assert.rejects(
    service.execute(collectionApplyInput(), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'stale_revision');
      assert.equal(error.message, PHASE4B_MCP_STALE_REVISION_MESSAGE);
      assert.equal(error.message.includes('LEAK'), false);
      const classified = classifyPhase4bMcpWriteError(error);
      assert.equal(classified.stableClass, 'stale_revision');
      assert.equal(classified.safeMessage.includes('LEAK'), false);
      return true;
    },
  );
});

test('collections.update CollectionAuthorizationError conceal is leak-safe policy_rejected', async () => {
  const probe = { uowCalls: 0 };
  const secretId = 'col-secret-id-888';
  const service = createPhase4bMcpLowRiskCollectionUpdateService({
    unitOfWork: throwingUnitOfWork(
      new CollectionAuthorizationError({
        outcome: 'conceal',
        reasonCategory: 'resource_missing',
      }),
      probe,
    ),
  });
  await assert.rejects(
    service.execute({
      ...collectionApplyInput(),
      collectionId: secretId,
    }, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'policy_denied');
      assert.equal(error.message.includes(secretId), false);
      const classified = classifyPhase4bMcpWriteError(error);
      assert.equal(classified.stableClass, 'policy_rejected');
      assert.notEqual(classified.stableClass, 'internal_error');
      assert.equal(classified.safeMessage.includes(secretId), false);
      return true;
    },
  );
});
