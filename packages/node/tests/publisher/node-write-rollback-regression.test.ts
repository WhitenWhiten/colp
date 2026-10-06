import { describe, expect, it } from 'vitest';

import {
  executePublisherGuardedNodeWrite,
  type PublisherGuardedNodeWritePorts,
} from '../../src/publisher/node-write.js';
import { NodeWriteGuardError, type NodeWriteResolver } from '../../src/server/node-write-guard.js';
import type { StrictNode } from '../../src/types/index.js';

const timestamp = '2026-07-19T00:00:00Z';
const collection = { id: 'collection-rollback', rootNodeId: 'root-rollback' };
const root: StrictNode = {
  id: collection.rootNodeId, collectionId: collection.id, kind: 'root', parentId: null,
  position: null, folderRole: 'root', title: 'Root', revision: 'root-v1',
  createdAt: timestamp, updatedAt: timestamp,
};
const target: StrictNode = {
  id: 'target-rollback', collectionId: collection.id, kind: 'bookmark', parentId: root.id,
  position: 'a', title: 'Before', url: 'https://example.test/', revision: 'node-v1',
  createdAt: timestamp, updatedAt: timestamp,
};

type Failure = 'none' | 'extra-node' | 'wrong-count' | 'typed-writer-error' | 'storage-error';
interface State { title: string; audit: string[]; outbox: string[] }
interface Transaction extends NodeWriteResolver { readonly draft: State }
type Ports = PublisherGuardedNodeWritePorts<Transaction, { title: string }, string>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(failure: Failure, rollbackBarrier?: { reached: () => void; release: Promise<void> }) {
  let durable: State = { title: 'Before', audit: [], outbox: [] };
  const counters = { committed: 0, rolledBack: 0, writes: 0 };
  const ports: Ports = {
    unitOfWork: {
      async run(work) {
        const draft = structuredClone(durable);
        const context: Transaction = {
          draft,
          resolveCollection: async (id) => id === collection.id ? collection : undefined,
          resolveNode: async (id) => id === root.id ? root : id === target.id ? target : undefined,
          resolveChildren: async () => ({ nodes: [], hasMore: false }),
        };
        try {
          const result = await work(context);
          durable = draft;
          counters.committed += 1;
          return result;
        } catch (error) {
          counters.rolledBack += 1;
          rollbackBarrier?.reached();
          if (rollbackBarrier !== undefined) await rollbackBarrier.release;
          throw error;
        }
      },
    },
    authenticate: async () => ({ authenticated: true, identityResolution: {
      status: 'authenticated', identities: [{ type: 'user', id: 'alice' }],
    } }),
    authorize: async () => ({ authorized: true }),
    conceal: async (_context, _identities, _candidate, _mutation, input) => input.authorized
      ? { allowed: true } : { allowed: false, problem: 'resource_not_found' },
    validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
    write: async (transaction, candidate, plan) => {
      counters.writes += 1;
      transaction.draft.title = candidate.title;
      transaction.draft.audit.push('node-updated');
      transaction.draft.outbox.push('node-updated');
      if (failure === 'typed-writer-error') {
        throw new NodeWriteGuardError({ allowed: false, code: 'node_policy_denied', reason: 'late denial' });
      }
      if (failure === 'storage-error') throw new Error('write failed');
      return {
        result: candidate.title,
        modifiedNodeIds: failure === 'extra-node' ? [...plan.modifiedNodeIds, 'unauthorized'] : plan.modifiedNodeIds,
        deletedNodeIds: plan.deletedNodeIds,
        deletedNodeCount: failure === 'wrong-count' ? 1 : plan.deletedNodeCount,
      };
    },
  };
  return {
    ports, counters, snapshot: () => structuredClone(durable),
    run: () => executePublisherGuardedNodeWrite(
      { title: 'After' }, { kind: 'update-node', nodeId: target.id }, ports,
    ),
  };
}

describe('Publisher rejects only after rolling back staged writes [evidence:publisher.node-read-only-concealment]', () => {
  it.each(['extra-node', 'wrong-count', 'storage-error'] as const)(
    'rolls back business, audit and outbox state after %s', async (failure) => {
      const fixture = harness(failure);
      const before = fixture.snapshot();
      await expect(fixture.run()).resolves.toMatchObject({ state: 'rejected', code: 'internal_error' });
      expect(fixture.counters).toEqual({ committed: 0, rolledBack: 1, writes: 1 });
      expect(fixture.snapshot()).toEqual(before);
    },
  );

  it('also rolls back typed writer denials instead of committing a rejected envelope', async () => {
    const fixture = harness('typed-writer-error');
    const before = fixture.snapshot();
    await expect(fixture.run()).resolves.toMatchObject({ state: 'rejected', code: 'insufficient_scope' });
    expect(fixture.counters).toEqual({ committed: 0, rolledBack: 1, writes: 1 });
    expect(fixture.snapshot()).toEqual(before);
  });

  it('does not resolve the HTTP outcome before rollback finishes', async () => {
    const reached = deferred();
    const release = deferred();
    const fixture = harness('extra-node', { reached: reached.resolve, release: release.promise });
    let settled = false;
    const pending = fixture.run().then((result) => { settled = true; return result; });
    try {
      const first = await Promise.race([reached.promise.then(() => 'rollback'), pending.then(() => 'response')]);
      expect(first).toBe('rollback');
      expect(settled).toBe(false);
      expect(fixture.snapshot()).toEqual({ title: 'Before', audit: [], outbox: [] });
    } finally {
      release.resolve();
    }
    await expect(pending).resolves.toMatchObject({ state: 'rejected', code: 'internal_error' });
  });

  it('preserves concealment and never invokes the writer after affected-node denial', async () => {
    const fixture = harness('none');
    fixture.ports.authorize = async (_context, _identities, _candidate, _mutation, subject) =>
      subject.kind === 'affected-node' ? { authorized: false, reason: 'private' } : { authorized: true };
    await expect(fixture.run()).resolves.toMatchObject({ state: 'rejected', code: 'resource_not_found' });
    expect(fixture.counters).toEqual({ committed: 0, rolledBack: 1, writes: 0 });
  });

  it('commits a valid writer result exactly once', async () => {
    const fixture = harness('none');
    await expect(fixture.run()).resolves.toEqual({ state: 'committed', value: 'After' });
    expect(fixture.counters).toEqual({ committed: 1, rolledBack: 0, writes: 1 });
    expect(fixture.snapshot()).toEqual({ title: 'After', audit: ['node-updated'], outbox: ['node-updated'] });
  });
});
