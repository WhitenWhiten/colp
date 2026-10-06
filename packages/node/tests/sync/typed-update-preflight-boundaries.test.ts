import { describe, expect, it, vi } from 'vitest';

import type { Operation } from '../../src/types/index.js';
import {
  applySyncTypedUpdatePatch,
  createTypedUpdateMergePushPreflight,
  mergeSyncTypedUpdate,
  type PushPreflightContext,
  type PushTransactionOperation,
} from '../../src/sync/index.js';
import {
  plan,
  type Audit,
  type Conflict,
  type Outbox,
  type TestTransaction,
} from './push-transaction-harness.js';

/**
 * Guard-level evidence for createTypedUpdateMergePushPreflight: index domain,
 * handler contract, evaluation-context threading, atomic same-target
 * projection rules, and host projection validation.
 */
const evidence = '[evidence:sync.batch]';

const timestamp = '2026-07-18T00:00:00Z';
type DataObject = Readonly<Record<string, unknown>>;

function typedUpdateItem(overrides: {
  readonly opId?: string;
  readonly targetId?: string;
  readonly base?: unknown;
  readonly value?: unknown;
} = {}): PushTransactionOperation {
  const opId = overrides.opId ?? 'operation-typed-1';
  return {
    sequenceScope: 'collection-1',
    digest: `digest-${opId}`,
    operation: {
      opId,
      replicaId: 'replica-1',
      sequence: 1,
      type: 'update_node_content',
      occurredAt: timestamp,
      collectionId: 'collection-1',
      targetId: overrides.targetId ?? 'node-1',
      baseRevision: 'revision-1',
      payload: {
        base: overrides.base ?? { title: 'Before' },
        value: overrides.value ?? { title: 'After' },
      },
    } as Operation,
  };
}

function deleteItem(opId = 'operation-delete-1', targetId = 'node-1'): PushTransactionOperation {
  return {
    sequenceScope: 'collection-1',
    digest: `digest-${opId}`,
    operation: {
      opId,
      replicaId: 'replica-1',
      sequence: 2,
      type: 'delete_node',
      occurredAt: timestamp,
      collectionId: 'collection-1',
      targetId,
      baseRevision: 'revision-1',
      payload: {},
    } as Operation,
  };
}

// Default server projection matches the default operation base so merges are clean.
function trackingHandlers(current: DataObject = { title: 'Before' }) {
  return {
    loadCurrent: vi.fn(async (..._args: unknown[]) => current),
    planMerged: vi.fn(async (..._args: unknown[]) => plan('applied', 1)),
    planConflict: vi.fn(async (..._args: unknown[]) => plan('conflicted', 1)),
    planOther: vi.fn(async (...args: unknown[]) => plan('applied', args[1] as number)),
  };
}

describe(`typed-update merge preflight boundaries ${evidence}`, () => {
  describe('index domain', () => {
    it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '0'])(
      'rejects invalid batch index %j',
      async (index) => {
        const preflight = createTypedUpdateMergePushPreflight<
          TestTransaction, Conflict, Audit, Outbox
        >(trackingHandlers());
        await expect(preflight(typedUpdateItem(), index as never))
          .rejects.toThrow(/non-negative safe integer/);
      },
    );

    it('accepts the smallest and largest safe integer indexes', async () => {
      const preflight = createTypedUpdateMergePushPreflight<
        TestTransaction, Conflict, Audit, Outbox
      >(trackingHandlers());
      await expect(preflight(typedUpdateItem(), 0)).resolves.toMatchObject({ status: 'applied' });
      await expect(preflight(typedUpdateItem(), Number.MAX_SAFE_INTEGER))
        .resolves.toMatchObject({ status: 'applied' });
    });
  });

  describe('handler contract', () => {
    it.each([null, [], 'handlers', 42])('rejects non-plain handlers %j', (handlers) => {
      expect(() => createTypedUpdateMergePushPreflight(handlers as never))
        .toThrow(/must be a plain object/);
    });

    it.each(['loadCurrent', 'planMerged', 'planConflict', 'planOther'] as const)(
      'requires a %s function',
      (name) => {
        const handlers = { ...trackingHandlers(), [name]: 42 };
        expect(() => createTypedUpdateMergePushPreflight(handlers as never))
          .toThrow(new RegExp(`${name} must be a function`));
      },
    );
  });

  describe('evaluation context threading', () => {
    it('passes no context argument when the caller supplied none', async () => {
      const handlers = trackingHandlers();
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      await preflight(typedUpdateItem(), 0);
      await preflight(deleteItem(), 3);
      expect(handlers.planMerged.mock.calls[0]).toHaveLength(1);
      expect(handlers.planOther.mock.calls[0]).toHaveLength(2);
    });

    it('hands a frozen empty context when the caller supplied one', async () => {
      const handlers = trackingHandlers();
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      await preflight(typedUpdateItem(), 0, {});
      const context = handlers.planMerged.mock.calls[0]![1] as Record<string, unknown>;
      expect(context).toEqual({});
      expect(Object.isFrozen(context)).toBe(true);
      expect('previousDeferredReceipt' in context).toBe(false);
      expect('atomicBatch' in context).toBe(false);
    });

    it('threads the deferred receipt as an immutable snapshot and the batch by identity', async () => {
      const handlers = trackingHandlers();
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      const atomicBatch = { marker: 'batch-1' };
      const receipt = {
        operationId: 'operation-deferred-1',
        replicaId: 'replica-1',
        sequenceScope: 'collection-1',
        sequence: 9,
        result: { opId: 'operation-deferred-1', sequence: 9, status: 'deferred', warnings: [] },
        cursor: 'cursor-9',
      };
      await preflight(typedUpdateItem(), 0, { atomicBatch, previousDeferredReceipt: receipt as never });

      const context = handlers.planMerged.mock.calls[0]![1] as PushPreflightContext;
      expect(context.atomicBatch).toBe(atomicBatch);
      expect(context.previousDeferredReceipt).toEqual(receipt);
      expect(context.previousDeferredReceipt).not.toBe(receipt);
      expect(Object.isFrozen(context.previousDeferredReceipt)).toBe(true);
      expect(Object.isFrozen(context.previousDeferredReceipt!.result)).toBe(true);
    });

    it('rejects a deferred receipt that is not plain JSON', async () => {
      const handlers = trackingHandlers();
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      await expect(preflight(typedUpdateItem(), 0, {
        previousDeferredReceipt: { result: { revive: () => ({}) } } as never,
      })).rejects.toThrow(/plain JSON/);
    });
  });

  describe('atomic same-target projection guard', () => {
    it('rejects a typed update after a non-projectable operation on the same atomic target', async () => {
      const handlers = trackingHandlers();
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      const context: PushPreflightContext = { atomicBatch: {} };
      await preflight(deleteItem('op-delete', 'node-1'), 0, context);
      await expect(preflight(typedUpdateItem({ targetId: 'node-1' }), 1, context))
        .rejects.toThrow(/host-provided projected preflight/);
    });

    it('rejects a non-typed operation after a projected update on the same atomic target', async () => {
      const handlers = trackingHandlers();
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      const context: PushPreflightContext = { atomicBatch: {} };
      await preflight(typedUpdateItem({ targetId: 'node-1' }), 0, context);
      await expect(preflight(deleteItem('op-delete', 'node-1'), 1, context))
        .rejects.toThrow(/host-provided projected preflight/);
    });

    it('does not project across different atomic batch identities', async () => {
      const handlers = trackingHandlers();
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      await preflight(deleteItem('op-delete', 'node-1'), 0, { atomicBatch: {} });
      const planResult = await preflight(
        typedUpdateItem({ targetId: 'node-1' }), 1, { atomicBatch: {} },
      );
      expect(planResult.status).toBe('applied');
      expect(handlers.loadCurrent).toHaveBeenCalledTimes(1);
    });
  });

  describe('request-local projection updates', () => {
    async function chainedUpdates(
      planStatus: 'applied' | 'rebased' | 'noop',
      secondBase: DataObject,
    ) {
      const mergedContexts: Array<{ current: unknown; merged: unknown }> = [];
      const stale = { tags: [] as string[] };
      const handlers = {
        loadCurrent: vi.fn(async () => stale),
        planMerged: vi.fn(async (context: { current: unknown; merged: unknown }) => {
          mergedContexts.push(context);
          return plan(planStatus, 1);
        }),
        planConflict: vi.fn(async () => plan('conflicted', 1)),
        planOther: vi.fn(async (_item: PushTransactionOperation, index: number) => plan('applied', index)),
      };
      const preflight = createTypedUpdateMergePushPreflight<
        TestTransaction, Conflict, Audit, Outbox
      >(handlers);
      const context: PushPreflightContext = { atomicBatch: {} };
      await preflight(typedUpdateItem({ base: { tags: [] }, value: { tags: ['a'] } }), 0, context);
      await preflight(
        typedUpdateItem({ base: secondBase, value: { tags: ['a', 'b'] } }), 1, context,
      );
      return { mergedContexts, stale };
    }

    it.each(['applied', 'rebased'] as const)(
      'carries the merged projection into the next same-target update after %s',
      async (planStatus) => {
        const { mergedContexts, stale } = await chainedUpdates(planStatus, { tags: ['a'] });
        const firstMerge = mergeSyncTypedUpdate({
          base: { tags: [] }, current: stale, incoming: { tags: ['a'] },
        });
        if (firstMerge.status !== 'merged') throw new Error('expected merged oracle');
        const projected = applySyncTypedUpdatePatch(stale, firstMerge.value);
        expect(mergedContexts[0]!.current).toEqual(stale);
        expect(mergedContexts[1]!.current).toEqual(projected);
        expect(mergedContexts[1]!.merged).toEqual({ tags: ['a', 'b'] });
      },
    );

    it('reloads the current projection when the previous plan did not land', async () => {
      const { mergedContexts, stale } = await chainedUpdates('noop', { tags: [] });
      expect(mergedContexts[1]!.current).toEqual(stale);
      expect(mergedContexts[1]!.current).not.toEqual({ tags: ['a'] });
    });
  });

  describe('host projection validation', () => {
    it.each([['an array', []], ['a string', 'value'], ['a number', 42], ['null', null]])(
      'rejects %s current projection',
      async (_label, current) => {
        const handlers = {
          ...trackingHandlers(),
          loadCurrent: vi.fn(async () => current as never),
        };
        const preflight = createTypedUpdateMergePushPreflight(handlers);
        await expect(preflight(typedUpdateItem(), 0))
          .rejects.toThrow(/current must be a plain object/);
      },
    );

    it('rejects a current projection with a custom prototype', async () => {
      const handlers = {
        ...trackingHandlers(),
        loadCurrent: vi.fn(async () => Object.assign(Object.create({ inherited: true }), { a: 1 })),
      };
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      await expect(preflight(typedUpdateItem(), 0))
        .rejects.toThrow(/plain or null prototype/);
    });

    it('accepts a null-prototype current projection', async () => {
      const handlers = {
        ...trackingHandlers(),
        loadCurrent: vi.fn(async () => Object.assign(Object.create(null), { title: 'Before' })),
      };
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      await expect(preflight(typedUpdateItem(), 0)).resolves.toMatchObject({ status: 'applied' });
    });

    it.each([
      ['symbol', (() => {
        const projection: Record<PropertyKey, unknown> = { title: 'Before' };
        projection[Symbol('tag')] = 1;
        return projection;
      })()],
      ['accessor', Object.defineProperty({ title: 'Before' }, 'extra', {
        enumerable: true, get: () => 1,
      })],
      ['non-enumerable', Object.defineProperty({ title: 'Before' }, 'hidden', {
        enumerable: false, value: 1,
      })],
    ])('rejects a current projection with a %s member', async (_label, current) => {
      const handlers = {
        ...trackingHandlers(),
        loadCurrent: vi.fn(async () => current as never),
      };
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      await expect(preflight(typedUpdateItem(), 0))
        .rejects.toThrow(/symbol keys|data properties/);
    });

    it.each([['a plain value', () => ({})], ['a scalar', () => 42]])(
      'rejects a loadCurrent returning %s instead of a Promise',
      async (_label, loadCurrent) => {
        const handlers = {
          ...trackingHandlers(),
          loadCurrent: vi.fn(loadCurrent as (...args: unknown[]) => Promise<never>),
        };
        const preflight = createTypedUpdateMergePushPreflight(handlers);
        await expect(preflight(typedUpdateItem(), 0))
          .rejects.toThrow(/loadCurrent must return a Promise/);
      },
    );
  });
});
