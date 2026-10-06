import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcp20260728SubscriptionsListenAdapter } from '../../src/mcp/2026-07-28/subscriptions.js';
import { createMcp20260728RequestContext, requireMcp20260728RequestContext } from '../../src/mcp/2026-07-28/request-context.js';
import type { McpChangeSignalListener } from '../../src/mcp/shared/change-signal.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const notifications = { toolsListChanged: true };
const capabilities = { tools: { listChanged: true } };
const signal = { type: 'tool-list-changed' as const, sequence: 1, timestamp: 0 };

function context(abortSignal?: AbortSignal) {
  return requireMcp20260728RequestContext(createMcp20260728RequestContext({
    headers: [{ name: 'mcp-protocol-version', value: '2026-07-28' },
      { name: 'mcp-method', value: 'subscriptions/listen' }],
    httpMethod: 'POST',
    body: { method: 'subscriptions/listen', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    }, notifications } },
    binding: authenticatedBinding(),
    ...(abortSignal === undefined ? {} : { abortSignal }),
  }));
}

describe('subscription acquisition and teardown ordering', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([true, false])('releases budget-exhausted subscriptions; synchronous delivery=%s', async synchronous => {
    const ctx = context();
    const addAbortListener = vi.spyOn(ctx.abortSignal, 'addEventListener');
    const unsubscribe = vi.fn();
    let emit!: () => void;
    const adapter = createMcp20260728SubscriptionsListenAdapter({ capabilities, maxNotifications: 1,
      signalSource: { subscribe(listener) {
        emit = () => { listener(signal); listener({ ...signal, sequence: 2 }); };
        if (synchronous) emit();
        return { unsubscribe };
      } },
    });
    const session = adapter.listen(ctx, { notifications }, 'budget');
    if (!synchronous) emit();
    await expect(session.closed).resolves.toMatchObject({ reason: 'notification-budget-exhausted',
      graceful: true, received: 2, delivered: 1 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    if (synchronous) expect(addAbortListener).not.toHaveBeenCalled();
    const iterator = session.notifications[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    expect((await iterator.next()).done).toBe(true);
    session.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('releases the late handle after synchronous authorization revocation', async () => {
    let authorized = true;
    const unsubscribe = vi.fn();
    const adapter = createMcp20260728SubscriptionsListenAdapter({ capabilities,
      authorization: { isAuthorized: () => authorized },
      signalSource: { subscribe(listener) {
        listener(signal);
        authorized = false;
        listener({ ...signal, sequence: 2 });
        return { unsubscribe };
      } },
    });
    const session = adapter.listen(context(), { notifications }, 'revoked');
    await expect(session.closed).resolves.toMatchObject({ reason: 'unauthorized', graceful: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect((await session.notifications[Symbol.asyncIterator]().next()).done).toBe(true);
  });

  it('keeps a synchronously populated live subscription until explicit close', async () => {
    const unsubscribe = vi.fn();
    const adapter = createMcp20260728SubscriptionsListenAdapter({ capabilities,
      signalSource: { subscribe(listener) { listener(signal); return { unsubscribe }; } },
    });
    const session = adapter.listen(context(), { notifications }, 'live');
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect((await session.notifications[Symbol.asyncIterator]().next()).done).toBe(false);
    session.close();
    await expect(session.closed).resolves.toMatchObject({ reason: 'closed' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles waiters and removes local resources even when host cleanup reenters and throws', async () => {
    const ctx = context();
    const removeAbortListener = vi.spyOn(ctx.abortSignal, 'removeEventListener');
    const hostError = new Error('host unsubscribe failed');
    let close!: () => void;
    let listener!: McpChangeSignalListener;
    const unsubscribe = vi.fn(() => { close(); throw hostError; });
    const adapter = createMcp20260728SubscriptionsListenAdapter({ capabilities,
      signalSource: { subscribe(value) { listener = value; return { unsubscribe }; } },
    });
    const session = adapter.listen(ctx, { notifications }, 'cleanup-error');
    close = session.close;
    const next = session.notifications[Symbol.asyncIterator]().next();
    expect(() => session.close()).toThrow(hostError);
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    await expect(session.closed).resolves.toMatchObject({ reason: 'closed', graceful: true });
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    listener(signal);
    session.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('cleans up an abort occurring before subscribe returns', async () => {
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    const adapter = createMcp20260728SubscriptionsListenAdapter({ capabilities,
      signalSource: { subscribe() { controller.abort(); return { unsubscribe }; } },
    });
    const session = adapter.listen(context(controller.signal), { notifications }, 'aborted');
    await expect(session.closed).resolves.toMatchObject({ reason: 'aborted', graceful: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
