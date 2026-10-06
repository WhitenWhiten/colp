import { describe, expect, it, vi } from 'vitest';
import {
  executePublisherNodeDelete, executePublisherNodeMove, executePublisherOrdinaryNodeCreate,
} from '../../src/publisher/index.js';

type Data = Record<string, unknown>;
const operations = [
  { action: 'create', invoke: (request: unknown, ports: unknown) =>
    executePublisherOrdinaryNodeCreate(request as never, ports as never), error: 'internal_error' },
  { action: 'move', invoke: (request: unknown, ports: unknown) =>
    executePublisherNodeMove(request as never, ports as never), error: 'internal_error' },
  { action: 'delete', invoke: (request: unknown, ports: unknown) =>
    executePublisherNodeDelete(request as never, ports as never), error: 'invalid_document' },
] as const;

function request(action: 'create' | 'move' | 'delete'): Data {
  const operation = { operationId: 'op-1', replicaId: 'publisher', sequence: 1,
    occurredAt: '2026-09-25T00:00:00Z', collectionId: 'collection-1', action,
    baseRevision: action === 'create' ? null : 'revision-1',
    ...(action === 'create' ? {} : { targetId: 'node-1' }),
    payload: action === 'create'
      ? { parentId: 'root-1', node: { kind: 'bookmark', title: 'Created', url: 'https://example.test/' } }
      : action === 'move'
        ? { newParentId: 'parent-2', baseSourceParentRevision: 'children-1', baseTargetParentRevision: 'children-2' }
        : { reason: 'Deleted' },
  };
  return action === 'create' ? { nodeId: 'new-node', operation }
    : { operation, ifMatch: '"revision-1"', ...(action === 'delete' ? { query: {} } : {}) };
}

function host() {
  const applyOperations = vi.fn(async () => { throw new Error('must not apply'); });
  const authenticate = vi.fn(async () => ({ authenticated: false as const }));
  const run = vi.fn(async (work: (context: unknown) => Promise<unknown>) => work({
    resolveCollection: async () => undefined, resolveNode: async () => undefined,
    resolveChildren: async () => ({ nodes: [], hasMore: false }),
  }));
  return { unitOfWork: { run }, application: { applyOperations }, authenticate,
    authorize: async () => ({ authorized: true }),
    authorizeRequiredScope: async () => ({ authorized: true }),
    conceal: async () => ({ allowed: true }), validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
  };
}

const malformed: Array<[string, (value: Data) => unknown]> = [
  ['extra envelope field', value => ({ ...value, unexpected: true })],
  ['missing operation', value => { delete value.operation; return value; }],
  ['wrong action', value => { (value.operation as Data).action = 'unrecognized'; return value; }],
  ['invalid payload', value => { (value.operation as Data).payload = { unknown: true }; return value; }],
  ['invalid conditional header', value => ({ ...value, ifMatch: [42] })],
  ['hidden property', value => Object.defineProperty(value, 'hidden', { value: true })],
  ['symbol property', value => Object.assign(value, { [Symbol('wire')]: true })],
  ['non-data object', value => { (value.operation as Data).source = new Date(); return value; }],
  ['sparse array', value => { (value.operation as Data).dependencies = new Array(1); return value; }],
  ['array extra property', value => {
    (value.operation as Data).dependencies = Object.assign(['op-0'], { extra: true }); return value;
  }],
  ['array subclass', value => {
    class Dependencies extends Array<string> {}
    (value.operation as Data).dependencies = new Dependencies('op-0'); return value;
  }],
  ['non-data primitive', value => { (value.operation as Data).source = () => true; return value; }],
  ['cycle', value => { (value.operation as Data).source = value; return value; }],
  ['nested proxy', value => { (value.operation as Data).source = new Proxy({}, {}); return value; }],
];

describe.each(operations)('Publisher $action request boundary', ({ action, invoke, error }) => {
  it('admits a valid envelope to authentication without applying a mutation', async () => {
    const ports = host();
    await expect(invoke(request(action), ports)).resolves.toMatchObject({ state: 'rejected', code: 'authentication_required' });
    expect(ports.unitOfWork.run).toHaveBeenCalledTimes(1);
    expect(ports.authenticate).toHaveBeenCalledTimes(1);
    expect(ports.application.applyOperations).not.toHaveBeenCalled();
  });

  it.each(malformed)('rejects %s before transaction admission', async (_name, change) => {
    const ports = host();
    await expect(invoke(change(request(action)), ports)).resolves.toMatchObject({ state: 'rejected', code: error });
    expect(ports.unitOfWork.run).not.toHaveBeenCalled();
    expect(ports.authenticate).not.toHaveBeenCalled();
    expect(ports.application.applyOperations).not.toHaveBeenCalled();
  });

  it('rejects a getter without evaluating user code', async () => {
    const value = request(action);
    const getter = vi.fn(() => 'secret');
    Object.defineProperty(value.operation, 'source', { enumerable: true, get: getter });
    const ports = host();
    await expect(invoke(value, ports)).resolves.toMatchObject({ state: 'rejected', code: error });
    expect(getter).not.toHaveBeenCalled();
    expect(ports.unitOfWork.run).not.toHaveBeenCalled();
  });

  it('rejects a non-callable application port before transaction admission', async () => {
    const ports = host();
    const malformedPorts = { ...ports, application: { applyOperations: 42 } };
    await expect(invoke(request(action), malformedPorts)).resolves.toMatchObject({ state: 'rejected', code: 'internal_error' });
    expect(ports.unitOfWork.run).not.toHaveBeenCalled();
  });
});
