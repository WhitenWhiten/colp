import { describe, expect, it, vi } from 'vitest';

import {
  executePublisherNodeDelete,
  executePublisherNodeMove,
  evaluatePublisherWritePrecondition,
  type PublisherNodeDeletePorts,
  type PublisherNodeDeleteRequest,
  type PublisherNodeDeleteTransaction,
  type PublisherNodeMovePorts,
  type PublisherNodeMoveRequest,
  type PublisherNodeMoveTransaction,
} from '../../src/publisher/index.js';
import {
  createPublicationProblemDescriptor,
  mapPublisherPreconditionToProblem,
  mapPublisherWriteConflictToProblem,
  problemRegistry,
} from '../../src/server/index.js';
import type { StrictNode } from '../../src/types/index.js';

const evidence = 'publisher.precondition-failed';
const collectionId = 'collection-publish-0008';
const rootId = 'root-publish-0008';
const sourceId = 'source-publish-0008';
const targetParentId = 'target-parent-publish-0008';
const targetId = 'target-publish-0008';
const currentRevision = 'revision-current-publish-0008';
const currentEtag = `"${currentRevision}"`;
const instant = '2026-07-19T12:00:00Z';

type ProblemCode = keyof typeof problemRegistry;
type Context = PublisherNodeMoveTransaction & PublisherNodeDeleteTransaction & {
  readonly events: string[];
};

function root(): StrictNode {
  return {
    id: rootId, collectionId, kind: 'root', parentId: null, position: null,
    folderRole: 'root', title: 'Root', createdAt: instant, updatedAt: instant,
    revision: 'revision-root-publish-0008',
  };
}

function folder(id: string, parentId = rootId): StrictNode {
  return {
    id, collectionId, kind: 'folder', parentId, position: `position-${id}`,
    folderRole: 'custom', title: id, createdAt: instant, updatedAt: instant,
    revision: `revision-${id}`,
  };
}

function bookmark(id: string, parentId: string, position: string, revision = `revision-${id}`): StrictNode {
  return {
    id, collectionId, kind: 'bookmark', parentId, position, title: id,
    url: `https://example.test/${id}`, createdAt: instant, updatedAt: instant, revision,
  };
}

function context(targetOverride?: StrictNode, extraNodes: readonly StrictNode[] = []): Context {
  const nodes = [
    root(), folder(sourceId), folder(targetParentId),
    targetOverride ?? bookmark(targetId, sourceId, 'b', currentRevision),
    bookmark('anchor-after-publish-0008', targetParentId, 'a'),
    bookmark('anchor-before-publish-0008', targetParentId, 'c'),
    ...extraNodes,
  ];
  const rows = new Map(nodes.map((node) => [node.id, node]));
  const childrenRevisions = new Map([
    [rootId, 'children-root-current'],
    [sourceId, 'children-source-current'],
    [targetParentId, 'children-target-current'],
  ]);
  const events: string[] = [];
  return {
    events,
    async resolveCollection(id) {
      events.push(`collection:${id}`);
      return id === collectionId ? { id: collectionId, rootNodeId: rootId } : undefined;
    },
    async resolveNode(id) {
      events.push(`node:${id}`);
      return rows.get(id);
    },
    async resolveChildren(parentId, limit) {
      events.push(`children:${parentId}`);
      const children = nodes.filter((node) => node.parentId === parentId);
      return { nodes: children.slice(0, limit), hasMore: children.length > limit };
    },
    async resolveMovePositionContext(parentId) {
      events.push(`position:${parentId}`);
      const childrenRevision = childrenRevisions.get(parentId);
      if (childrenRevision === undefined) return undefined;
      return {
        parentId,
        childrenRevision,
        children: nodes.filter((node) => node.parentId === parentId),
      };
    },
    async bindNodeDeletionPlan() {
      events.push('bind-delete');
    },
    async resolveNodeDeletionApplication() {
      events.push('resolve-delete-application');
      return undefined;
    },
  };
}

function moveRequest(change: Partial<PublisherNodeMoveRequest> = {}): PublisherNodeMoveRequest {
  return {
    ifMatch: currentEtag,
    operation: {
      operationId: 'operation-move-publish-0008', replicaId: 'publisher-server', sequence: 8,
      occurredAt: instant, collectionId, action: 'move', targetId,
      baseRevision: currentRevision,
      payload: {
        newParentId: targetParentId,
        afterId: 'anchor-after-publish-0008',
        beforeId: 'anchor-before-publish-0008',
        baseSourceParentRevision: 'children-source-current',
        baseTargetParentRevision: 'children-target-current',
      },
    },
    ...change,
  };
}

function deleteRequest(change: Partial<PublisherNodeDeleteRequest> = {}): PublisherNodeDeleteRequest {
  return {
    ifMatch: currentEtag,
    query: {},
    operation: {
      operationId: 'operation-delete-publish-0008', replicaId: 'publisher-server', sequence: 8,
      occurredAt: instant, collectionId, action: 'delete', targetId,
      baseRevision: currentRevision, payload: { reason: 'test' },
    },
    ...change,
  };
}

function movePorts(
  value: Context,
  change: Partial<PublisherNodeMovePorts<Context>> = {},
): PublisherNodeMovePorts<Context> {
  return {
    unitOfWork: { async run(work) { return work(value); } },
    authenticate: async () => ({
      authenticated: true,
      identityResolution: { status: 'authenticated', identities: [{ type: 'user', id: 'alice' }] },
    }),
    authorize: async (_context, _identities, _request, _mutation, subject) => {
      value.events.push(`authorize:${subject.kind}`);
      return { authorized: true };
    },
    conceal: async (_context, _identities, _request, _mutation, input) => {
      value.events.push(`conceal:${input.subject.kind}`);
      return { allowed: true };
    },
    validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
    application: { async applyOperations() { throw new Error('application must not run'); } },
    ...change,
  };
}

function deletePorts(
  value: Context,
  change: Partial<PublisherNodeDeletePorts<Context>> = {},
): PublisherNodeDeletePorts<Context> {
  return {
    unitOfWork: { async run(work) { return work(value); } },
    authenticate: async () => ({
      authenticated: true,
      identityResolution: {
        status: 'authenticated', identities: [{ type: 'user', id: 'alice' }], scopes: ['nodes:delete'],
      },
    }),
    authorizeRequiredScope: async () => ({ authorized: true }),
    authorize: async (_context, _identities, _request, _mutation, subject) => {
      value.events.push(`authorize:${subject.kind}`);
      return { authorized: true };
    },
    conceal: async (_context, _identities, _request, _mutation, input) => {
      value.events.push(`conceal:${input.subject.kind}`);
      return { allowed: true };
    },
    validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
    application: {
      async applyOperations() { throw new Error('generic application must not run'); },
    },
    ...change,
  };
}

function rejected(code: ProblemCode) {
  return { state: 'rejected' as const, code, ...problemRegistry[code] };
}

describe(`PUBLISH-0008 production precondition/conflict boundary [evidence:${evidence}]`, () => {
  it.each([
    ['missing', undefined, 'precondition_required'],
    ['stale', '"revision-stale"', 'precondition_failed'],
    ['malformed', currentRevision, 'precondition_failed'],
    ['weak', `W/${currentEtag}`, 'precondition_failed'],
    ['mixed repeated', [currentEtag, currentRevision], 'precondition_failed'],
    ['stale repeated', ['"revision-old-1"', '"revision-old-2"'], 'precondition_failed'],
  ] as const)(`Move returns the exact 428/412 distinction for %s If-Match with recovery metadata [evidence:${evidence}]`, async (_label, ifMatch, code) => {
    const transaction = context();
    const request = ifMatch === undefined
      ? { operation: moveRequest().operation }
      : moveRequest({ ifMatch });
    const result = await executePublisherNodeMove(request, movePorts(transaction));

    expect(result).toEqual({
      ...rejected(code), currentRevision, currentEtag,
    });
    expect(transaction.events).toContain('authorize:request-target');
    expect(transaction.events).toContain('conceal:request-target');
    expect(transaction.events).toContain('authorize:affected-node');
    expect(transaction.events).toContain('conceal:affected-node');
    expect(transaction.events.some((event) => event.startsWith('position:'))).toBe(false);
  });

  it.each([
    ['missing', undefined, 'precondition_required'],
    ['stale', '"revision-stale"', 'precondition_failed'],
    ['malformed', currentRevision, 'precondition_failed'],
    ['weak', `W/${currentEtag}`, 'precondition_failed'],
    ['mixed repeated', [currentEtag, currentRevision], 'precondition_failed'],
    ['stale repeated', ['"revision-old-1"', '"revision-old-2"'], 'precondition_failed'],
  ] as const)(`Delete returns the exact 428/412 distinction for %s If-Match with recovery metadata [evidence:${evidence}]`, async (_label, ifMatch, code) => {
    const transaction = context();
    const request = ifMatch === undefined
      ? { operation: deleteRequest().operation, query: {} }
      : deleteRequest({ ifMatch });
    const result = await executePublisherNodeDelete(request, deletePorts(transaction));

    expect(result).toEqual({
      ...rejected(code), currentRevision, currentEtag,
    });
    expect(transaction.events).toContain('authorize:request-target');
    expect(transaction.events).toContain('conceal:request-target');
    expect(transaction.events).toContain('authorize:affected-node');
    expect(transaction.events).toContain('conceal:affected-node');
    expect(transaction.events).not.toContain('bind-delete');
  });

  it.each([
    ['Move hidden', 'move', 'resource_not_found'],
    ['Move visible', 'move', 'insufficient_scope'],
    ['Delete hidden', 'delete', 'resource_not_found'],
    ['Delete visible', 'delete', 'insufficient_scope'],
  ] as const)(`%s returns concealment-selected 404/403 before stale precondition state [evidence:${evidence}]`, async (_label, endpoint, code) => {
    const transaction = context();
    const result = endpoint === 'move'
      ? await executePublisherNodeMove(moveRequest({ ifMatch: '"classified-stale-revision"' }), movePorts(transaction, {
        authorize: async () => ({ authorized: false, reason: 'classified authorization reason' }),
        conceal: async () => ({ allowed: false, problem: code }),
      }))
      : await executePublisherNodeDelete(deleteRequest({ ifMatch: '"classified-stale-revision"' }), deletePorts(transaction, {
        authorizeRequiredScope: async () => ({ authorized: false, reason: 'classified scope reason' }),
        conceal: async () => ({ allowed: false, problem: code }),
      }));

    expect(result).toEqual(rejected(code));
    expect(transaction.events.some((event) => /^(collection|node|children|position):/u.test(event))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/classified|precondition|revision|etag|authorization|reason/iu);
  });

  it.each(['Move', 'Delete'] as const)(`%s returns revision_conflict 409 only after a satisfied Node If-Match [evidence:${evidence}]`, async (endpoint) => {
    const transaction = context();
    const result = endpoint === 'Move'
      ? await executePublisherNodeMove(moveRequest({
        operation: { ...moveRequest().operation, baseRevision: 'revision-business-stale' },
      }), movePorts(transaction))
      : await executePublisherNodeDelete(deleteRequest({
        operation: { ...deleteRequest().operation, baseRevision: 'revision-business-stale' },
      }), deletePorts(transaction));

    expect(result).toEqual(rejected('revision_conflict'));
    expect(result).not.toHaveProperty('currentRevision');
    expect(result).not.toHaveProperty('currentEtag');
  });

  it(`keeps stale Children/position context behind the Node precondition and maps it to 409 [evidence:${evidence}]`, async () => {
    const staleChildren = {
      ...moveRequest().operation.payload,
      baseSourceParentRevision: 'children-source-stale',
    };

    const rejectedBeforeContext = context();
    expect(await executePublisherNodeMove(moveRequest({
      ifMatch: '"revision-node-stale"',
      operation: { ...moveRequest().operation, payload: staleChildren },
    }), movePorts(rejectedBeforeContext))).toEqual({
      ...rejected('precondition_failed'), currentRevision, currentEtag,
    });
    expect(rejectedBeforeContext.events.some((event) => event.startsWith('position:'))).toBe(false);

    const checkedContext = context();
    expect(await executePublisherNodeMove(moveRequest({
      operation: { ...moveRequest().operation, payload: staleChildren },
    }), movePorts(checkedContext))).toEqual(rejected('position_context_stale'));
    expect(checkedContext.events).toContain(`position:${sourceId}`);
    expect(checkedContext.events).toContain(`position:${targetParentId}`);

    const hostilePlacementContext = context();
    expect(await executePublisherNodeMove(moveRequest({
      operation: {
        ...moveRequest().operation,
        payload: { ...moveRequest().operation.payload, beforeId: 'missing-anchor-publish-0008' },
      },
    }), movePorts(hostilePlacementContext))).toEqual(rejected('position_context_stale'));
  });

  it.each([
    ['hidden child', 'resource_not_found'],
    ['visible child', 'insufficient_scope'],
  ] as const)(`Delete authorizes and conceals an affected %s before folder_not_empty [evidence:${evidence}]`, async (_label, code) => {
    const childId = 'classified-child-publish-0008';
    const transaction = context(
      { ...folder(targetId, sourceId), revision: currentRevision },
      [bookmark(childId, targetId, 'a')],
    );
    const inspected: string[] = [];
    const result = await executePublisherNodeDelete(
      deleteRequest({ ifMatch: '"stale-before-business-conflict"' }),
      deletePorts(transaction, {
        authorize: async (_context, _identities, _request, _mutation, subject) => {
          inspected.push(`authorize:${subject.kind}:${subject.kind === 'affected-node' ? subject.nodeId : '-'}`);
          return subject.kind === 'affected-node' && subject.nodeId === childId
            ? { authorized: false, reason: 'classified child authorization state' }
            : { authorized: true };
        },
        conceal: async (_context, _identities, _request, _mutation, input) => {
          inspected.push(`conceal:${input.subject.kind}:${input.subject.kind === 'affected-node' ? input.subject.nodeId : '-'}`);
          return !input.authorized
            ? { allowed: false, problem: code }
            : { allowed: true };
        },
      }),
    );

    expect(result).toEqual(rejected(code));
    expect(inspected).toContain(`authorize:affected-node:${childId}`);
    expect(inspected).toContain(`conceal:affected-node:${childId}`);
    expect(result).not.toHaveProperty('currentRevision');
    expect(result).not.toHaveProperty('currentEtag');
    expect(transaction.events).not.toContain('bind-delete');
  });

  it(`Delete gives an authorized Node precondition precedence over folder_not_empty, then returns 409 [evidence:${evidence}]`, async () => {
    const folderTarget = { ...folder(targetId, sourceId), revision: currentRevision };
    const child = bookmark('child-publish-0008', targetId, 'a');

    const staleContext = context(folderTarget, [child]);
    const stale = await executePublisherNodeDelete(
      deleteRequest({ ifMatch: '"stale-folder-revision"' }),
      deletePorts(staleContext),
    );
    expect(stale).toEqual({
      ...rejected('precondition_failed'), currentRevision, currentEtag,
    });
    expect(Object.isFrozen(stale)).toBe(true);
    expect(staleContext.events).not.toContain('bind-delete');

    const satisfiedContext = context(folderTarget, [child]);
    const conflict = await executePublisherNodeDelete(deleteRequest(), deletePorts(satisfiedContext));
    expect(conflict).toEqual(rejected('folder_not_empty'));
    expect(conflict).not.toHaveProperty('currentRevision');
    expect(conflict).not.toHaveProperty('currentEtag');
    expect(Object.isFrozen(conflict)).toBe(true);
    expect(satisfiedContext.events).not.toContain('bind-delete');
  });

  it.each(['Move', 'Delete'] as const)(`%s fails closed on Proxy, accessor, and hostile repeated-header shapes without leakage [evidence:${evidence}]`, async (endpoint) => {
    const transaction = context();
    const secret = 'classified-validator-publish-0008';
    const proxyRequest = endpoint === 'Move'
      ? new Proxy(moveRequest(), {})
      : new Proxy(deleteRequest(), {});
    const accessorRequest = endpoint === 'Move' ? moveRequest() : deleteRequest();
    Object.defineProperty(accessorRequest, 'ifMatch', {
      enumerable: true,
      get: () => `"${secret}"`,
    });
    const hostileValues = [currentEtag] as string[];
    Object.defineProperty(hostileValues, secret, { enumerable: true, value: currentEtag });
    const hostileRequest = endpoint === 'Move'
      ? moveRequest({ ifMatch: hostileValues })
      : deleteRequest({ ifMatch: hostileValues });

    const results = endpoint === 'Move'
      ? await Promise.all([
        executePublisherNodeMove(proxyRequest as PublisherNodeMoveRequest, movePorts(transaction)),
        executePublisherNodeMove(accessorRequest as PublisherNodeMoveRequest, movePorts(transaction)),
        executePublisherNodeMove(hostileRequest as PublisherNodeMoveRequest, movePorts(transaction)),
      ])
      : await Promise.all([
        executePublisherNodeDelete(proxyRequest as PublisherNodeDeleteRequest, deletePorts(transaction)),
        executePublisherNodeDelete(accessorRequest as PublisherNodeDeleteRequest, deletePorts(transaction)),
        executePublisherNodeDelete(hostileRequest as PublisherNodeDeleteRequest, deletePorts(transaction)),
      ]);

    for (const result of results) {
      expect(result).toEqual(endpoint === 'Move' ? rejected('internal_error') : rejected('invalid_document'));
      expect(JSON.stringify(result)).not.toMatch(/classified|validator|revision|etag|target-publish/iu);
    }
  });
});

describe(`PUBLISH-0008 pure If-Match and recovery contracts [evidence:${evidence}]`, () => {
  const authoritative = {
    existingResource: true,
    currentRevision: 'revision-authoritative-publish-0008',
    currentEtag: '"etag-authoritative-publish-0008"',
  } as const;

  it.each([
    ['strong ETag', '"etag-authoritative-publish-0008"', 'etag'],
    ['strong Revision', '"revision-authoritative-publish-0008"', 'revision'],
    ['quoted comma', '"revision,with,commas"', 'revision'],
    ['repeated fields', ['"stale"', '"etag-authoritative-publish-0008"'], 'etag'],
    ['weak then strong', ['W/"etag-authoritative-publish-0008"', '"revision-authoritative-publish-0008"'], 'revision'],
    ['wildcard field', '*', 'wildcard'],
    ['wildcard repeated field', ['*'], 'wildcard'],
  ] as const)(`parses RFC entity tags for %s [evidence:${evidence}]`, (_label, ifMatch, matched) => {
    const input = _label === 'quoted comma'
      ? { ...authoritative, currentRevision: 'revision,with,commas', ifMatch }
      : { ...authoritative, ifMatch };
    const result = evaluatePublisherWritePrecondition(input);
    expect(result).toEqual({ state: 'satisfied', status: 200, matched });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['weak only', 'W/"etag-authoritative-publish-0008"'],
    ['wildcard first mixture', '*, "etag-authoritative-publish-0008"'],
    ['wildcard last mixture', '"etag-authoritative-publish-0008", *'],
    ['wildcard repeated mixture', ['*', '"etag-authoritative-publish-0008"']],
    ['bare token', 'revision-authoritative-publish-0008'],
    ['unterminated tag', '"revision-authoritative-publish-0008'],
    ['tag suffix', '"etag-authoritative-publish-0008"junk'],
    ['lowercase weak prefix', 'w/"etag-authoritative-publish-0008"'],
    ['valid plus malformed', ['"etag-authoritative-publish-0008"', 'malformed']],
    ['empty field', ''],
    ['OWS-only field', ' \t '],
    ['control LF', '"etag\nstate"'],
    ['control CR', '"etag\rstate"'],
    ['control NUL', '"etag\u0000state"'],
    ['non-RFC Unicode', '"etag-\u2603"'],
    ['oversize field', `"${'a'.repeat(16 * 1024)}"`],
    ['too many repeated fields', Array.from({ length: 1_025 }, () => '"x"')],
  ] as const)(`rejects %s as exact 412 with authoritative recovery [evidence:${evidence}]`, (_label, ifMatch) => {
    const result = evaluatePublisherWritePrecondition({ ...authoritative, ifMatch });
    expect(result).toEqual({
      state: 'rejected', status: 412, code: 'precondition_failed',
      currentRevision: authoritative.currentRevision,
      currentEtag: authoritative.currentEtag,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['empty repeated field', []],
  ] as const)(`keeps %s distinct as exact 428 with authoritative recovery [evidence:${evidence}]`, (_label, ifMatch) => {
    expect(evaluatePublisherWritePrecondition({ ...authoritative, ifMatch })).toEqual({
      state: 'rejected', status: 428, code: 'precondition_required',
      currentRevision: authoritative.currentRevision,
      currentEtag: authoritative.currentEtag,
    });
  });

  it(`maps only satisfied preconditions to immutable 409 conflicts [evidence:${evidence}]`, () => {
    const satisfied = evaluatePublisherWritePrecondition({ ...authoritative, ifMatch: authoritative.currentEtag });
    const conflict = mapPublisherWriteConflictToProblem(satisfied, true);
    expect(conflict).toEqual({ code: 'revision_conflict', status: 409, retryable: false });
    expect(Object.isFrozen(conflict)).toBe(true);

    const stale = evaluatePublisherWritePrecondition({ ...authoritative, ifMatch: '"stale"' });
    if (stale.state !== 'rejected') throw new Error('stale If-Match unexpectedly satisfied');
    expect(mapPublisherWriteConflictToProblem(stale, true)).toEqual({
      code: 'precondition_failed', status: 412, retryable: true,
    });
    expect(mapPublisherPreconditionToProblem(stale)).not.toHaveProperty('currentRevision');
  });

  it(`rejects hostile evaluator, result, and recovery shapes without invoking accessors [evidence:${evidence}]`, () => {
    const inputGetter = vi.fn(() => authoritative.currentEtag);
    const accessorInput = Object.defineProperty({ ...authoritative }, 'ifMatch', {
      enumerable: true,
      get: inputGetter,
    });
    const resultGetter = vi.fn(() => 'etag');
    const accessorResult = Object.defineProperty({ state: 'satisfied', status: 200 }, 'matched', {
      enumerable: true,
      get: resultGetter,
    });
    const recoveryGetter = vi.fn(() => 'classified-revision');
    const accessorRecovery = Object.defineProperty({}, 'currentRevision', {
      enumerable: true,
      get: recoveryGetter,
    });

    expect(() => evaluatePublisherWritePrecondition(new Proxy(authoritative, {}) as never)).toThrow(TypeError);
    expect(() => evaluatePublisherWritePrecondition(accessorInput as never)).toThrow(TypeError);
    expect(() => mapPublisherWriteConflictToProblem(new Proxy({
      state: 'satisfied', status: 200, matched: 'etag',
    }, {}) as never, true)).toThrow(TypeError);
    expect(() => mapPublisherWriteConflictToProblem(accessorResult as never, true)).toThrow(TypeError);
    expect(() => createPublicationProblemDescriptor({
      code: 'precondition_failed', recovery: new Proxy({}, {}) as never,
    })).toThrow(TypeError);
    expect(() => createPublicationProblemDescriptor({
      code: 'precondition_failed', recovery: accessorRecovery as never,
    })).toThrow(TypeError);
    expect(inputGetter).not.toHaveBeenCalled();
    expect(resultGetter).not.toHaveBeenCalled();
    expect(recoveryGetter).not.toHaveBeenCalled();
  });

  it(`emits detached deeply immutable non-leaking 412 recovery output [evidence:${evidence}]`, () => {
    const recovery = {
      currentRevision: authoritative.currentRevision,
      currentEtag: authoritative.currentEtag,
      links: { retry: 'https://example.test/retry' },
    };
    const descriptor = createPublicationProblemDescriptor({ code: 'precondition_failed', recovery });
    recovery.links.retry = 'https://classified.example.test/leak';

    expect(descriptor.status).toBe(412);
    expect(descriptor.problem).toMatchObject({
      code: 'precondition_failed', status: 412,
      currentRevision: authoritative.currentRevision,
      currentEtag: authoritative.currentEtag,
      links: { retry: 'https://example.test/retry' },
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.problem)).toBe(true);
    expect(Object.isFrozen(descriptor.problem.links)).toBe(true);
    expect(JSON.stringify(descriptor)).not.toMatch(/classified|authorization|principal/iu);
  });
});
