/**
 * COLP-MCP-11: Modern MCP 2026-07-28 subscriptions/listen lifecycle bounds.
 *
 * Continuation of mcp-2026-07-28-subscriptions-listen-contract.test.ts:
 * authorization recheck teardown, bounded queue/rate/lifetime/notification
 * budgets, host receiver capture, abort/cleanup determinism and the
 * no-replay re-read contract. Shared fixtures live in
 * subscriptions-listen-harness.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { SUBSCRIPTION_ID_META_KEY } from '../../src/mcp/2026-07-28/sdk-boundary.js';
import {
  createMcp20260728SubscriptionsListenAdapter,
  type Mcp20260728SubscriptionsListenSession,
} from '../../src/mcp/2026-07-28/subscriptions.js';
import type { McpChangeSignalListener } from '../../src/mcp/shared/change-signal.js';
import {
  capabilities,
  harness,
  openSession,
  readAll,
  take,
} from './subscriptions-listen-harness.js';

describe('MCP 2026-07-28 subscriptions/listen: authorization recheck', () => {
  it('ends the stream without delivering when authorization is revoked', async () => {
    let authorized = true;
    const { adapter, memory } = harness({ authorization: { isAuthorized: () => authorized } });
    const session = openSession(adapter, { toolsListChanged: true });
    memory.publish({ type: 'tool-list-changed' });
    expect(await take(session, 1)).toHaveLength(1);
    authorized = false;
    memory.publish({ type: 'tool-list-changed' });
    const teardown = await session.closed;
    expect(teardown.reason).toBe('unauthorized');
    expect(teardown.graceful).toBe(false);
    expect(memory.listenerCount()).toBe(0);
  });

  it('discards already queued notifications when authorization is revoked', async () => {
    let authorized = true;
    const { adapter, memory } = harness({
      authorization: { isAuthorized: () => authorized },
      maxQueueSize: 10,
    });
    const session = openSession(adapter, { toolsListChanged: true });
    memory.publish({ type: 'tool-list-changed' });
    memory.publish({ type: 'tool-list-changed' });
    authorized = false;
    expect(await readAll(session)).toEqual([]);
    const teardown = await session.closed;
    expect(teardown.reason).toBe('unauthorized');
    expect(memory.listenerCount()).toBe(0);
  });

  it('treats a denied recheck at listen start as a host bug', () => {
    const { adapter, memory } = harness({ authorization: { isAuthorized: () => false } });
    expect(() => openSession(adapter, {})).toThrow(TypeError);
    expect(memory.listenerCount()).toBe(0);
  });
});

describe('MCP 2026-07-28 subscriptions/listen: bounded queue, rate, lifetime, budget', () => {
  it.each([2_147_483_646, 2_147_483_647])('honors supported long lifetime %s without timer overflow', async maxLifetimeMs => {
    vi.useFakeTimers();
    try {
      const { adapter, memory } = harness({ maxLifetimeMs });
      const session = openSession(adapter, { toolsListChanged: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(memory.listenerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(maxLifetimeMs - 1);
      expect((await session.closed).reason).toBe('lifetime-expired');
      expect(memory.listenerCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each([2_147_483_648, Number.MAX_SAFE_INTEGER])('rejects an overflowing lifetime %s at construction', maxLifetimeMs => {
    expect(() => harness({ maxLifetimeMs })).toThrow(RangeError);
    expect(() => harness({ maxLifetimeMs })).toThrow('maxLifetimeMs must not exceed 2147483647');
  });

  it('bounds the queue for a slow consumer and counts overflow', async () => {
    const { adapter, memory } = harness({ maxQueueSize: 4 });
    const session = openSession(adapter, { toolsListChanged: true });
    for (let index = 0; index < 10; index += 1) memory.publish({ type: 'tool-list-changed' });
    session.close();
    const teardown = await session.closed;
    expect(teardown.received).toBe(10);
    expect(teardown.delivered).toBe(4);
    expect(teardown.overflow).toBe(6);
    expect(await readAll(session)).toHaveLength(4);
  });

  it('rate-limits notification delivery within a window', async () => {
    const { adapter, memory } = harness({ maxRatePerWindow: 2, rateWindowMs: 60_000 });
    const session = openSession(adapter, { toolsListChanged: true });
    for (let index = 0; index < 5; index += 1) memory.publish({ type: 'tool-list-changed' });
    session.close();
    const teardown = await session.closed;
    expect(teardown.received).toBe(5);
    expect(teardown.delivered).toBe(2);
    expect(teardown.rateLimited).toBe(3);
    expect(await readAll(session)).toHaveLength(2);
  });

  it('resets the rate window once it elapses', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, memory } = harness({ maxRatePerWindow: 2, rateWindowMs: 1_000 });
      const session = openSession(adapter, { toolsListChanged: true });
      memory.publish({ type: 'tool-list-changed' });
      memory.publish({ type: 'tool-list-changed' });
      await vi.advanceTimersByTimeAsync(1_000);
      memory.publish({ type: 'tool-list-changed' });
      memory.publish({ type: 'tool-list-changed' });
      session.close();
      const teardown = await session.closed;
      expect(teardown.delivered).toBe(4);
      expect(teardown.rateLimited).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the session when the notification budget is exhausted', async () => {
    const { adapter, memory } = harness({ maxNotifications: 2 });
    const session = openSession(adapter, { toolsListChanged: true });
    memory.publish({ type: 'tool-list-changed' });
    memory.publish({ type: 'tool-list-changed' });
    memory.publish({ type: 'tool-list-changed' });
    const teardown = await session.closed;
    expect(teardown.reason).toBe('notification-budget-exhausted');
    expect(teardown.graceful).toBe(true);
    expect(teardown.delivered).toBe(2);
    expect(memory.listenerCount()).toBe(0);
    expect(await readAll(session)).toHaveLength(2);
  });

  it('ends the session when the lifetime expires', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, memory } = harness({ maxLifetimeMs: 5_000 });
      const session = openSession(adapter, { toolsListChanged: true });
      memory.publish({ type: 'tool-list-changed' });
      await vi.advanceTimersByTimeAsync(5_000);
      const teardown = await session.closed;
      expect(teardown.reason).toBe('lifetime-expired');
      expect(teardown.graceful).toBe(true);
      expect(memory.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MCP host method receivers [C03]', () => {
  it.each(['closure', 'method'] as const)('preserves mutable state and captures functions for %s ports', async mode => {
    vi.useFakeTimers();
    const listeners = new Set<McpChangeSignalListener>();
    const unsubscribe = vi.fn();
    const source = {
      listeners,
      subscribe(listener: McpChangeSignalListener) {
        this.listeners.add(listener);
        return { unsubscribe: () => { this.listeners.delete(listener); unsubscribe(); } };
      },
    };
    if (mode === 'closure') source.subscribe = listener => {
      listeners.add(listener);
      return { unsubscribe: () => { listeners.delete(listener); unsubscribe(); } };
    };
    const auth = { allowed: true, isAuthorized() { return this.allowed; } };
    if (mode === 'closure') auth.isAuthorized = () => auth.allowed;
    const adapter = createMcp20260728SubscriptionsListenAdapter({ signalSource: source, authorization: auth, capabilities });
    // Function identity is captured, while host state remains live.
    source.subscribe = () => { throw new Error('Replacement must not run'); };
    auth.isAuthorized = () => { throw new Error('Replacement must not run'); };
    let session: Mcp20260728SubscriptionsListenSession | undefined;
    try {
      session = openSession(adapter, { toolsListChanged: true });
      expect(listeners.size).toBe(1);
      auth.allowed = false;
      for (const listener of listeners) listener({ type: 'tool-list-changed', sequence: 1, timestamp: Date.now() });
      expect(await session.closed).toMatchObject({ reason: 'unauthorized', graceful: false });
      expect(listeners.size).toBe(0);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { session?.close(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
});

describe('MCP 2026-07-28 subscriptions/listen: abort, cleanup, disconnect/reconnect', () => {
  it('aborts the session and releases its resources', async () => {
    const controller = new AbortController();
    const { adapter, memory } = harness();
    const session = openSession(adapter, { toolsListChanged: true }, { abortSignal: controller.signal });
    expect(memory.listenerCount()).toBe(1);
    controller.abort();
    const teardown = await session.closed;
    expect(teardown.reason).toBe('aborted');
    expect(teardown.graceful).toBe(false);
    expect(memory.listenerCount()).toBe(0);
    expect(await readAll(session)).toEqual([]);
  });

  it('close is idempotent and later signals are ignored', async () => {
    const { adapter, memory } = harness();
    const session = openSession(adapter, { toolsListChanged: true });
    session.close();
    session.close();
    const teardown = await session.closed;
    expect(teardown.reason).toBe('closed');
    expect(teardown.graceful).toBe(true);
    expect(memory.listenerCount()).toBe(0);
    memory.publish({ type: 'tool-list-changed' });
    expect(teardown.received).toBe(0);
    expect(await readAll(session)).toEqual([]);
  });

  it('never replays signals across a disconnect/reconnect', async () => {
    const { adapter, memory } = harness();
    const first = openSession(adapter, { toolsListChanged: true }, {}, 'listen-first');
    memory.publish({ type: 'tool-list-changed' });
    expect(await take(first, 1)).toHaveLength(1);
    first.close();
    await first.closed;
    memory.publish({ type: 'tool-list-changed' });
    const second = openSession(adapter, { toolsListChanged: true }, {}, 'listen-second');
    memory.publish({ type: 'tool-list-changed' });
    const notifications = await take(second, 1);
    expect(notifications).toHaveLength(1);
    expect((notifications[0]!.params._meta as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY]).toBe('listen-second');
    second.close();
    const teardown = await second.closed;
    expect(teardown.received).toBe(1);
  });

  it('does not buffer signals published before listen (no Last-Event-ID)', async () => {
    const { adapter, memory } = harness();
    memory.publish({ type: 'tool-list-changed' });
    const session = openSession(adapter, { toolsListChanged: true });
    memory.publish({ type: 'tool-list-changed' });
    const notifications = await take(session, 1);
    expect(notifications).toHaveLength(1);
    session.close();
    const teardown = await session.closed;
    expect(teardown.received).toBe(1);
  });
});

describe('MCP 2026-07-28 subscriptions/listen: re-read contract', () => {
  it('emits only signal notifications with no resource body', async () => {
    const { adapter, memory } = harness();
    const session = openSession(adapter, {
      resourceSubscriptions: ['urn:res:a'],
      toolsListChanged: true,
      resourcesListChanged: true,
      promptsListChanged: true,
    });
    memory.publish({ type: 'resource-updated', resourceUri: 'urn:res:a' });
    memory.publish({ type: 'tool-list-changed' });
    memory.publish({ type: 'resource-list-changed' });
    memory.publish({ type: 'prompt-list-changed' });
    const notifications = await take(session, 4);
    expect(notifications).toHaveLength(4);
    for (const notification of notifications) {
      const keys = Object.keys(notification.params).filter((key) => key !== '_meta');
      if (notification.method === 'notifications/resources/updated') {
        expect(keys).toEqual(['uri']);
      } else {
        expect(keys).toEqual([]);
      }
    }
    session.close();
    await session.closed;
  });
});
