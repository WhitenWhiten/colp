import { describe, expect, it, vi } from 'vitest';

import {
  executePublisherNodeDelete,
  type PublisherNodeDeletePorts,
  type PublisherNodeDeleteRequest,
  type PublisherNodeDeleteTransaction,
} from '../../src/publisher/index.js';
import { evaluatePublisherWritePrecondition } from '../../src/publisher/preconditions.js';
import { mapPublisherPreconditionToProblem } from '../../src/server/problems.js';
import { getProblemDefinition } from '../../src/shared/problems.js';
import type { StrictNode } from '../../src/types/index.js';

const evidence = 'publisher.precondition-required';
const collectionId = 'collection-publish-0007';
const rootId = 'root-publish-0007';
const nodeId = 'node-publish-0007';
const currentRevision = 'revision-current';
const currentEtag = `"${currentRevision}"`;
const instant = '2026-07-19T00:00:00Z';

const root: StrictNode = {
  id: rootId,
  collectionId,
  kind: 'root',
  parentId: null,
  position: null,
  folderRole: 'root',
  title: 'Root',
  createdAt: instant,
  updatedAt: instant,
  revision: 'revision-root',
};
const target: StrictNode = {
  id: nodeId,
  collectionId,
  kind: 'bookmark',
  parentId: rootId,
  position: 'position-node',
  title: 'Target',
  url: 'https://example.test/publish-0007',
  createdAt: instant,
  updatedAt: instant,
  revision: currentRevision,
};

type IfMatch = PublisherNodeDeleteRequest['ifMatch'];
type AuthorizationProblem = 'insufficient_scope' | 'resource_not_found';

function request(ifMatch: IfMatch): PublisherNodeDeleteRequest {
  return {
    ...(ifMatch === undefined ? {} : { ifMatch }),
    query: {},
    operation: {
      operationId: 'operation-publish-0007',
      replicaId: 'publisher-server',
      sequence: 7,
      occurredAt: instant,
      collectionId,
      action: 'delete',
      targetId: nodeId,
      baseRevision: currentRevision,
      payload: { reason: 'precondition audit' },
    },
  };
}

function boundary(
  authorizationProblem?: AuthorizationProblem,
): { readonly events: string[]; readonly ports: PublisherNodeDeletePorts<PublisherNodeDeleteTransaction> } {
  const events: string[] = [];
  const nodes = new Map([[rootId, root], [nodeId, target]]);
  const context: PublisherNodeDeleteTransaction = {
    async resolveCollection(id) {
      events.push(`resolve-collection:${id}`);
      return id === collectionId ? { id, rootNodeId: rootId } : undefined;
    },
    async resolveNode(id) {
      events.push(`resolve-node:${id}`);
      return nodes.get(id);
    },
    async resolveChildren(parentId, limit) {
      events.push(`resolve-children:${parentId}`);
      const children = [...nodes.values()].filter((node) => node.parentId === parentId);
      return { nodes: children.slice(0, limit), hasMore: children.length > limit };
    },
    async bindNodeDeletionPlan() {
      throw new Error('application boundary must not be reached');
    },
    async resolveNodeDeletionApplication() {
      throw new Error('application ledger must not be read');
    },
  };
  const ports: PublisherNodeDeletePorts<PublisherNodeDeleteTransaction> = {
    unitOfWork: { async run(work) { events.push('transaction'); return work(context); } },
    authenticate: async () => {
      events.push('authenticate');
      return {
        authenticated: true,
        identityResolution: {
          status: 'authenticated',
          identities: [{ type: 'user', id: 'publisher-0007' }],
          scopes: ['nodes:delete'],
        },
      };
    },
    authorizeRequiredScope: async () => { events.push('authorize-scope'); return { authorized: true }; },
    authorize: async (_context, _identities, _candidate, _mutation, subject) => {
      events.push(`authorize:${subject.kind}`);
      return authorizationProblem !== undefined && subject.kind === 'request-target'
        ? { authorized: false, reason: 'classified authorization detail' }
        : { authorized: true };
    },
    conceal: async (_context, _identities, _candidate, _mutation, input) => {
      events.push(`conceal:${input.subject.kind}`);
      return authorizationProblem !== undefined && !input.authorized
        ? { allowed: false, problem: authorizationProblem }
        : { allowed: true };
    },
    validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
    application: {
      async applyOperations() {
        events.push('apply');
        throw new Error('application boundary must not be reached');
      },
    },
  };
  return { events, ports };
}

describe(`PUBLISH-0007 missing publisher precondition [evidence:${evidence}]`, () => {
  it.each([
    ['omitted', () => request(undefined)],
    ['undefined', () => ({ ...request(undefined), ifMatch: undefined }) as unknown as PublisherNodeDeleteRequest],
    ['null', () => request(null)],
    ['empty repeated header', () => request([])],
  ] as const)(`[success] [boundary] returns registered 428 for %s If-Match [evidence:${evidence}]`, async (_label, makeRequest) => {
    const adapter = boundary();
    const result = await executePublisherNodeDelete(makeRequest(), adapter.ports);

    expect(result).toEqual({
      state: 'rejected',
      code: 'precondition_required',
      status: 428,
      retryable: true,
      currentRevision,
      currentEtag,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(getProblemDefinition('precondition_required')).toEqual({ status: 428, retryable: true });
    expect(adapter.events).not.toContain('apply');
  });

  it.each([
    ['empty field', ''],
    ['malformed field', 'malformed-token'],
    ['valid plus malformed repeated field', [currentEtag, 'malformed-token']],
  ] as const)(`[negative] [regression] keeps %s distinct at registered 412 [evidence:${evidence}]`, async (_label, ifMatch) => {
    const adapter = boundary();
    const result = await executePublisherNodeDelete(request(ifMatch), adapter.ports);

    expect(result).toEqual({
      state: 'rejected',
      code: 'precondition_failed',
      status: 412,
      retryable: true,
      currentRevision,
      currentEtag,
    });
    expect(getProblemDefinition('precondition_failed')).toEqual({ status: 412, retryable: true });
    expect(adapter.events).not.toContain('apply');
  });

  it.each([
    ['hidden', 'resource_not_found', 404],
    ['visible', 'insufficient_scope', 403],
  ] as const)(`[negative] [boundary] returns %s authorization before missing-precondition evaluation [evidence:${evidence}]`, async (_label, code, status) => {
    const adapter = boundary(code);
    const result = await executePublisherNodeDelete(request(undefined), adapter.ports);

    expect(result).toEqual({ state: 'rejected', code, status, retryable: false });
    expect(adapter.events).toEqual([
      'transaction', 'authenticate', 'authorize-scope',
      'authorize:request-target', 'conceal:request-target',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/classified|principal|authorization|precondition|revision|etag/iu);
  });

  it(`[negative] [boundary] fails closed before security or resolution for hostile request shapes [evidence:${evidence}]`, async () => {
    const getter = vi.fn(() => undefined);
    const accessor = Object.defineProperty(request(undefined), 'ifMatch', {
      enumerable: true,
      get: getter,
    }) as PublisherNodeDeleteRequest;
    const sparse = new Array<string>(1);
    const unknown = { ...request(undefined), unexpected: 'state-disclosure-probe' } as unknown as PublisherNodeDeleteRequest;

    for (const hostile of [new Proxy(request(undefined), {}), accessor, request(sparse), unknown]) {
      const adapter = boundary();
      const result = await executePublisherNodeDelete(hostile, adapter.ports);
      expect(result).toEqual({
        state: 'rejected', code: 'invalid_document', status: 422, retryable: false,
      });
      expect(adapter.events).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(/state-disclosure-probe|principal|authorization|revision|etag/iu);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it(`[negative] [unit] snapshots hostile evaluator inputs and keeps the Problem mapper stable [evidence:${evidence}]`, () => {
    const input = {
      existingResource: true,
      currentRevision,
      currentEtag,
    } as const;
    const failure = evaluatePublisherWritePrecondition(input);
    if (failure.state !== 'rejected') throw new Error('missing If-Match unexpectedly satisfied');

    expect(mapPublisherPreconditionToProblem(failure)).toEqual({
      code: 'precondition_required', status: 428, retryable: true,
    });
    const minimal = mapPublisherPreconditionToProblem({ code: failure.code, status: failure.status });
    expect(minimal).toEqual({ code: 'precondition_required', status: 428, retryable: true });
    expect(Object.isFrozen(minimal)).toBe(true);

    const getter = vi.fn(() => true);
    const accessor = Object.defineProperty({ ...input }, 'existingResource', {
      enumerable: true,
      get: getter,
    });
    const sparse = new Array<string>(1);
    for (const hostile of [
      new Proxy(input, {}),
      accessor,
      { ...input, ifMatch: sparse },
      { ...input, unknown: true },
    ]) {
      expect(() => evaluatePublisherWritePrecondition(hostile as never)).toThrow(TypeError);
    }
    expect(getter).not.toHaveBeenCalled();

    const mapperGetter = vi.fn(() => 'precondition_required');
    const mapperAccessor = Object.defineProperty({ status: 428 }, 'code', {
      enumerable: true,
      get: mapperGetter,
    });
    for (const hostile of [
      new Proxy({ code: 'precondition_required', status: 428 }, {}),
      mapperAccessor,
      { code: 'precondition_required', status: 428, unknown: true },
      { state: 'satisfied', code: 'precondition_required', status: 428 },
    ]) {
      expect(() => mapPublisherPreconditionToProblem(hostile as never)).toThrow(TypeError);
    }
    expect(mapperGetter).not.toHaveBeenCalled();
  });
});
