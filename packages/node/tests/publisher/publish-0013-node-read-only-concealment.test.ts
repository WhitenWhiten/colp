import { describe, expect, it, vi } from 'vitest';

import {
  executePublisherGuardedNodeWrite,
  type PublisherGuardedNodeWritePorts,
  type PublisherGuardedNodeWriteResult,
  type PublisherNodeWriteAuthorizationSubject,
} from '../../src/publisher/index.js';
import {
  mapNodeWriteDenialToProblem,
  problemRegistry,
  type GuardedNodeWriteMutation,
  type GuardedNodeWritePlan,
  type NodeWriteResolver,
} from '../../src/server/index.js';
import type { StrictNode } from '../../src/types/index.js';

const evidence = 'publisher.node-read-only-concealment';
const timestamp = '2026-07-19T00:00:00Z';
const collection = Object.freeze({ id: 'collection-publish-0013', rootNodeId: 'root-publish-0013' });

type Candidate = {
  readonly principal: string;
  readonly body: { readonly title: string };
};

type Value = { readonly title: string; readonly nodeId: string };
type Result = PublisherGuardedNodeWriteResult<Value>;
type Ports = PublisherGuardedNodeWritePorts<NodeWriteResolver, Candidate, Value>;

function root(constraints?: StrictNode['constraints']): Extract<StrictNode, { readonly kind: 'root' }> {
  return {
    id: collection.rootNodeId,
    collectionId: collection.id,
    kind: 'root',
    parentId: null,
    position: null,
    folderRole: 'root',
    title: 'Root',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'revision-root',
    ...(constraints === undefined ? {} : { constraints }),
  };
}

function folder(
  id: string,
  parentId: string = collection.rootNodeId,
  constraints?: StrictNode['constraints'],
): Extract<StrictNode, { readonly kind: 'folder' }> {
  return {
    id,
    collectionId: collection.id,
    kind: 'folder',
    parentId,
    position: id,
    title: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: `revision-${id}`,
    ...(constraints === undefined ? {} : { constraints }),
  };
}

function bookmark(
  id: string,
  parentId: string = collection.rootNodeId,
  constraints?: StrictNode['constraints'],
): Extract<StrictNode, { readonly kind: 'bookmark' }> {
  return {
    id,
    collectionId: collection.id,
    kind: 'bookmark',
    parentId,
    position: id,
    title: id,
    url: 'https://example.test/',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: `revision-${id}`,
    ...(constraints === undefined ? {} : { constraints }),
  };
}

function resolver(nodes: readonly StrictNode[]): NodeWriteResolver {
  const rows = new Map(nodes.map((node) => [node.id, node]));
  return {
    async resolveCollection(id) {
      return id === collection.id ? collection : undefined;
    },
    async resolveNode(id) {
      return rows.get(id);
    },
    async resolveChildren(parentId, limit) {
      const children = nodes.filter((node) => node.parentId === parentId);
      return { nodes: children.slice(0, limit), hasMore: children.length > limit };
    },
  };
}

function makePorts(
  context: NodeWriteResolver,
  change: Partial<Ports> = {},
): Ports {
  return {
    unitOfWork: { async run(work) { return work(context); } },
    authenticate: async () => ({
      authenticated: true,
      identityResolution: {
        status: 'authenticated',
        identities: [{ type: 'user', id: 'publisher-alice' }],
      },
    }),
    authorize: async () => ({ authorized: true }),
    conceal: async (_context, _identities, _candidate, _mutation, input) => (
      input.authorized
        ? { allowed: true }
        : { allowed: false, problem: 'insufficient_scope' }
    ),
    validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
    write: async (_context, candidate, plan) => ({
      result: { title: candidate.body.title, nodeId: plan.modifiedNodeIds[0]! },
      modifiedNodeIds: plan.modifiedNodeIds,
      deletedNodeIds: plan.deletedNodeIds,
      deletedNodeCount: plan.deletedNodeCount,
    }),
    ...change,
  };
}

function publish(
  nodes: readonly StrictNode[],
  options: {
    readonly candidate?: Candidate;
    readonly mutation?: GuardedNodeWriteMutation;
    readonly context?: NodeWriteResolver;
    readonly ports?: Partial<Ports>;
  } = {},
): Promise<Result> {
  const context = options.context ?? resolver(nodes);
  return executePublisherGuardedNodeWrite(
    options.candidate ?? { principal: 'publisher-key:alice', body: { title: 'Updated' } },
    options.mutation ?? { kind: 'update-node', nodeId: 'target' },
    makePorts(context, options.ports),
  );
}

const rejected = (code: keyof typeof problemRegistry) => ({
  state: 'rejected' as const,
  code,
  ...problemRegistry[code],
});

describe(`PUBLISH-0013 Publisher read-only/concealment boundary [evidence:${evidence}]`, () => {
  it(`commits a writable request only after authentication, authorization, concealment, and policy [evidence:${evidence}]`, async () => {
    const order: string[] = [];
    const result = await publish([root(), bookmark('target')], {
      ports: {
        authenticate: async () => { order.push('authenticate'); return {
          authenticated: true,
          identityResolution: { status: 'authenticated', identities: [{ type: 'user', id: 'alice' }] },
        }; },
        authorize: async (_context, _identities, _candidate, _mutation, subject) => {
          order.push(`authorize:${subject.kind}`);
          return { authorized: true };
        },
        conceal: async (_context, _identities, _candidate, _mutation, input) => {
          order.push(`conceal:${input.subject.kind}`);
          return { allowed: true };
        },
        validate: async () => { order.push('validate'); return { allowed: true }; },
        evaluatePolicy: async () => { order.push('policy'); return { allowed: true }; },
        write: async (_context, candidate, plan) => {
          order.push('write');
          return {
            result: { title: candidate.body.title, nodeId: plan.modifiedNodeIds[0]! },
            modifiedNodeIds: plan.modifiedNodeIds,
            deletedNodeIds: plan.deletedNodeIds,
            deletedNodeCount: plan.deletedNodeCount,
          };
        },
      },
    });

    expect(result).toEqual({ state: 'committed', value: { title: 'Updated', nodeId: 'target' } });
    expect(order).toEqual([
      'authenticate', 'authorize:request-target', 'conceal:request-target', 'validate',
      'authorize:affected-node', 'conceal:affected-node', 'policy', 'write',
    ]);
  });

  it.each([
    ['the Node itself', [root(), bookmark('target', collection.rootNodeId, { readOnly: true, reason: 'own lock' })]],
    ['an authoritative ancestor', [
      root(),
      folder('locked-parent', collection.rootNodeId, { readOnly: true, reason: 'ancestor lock' }),
      bookmark('target', 'locked-parent'),
    ]],
  ] as const)(`returns only registered 403 node_read_only for %s after all security gates [evidence:${evidence}]`, async (_name, nodes) => {
    const subjects: PublisherNodeWriteAuthorizationSubject[] = [];
    const result = await publish(nodes, {
      ports: {
        authorize: async (_context, _identities, _candidate, _mutation, subject) => {
          subjects.push(subject);
          return { authorized: true };
        },
        conceal: async () => ({ allowed: true }),
      },
    });

    expect(subjects.map((subject) => subject.kind)).toEqual(['request-target', 'affected-node']);
    expect(result).toEqual(rejected('node_read_only'));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it(`rejects unauthenticated requests before authorization, graph reads, or read-only disclosure [evidence:${evidence}]`, async () => {
    const context: NodeWriteResolver = {
      resolveCollection: vi.fn(async () => { throw new Error('must not read Collection'); }),
      resolveNode: vi.fn(async () => { throw new Error('must not read Node'); }),
      resolveChildren: vi.fn(async () => { throw new Error('must not read children'); }),
    };
    const authorize = vi.fn();
    const conceal = vi.fn();
    const result = await publish([], {
      context,
      ports: { authenticate: async () => ({ authenticated: false }), authorize, conceal },
    });

    expect(result).toEqual(rejected('authentication_required'));
    expect(authorize).not.toHaveBeenCalled();
    expect(conceal).not.toHaveBeenCalled();
    expect(context.resolveNode).not.toHaveBeenCalled();
  });

  it.each([
    ['visible unauthorized', 'insufficient_scope' as const],
    ['hidden unauthorized', 'resource_not_found' as const],
  ])(`preserves Concealment Policy for a %s read-only target without graph access [evidence:${evidence}]`, async (_name, code) => {
    const context: NodeWriteResolver = {
      resolveCollection: vi.fn(async () => { throw new Error('read-only state must remain unread'); }),
      resolveNode: vi.fn(async () => { throw new Error('read-only state must remain unread'); }),
      resolveChildren: vi.fn(async () => { throw new Error('read-only state must remain unread'); }),
    };
    const result = await publish([], {
      context,
      ports: {
        authorize: async () => ({ authorized: false, reason: 'secret-scope-reason' }),
        conceal: async (_context, _identities, _candidate, _mutation, input) => {
          expect(input).toMatchObject({ authorized: false, subject: { kind: 'request-target' } });
          return { allowed: false, problem: code };
        },
      },
    });

    expect(result).toEqual(rejected(code));
    expect(JSON.stringify(result)).not.toMatch(/read.?only|secret|target|principal/iu);
    expect(context.resolveNode).not.toHaveBeenCalled();
  });

  it(`permits concealment to hide an otherwise authorized target before graph access [evidence:${evidence}]`, async () => {
    const context = resolver([root({ readOnly: true, reason: 'classified-rule' }), bookmark('target')]);
    const nodeSpy = vi.spyOn(context, 'resolveNode');
    const result = await publish([], {
      context,
      ports: { conceal: async () => ({ allowed: false, problem: 'resource_not_found' }) },
    });

    expect(result).toEqual(rejected('resource_not_found'));
    expect(nodeSpy).not.toHaveBeenCalled();
  });

  it(`authorizes and applies concealment to every subtree participant before policy/read-only evaluation [evidence:${evidence}]`, async () => {
    const subtree = folder('subtree');
    const locked = bookmark('locked-descendant', subtree.id, { readOnly: true, reason: 'legal-hold-947' });
    const authorizedIds: string[] = [];
    const policy = vi.fn(async () => ({ allowed: true as const }));
    const write = vi.fn();
    const result = await publish([root(), subtree, locked], {
      mutation: { kind: 'delete-subtree', nodeId: subtree.id },
      ports: {
        authorize: async (_context, _identities, _candidate, _mutation, subject) => {
          if (subject.kind === 'affected-node') authorizedIds.push(subject.nodeId);
          return subject.kind === 'affected-node' && subject.nodeId === locked.id
            ? { authorized: false, reason: 'participant denied' }
            : { authorized: true };
        },
        conceal: async (_context, _identities, _candidate, _mutation, input) => (
          input.authorized ? { allowed: true } : { allowed: false, problem: 'resource_not_found' }
        ),
        evaluatePolicy: policy,
        write,
      },
    });

    expect(authorizedIds).toEqual([collection.rootNodeId, subtree.id, locked.id]);
    expect(result).toEqual(rejected('resource_not_found'));
    expect(policy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/locked-descendant|legal-hold|participant/iu);
  });

  it(`returns node_read_only only after every subtree participant is authorized and visible [evidence:${evidence}]`, async () => {
    const subtree = folder('subtree');
    const locked = bookmark('locked-descendant', subtree.id, { readOnly: true });
    const authorizedIds: string[] = [];
    const result = await publish([root(), subtree, locked], {
      mutation: { kind: 'delete-subtree', nodeId: subtree.id },
      ports: {
        authorize: async (_context, _identities, _candidate, _mutation, subject) => {
          if (subject.kind === 'affected-node') authorizedIds.push(subject.nodeId);
          return { authorized: true };
        },
      },
    });

    expect(authorizedIds).toEqual([collection.rootNodeId, subtree.id, locked.id]);
    expect(result).toEqual(rejected('node_read_only'));
  });

  it(`keeps operation-policy denial ahead of read-only and maps it to a registered Problem [evidence:${evidence}]`, async () => {
    const result = await publish([root(), bookmark('target', collection.rootNodeId, { readOnly: true })], {
      ports: { evaluatePolicy: async () => ({ allowed: false, reason: 'operation policy denied' }) },
    });
    expect(result).toEqual(rejected('insufficient_scope'));
  });

  it(`snapshots caller candidate, mutation, limits, and authoritative rows across async gates [evidence:${evidence}]`, async () => {
    const candidate = { principal: 'publisher-key:alice', body: { title: 'Before' } };
    const mutation: { kind: 'update-node'; nodeId: string } = { kind: 'update-node', nodeId: 'target' };
    const locked = bookmark('target', collection.rootNodeId, { readOnly: true, reason: 'transaction-lock' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => { started = resolve; });
    const operation = publish([root(), locked], {
      candidate,
      mutation,
      ports: {
        authorize: async (_context, _identities, _candidate, _mutation, subject) => {
          if (subject.kind === 'affected-node') { started(); await gate; }
          return { authorized: true };
        },
      },
    });

    await authorizationStarted;
    candidate.principal = 'attacker';
    candidate.body.title = 'After';
    mutation.nodeId = 'other-node';
    (locked as { constraints?: StrictNode['constraints'] }).constraints = { readOnly: false };
    release();

    await expect(operation).resolves.toEqual(rejected('node_read_only'));
  });

  it(`uses one transaction context for security, authoritative reads, and persistence [evidence:${evidence}]`, async () => {
    const context = resolver([root(), bookmark('target')]);
    const seen: NodeWriteResolver[] = [];
    let runCalls = 0;
    const run: Ports['unitOfWork']['run'] = async <T>(work: (value: NodeWriteResolver) => Promise<T>) => {
      runCalls += 1;
      return work(context);
    };
    const result = await publish([], {
      context,
      ports: {
        unitOfWork: { run },
        authenticate: async (value) => { seen.push(value); return {
          authenticated: true,
          identityResolution: { status: 'authenticated', identities: [{ type: 'user', id: 'alice' }] },
        }; },
        authorize: async (value) => { seen.push(value); return { authorized: true }; },
        conceal: async (value) => { seen.push(value); return { allowed: true }; },
        validate: async (value) => { seen.push(value); return { allowed: true }; },
        evaluatePolicy: async (value) => { seen.push(value); return { allowed: true }; },
        write: async (value, candidate, plan) => {
          seen.push(value);
          return {
            result: { title: candidate.body.title, nodeId: plan.modifiedNodeIds[0]! },
            modifiedNodeIds: plan.modifiedNodeIds,
            deletedNodeIds: plan.deletedNodeIds,
            deletedNodeCount: plan.deletedNodeCount,
          };
        },
      },
    });

    expect(result.state).toBe('committed');
    expect(runCalls).toBe(1);
    expect(seen.length).toBeGreaterThan(6);
    expect(seen.every((value) => value === context)).toBe(true);
  });

  it(`fails closed on malformed, thenable, Proxy, accessor, rejected, and detached UnitOfWork ports [evidence:${evidence}]`, async () => {
    const nodes = [root(), bookmark('target', collection.rootNodeId, { readOnly: true })];
    const write = vi.fn();
    let detachedWork: Promise<PromiseSettledResult<Result>[]> | undefined;
    const cases: Array<Partial<Ports>> = [
      { authenticate: (() => ({ then: () => undefined })) as never },
      { authorize: new Proxy(async () => ({ authorized: true as const }), {}) },
      { authorize: async () => new Proxy({ authorized: true }, {}) },
      { conceal: async () => ({ allowed: false, problem: 'node_read_only' }) as never },
      { validate: async () => { throw new Error('secret-validation-failure'); } },
      { unitOfWork: { run: (() => Promise.reject(new Error('secret-rollback'))) as never } },
      { unitOfWork: { run: ((work: (context: NodeWriteResolver) => Promise<Result>) => {
        // Observe the deliberately detached callback without changing the
        // malformed adapter's early return or swallowing its rollback signal.
        detachedWork = Promise.allSettled([Promise.resolve().then(() => work(resolver(nodes)))]);
        return Promise.resolve(rejected('resource_not_found'));
      }) as never } },
      { unitOfWork: { async run(work) { return work(new Proxy(resolver(nodes), {})); } } },
    ];

    for (const ports of cases) {
      const result = await publish(nodes, { ports: { ...ports, write } });
      expect(result).toEqual(rejected('internal_error'));
      expect(JSON.stringify(result)).not.toMatch(/secret|rollback|validation|read.?only/iu);
    }
    const accessorPorts = makePorts(resolver(nodes), { write });
    Object.defineProperty(accessorPorts, 'authorize', {
      enumerable: true,
      get: () => async () => ({ authorized: true }),
    });
    await expect(executePublisherGuardedNodeWrite(
      { principal: 'publisher-key:alice', body: { title: 'Updated' } },
      { kind: 'update-node', nodeId: 'target' },
      accessorPorts,
    )).resolves.toEqual(rejected('internal_error'));
    await expect(executePublisherGuardedNodeWrite(
      { principal: 'publisher-key:alice', body: { title: 'Updated' } },
      { kind: 'update-node', nodeId: 'target' },
      new Proxy(makePorts(resolver(nodes), { write }), {}),
    )).resolves.toEqual(rejected('internal_error'));
    expect(await detachedWork).toEqual([{ status: 'rejected', reason: expect.any(Error) }]);
    expect(write).not.toHaveBeenCalled();
  });

  it(`fails closed on malformed authoritative resolver outputs without leaking internal IDs [evidence:${evidence}]`, async () => {
    const base = resolver([root(), bookmark('target')]);
    const contexts: NodeWriteResolver[] = [
      { ...base, resolveNode: (() => ({ then: () => undefined })) as never },
      { ...base, resolveNode: async () => new Proxy(bookmark('sensitive-node-947'), {}) },
      { ...base, resolveCollection: async () => ({ id: collection.id, rootNodeId: '' }) },
    ];
    for (const context of contexts) {
      const result = await publish([], { context });
      expect(result.state).toBe('rejected');
      if (result.state !== 'rejected') throw new Error('Expected malformed resolver rejection.');
      expect(['internal_error', 'resource_not_found']).toContain(result.code);
      expect(JSON.stringify(result)).not.toMatch(/sensitive-node|collection-publish/iu);
    }
  });

  it(`isolates concurrent concealment outcomes and never cross-contaminates denial state [evidence:${evidence}]`, async () => {
    const subtree = folder('subtree');
    const locked = bookmark('locked-descendant', subtree.id, { readOnly: true });
    const run = (problem: 'insufficient_scope' | 'resource_not_found') => publish([root(), subtree, locked], {
      mutation: { kind: 'delete-subtree', nodeId: subtree.id },
      ports: {
        authorize: async (_context, _identities, _candidate, _mutation, subject) => (
          subject.kind === 'affected-node' && subject.nodeId === locked.id
            ? { authorized: false, reason: 'denied' }
            : { authorized: true }
        ),
        conceal: async (_context, _identities, _candidate, _mutation, input) => {
          await Promise.resolve();
          return input.authorized ? { allowed: true } : { allowed: false, problem };
        },
      },
    });

    const [visible, hidden] = await Promise.all([run('insufficient_scope'), run('resource_not_found')]);
    expect(visible).toEqual(rejected('insufficient_scope'));
    expect(hidden).toEqual(rejected('resource_not_found'));
  });

  it(`does not expose denial reason, Node/Collection identity, constraint source, principal, or candidate [evidence:${evidence}]`, async () => {
    const result = await publish([
      root(),
      bookmark('sensitive-node-947', collection.rootNodeId, {
        readOnly: true,
        reason: 'embargo-case-947-principal-alice',
      }),
    ], {
      candidate: { principal: 'alice-private-identity', body: { title: 'classified-title' } },
      mutation: { kind: 'update-node', nodeId: 'sensitive-node-947' },
    });
    const wire = JSON.stringify(result);

    expect(result).toEqual(rejected('node_read_only'));
    expect(wire).not.toMatch(/embargo|sensitive|collection-publish|alice|classified|explicit|ancestor|reason|source/iu);
  });

  it(`retains registered Core Problem mapping compatibility and rejects unknown short codes [evidence:${evidence}]`, () => {
    expect(problemRegistry.node_read_only).toEqual({ status: 403, retryable: false });
    expect(mapNodeWriteDenialToProblem(
      { code: 'authorization_denied' },
      { authorizationFailure: 'resource_not_found' },
    )).toEqual({ code: 'resource_not_found', ...problemRegistry.resource_not_found });
    expect(() => mapNodeWriteDenialToProblem(
      { code: 'unregistered_short_code' as never },
      { authorizationFailure: 'insufficient_scope' },
    )).toThrow();
  });
});
