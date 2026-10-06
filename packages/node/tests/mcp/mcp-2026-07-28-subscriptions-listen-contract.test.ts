/**
 * COLP-MCP-11: Modern MCP 2026-07-28 subscriptions/listen contracts.
 *
 * Covers `src/mcp/shared/change-signal.ts` (protocol-neutral change-signal
 * port) and `src/mcp/2026-07-28/subscriptions.ts` (the Modern listen
 * adapter). The adapter maps change signals to a single long-lived POST
 * `subscriptions/listen` session:
 *
 * - opt-in notification types must be actually declared by the server
 *   capabilities; unsupported types are rejected with Invalid Params (-32602);
 * - the listen result and every streamed notification carry
 *   `io.modelcontextprotocol/subscriptionId` (the listen request id);
 * - notifications stay on the original request's response stream (async
 *   iterable), are stamped per session and never carry a resource body
 *   (clients re-read — no Last-Event-ID / replay contract);
 * - delivery is bounded by queue / rate / lifetime / notification budget;
 *   abort and authorization revocation tear the stream down; every session
 *   releases its source subscription and timers deterministically.
 *
 * This file covers request validation, notification mapping and session
 * isolation; lifecycle bounds (authorization recheck, queue/rate/lifetime,
 * abort, re-read) live in mcp-2026-07-28-subscriptions-listen-lifecycle.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionsListenResultSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/core';

import { Mcp20260728RequestError } from '../../src/mcp/2026-07-28/request-context.js';
import {
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
} from '../../src/mcp/2026-07-28/sdk-boundary.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import {
  createContext,
  expectInvalidParams,
  harness,
  meta,
  openSession,
  readAll,
  serverInfo,
  take,
} from './subscriptions-listen-harness.js';

describe('MCP 2026-07-28 subscriptions/listen: request validation', () => {
  it('accepts supported opt-in types and opens a self-contained session', () => {
    const { adapter, memory } = harness();
    const session = openSession(adapter, { toolsListChanged: true, resourcesListChanged: true });
    expect(session.subscriptionId).toBe('listen-1');
    expect(session.result._meta[SUBSCRIPTION_ID_META_KEY]).toBe('listen-1');
    expect(session.acknowledged.method).toBe('notifications/subscriptions/acknowledged');
    expect(session.acknowledged.params.notifications).toEqual({
      toolsListChanged: true,
      resourcesListChanged: true,
    });
    expect((session.acknowledged.params._meta as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY]).toBe('listen-1');
    expect(memory.listenerCount()).toBe(1);
    session.close();
  });

  it('rejects an unsupported toolsListChanged opt-in when tools.listChanged is not declared', () => {
    const { adapter } = harness({
      capabilities: Object.freeze({ resources: Object.freeze({ subscribe: true }) }),
    });
    let caught: unknown;
    try {
      openSession(adapter, { toolsListChanged: true });
    } catch (error) {
      caught = error;
    }
    expectInvalidParams(caught);
  });

  it('rejects an unsupported resourceSubscriptions opt-in when resources.subscribe is absent', () => {
    const { adapter } = harness({
      capabilities: Object.freeze({ resources: Object.freeze({ listChanged: true }) }),
    });
    expect(() => openSession(adapter, { resourceSubscriptions: ['urn:x'] })).toThrow(Mcp20260728RequestError);
  });

  it('rejects malformed notification params with Invalid Params', () => {
    const { adapter } = harness();
    const malformed = [
      {},
      { notifications: 'yes' },
      { notifications: { toolsListChanged: 'yes' } },
      { notifications: { resourceSubscriptions: [''] } },
      { notifications: { resourceSubscriptions: 'urn:x' } },
    ];
    for (const params of malformed) {
      const context = createContext('subscriptions/listen', { _meta: meta(), ...params });
      let caught: unknown;
      try {
        adapter.listen(context, params, 'listen-1');
      } catch (error) {
        caught = error;
      }
      expectInvalidParams(caught);
    }
  });

  it('rejects a malformed host request id as a host bug', () => {
    const { adapter } = harness();
    const context = createContext('subscriptions/listen', { _meta: meta(), notifications: {} });
    expect(() => adapter.listen(context, { notifications: {} }, '')).toThrow(TypeError);
    expect(() => adapter.listen(context, { notifications: {} }, 1.5)).toThrow(TypeError);
  });
});

describe('MCP 2026-07-28 subscriptions/listen: notification mapping and subscription id', () => {
  it('maps resource-updated signals to notifications/resources/updated without a body', async () => {
    const { adapter, memory } = harness();
    const session = openSession(adapter, { resourceSubscriptions: ['urn:res:1'] }, {}, 'listen-42');
    memory.publish({ type: 'resource-updated', resourceUri: 'urn:res:1' });
    const notifications = await take(session, 1);
    expect(notifications).toHaveLength(1);
    const [notification] = notifications;
    expect(notification!.method).toBe('notifications/resources/updated');
    expect(notification!.params.uri).toBe('urn:res:1');
    expect((notification!.params._meta as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY]).toBe('listen-42');
    expect(notification!.params.contents).toBeUndefined();
    expect(ResourceUpdatedNotificationSchema.safeParse(notification).success).toBe(true);
    session.close();
    await session.closed;
  });

  it('maps list-changed signals to the exact list_changed notifications', async () => {
    const { adapter, memory } = harness();
    const session = openSession(adapter, {
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
    }, {}, 'listen-7');
    memory.publish({ type: 'tool-list-changed' });
    memory.publish({ type: 'prompt-list-changed' });
    memory.publish({ type: 'resource-list-changed' });
    const notifications = await take(session, 3);
    expect(notifications.map((notification) => notification.method)).toEqual([
      'notifications/tools/list_changed',
      'notifications/prompts/list_changed',
      'notifications/resources/list_changed',
    ]);
    for (const notification of notifications) {
      expect((notification.params._meta as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY]).toBe('listen-7');
    }
    expect(ToolListChangedNotificationSchema.safeParse(notifications[0]).success).toBe(true);
    expect(PromptListChangedNotificationSchema.safeParse(notifications[1]).success).toBe(true);
    expect(ResourceListChangedNotificationSchema.safeParse(notifications[2]).success).toBe(true);
    session.close();
    await session.closed;
  });

  it('drops signals whose type was not opted in', async () => {
    const { adapter, memory } = harness();
    const session = openSession(adapter, { toolsListChanged: true });
    memory.publish({ type: 'resource-updated', resourceUri: 'urn:res:1' });
    memory.publish({ type: 'resource-list-changed' });
    memory.publish({ type: 'prompt-list-changed' });
    session.close();
    const teardown = await session.closed;
    expect(teardown.received).toBe(0);
    expect(teardown.delivered).toBe(0);
    expect(await readAll(session)).toEqual([]);
  });

  it('filters resource-updated signals by the requested resource uri list', async () => {
    const { adapter, memory } = harness();
    const session = openSession(adapter, { resourceSubscriptions: ['urn:res:a'] });
    memory.publish({ type: 'resource-updated', resourceUri: 'urn:res:b' });
    memory.publish({ type: 'resource-updated', resourceUri: 'urn:res:a' });
    const notifications = await take(session, 1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.params.uri).toBe('urn:res:a');
    session.close();
    await session.closed;
  });

  it('delivers duplicate signals in arrival order', async () => {
    const { adapter, memory } = harness();
    const session = openSession(adapter, { resourceSubscriptions: ['urn:res:a'] });
    memory.publish({ type: 'resource-updated', resourceUri: 'urn:res:a' });
    memory.publish({ type: 'resource-updated', resourceUri: 'urn:res:a' });
    const notifications = await take(session, 2);
    expect(notifications.map((notification) => notification.params.uri)).toEqual(['urn:res:a', 'urn:res:a']);
    session.close();
    await session.closed;
  });

  it('stamps the result with subscription id and server info', async () => {
    const { adapter } = harness({ serverInfo });
    const session = openSession(adapter, {}, {}, 'listen-9');
    expect(session.result._meta[SUBSCRIPTION_ID_META_KEY]).toBe('listen-9');
    expect(session.result._meta[SERVER_INFO_META_KEY]).toEqual(serverInfo);
    expect(SubscriptionsListenResultSchema.safeParse(session.result).success).toBe(true);
    expect(SubscriptionsAcknowledgedNotificationSchema.safeParse(session.acknowledged).success).toBe(true);
    session.close();
    await session.closed;
  });
});

describe('MCP 2026-07-28 subscriptions/listen: principal and request isolation', () => {
  it('keeps concurrent sessions isolated by principal, filter and subscription id', async () => {
    const { adapter, memory } = harness();
    const sessionA = openSession(
      adapter,
      { toolsListChanged: true },
      { binding: authenticatedBinding({ principalId: 'user-a' }) },
      'listen-a',
    );
    const sessionB = openSession(
      adapter,
      { resourcesListChanged: true },
      { binding: authenticatedBinding({ principalId: 'user-b' }) },
      'listen-b',
    );
    memory.publish({ type: 'tool-list-changed' });
    memory.publish({ type: 'resource-list-changed' });
    const a = await take(sessionA, 1);
    const b = await take(sessionB, 1);
    expect(a[0]!.method).toBe('notifications/tools/list_changed');
    expect((a[0]!.params._meta as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY]).toBe('listen-a');
    expect(b[0]!.method).toBe('notifications/resources/list_changed');
    expect((b[0]!.params._meta as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY]).toBe('listen-b');
    sessionA.close();
    sessionB.close();
    await Promise.all([sessionA.closed, sessionB.closed]);
  });

  it('closing one session never affects another', async () => {
    const { adapter, memory } = harness();
    const sessionA = openSession(adapter, { toolsListChanged: true });
    const sessionB = openSession(adapter, { toolsListChanged: true });
    sessionA.close();
    memory.publish({ type: 'tool-list-changed' });
    const b = await take(sessionB, 1);
    expect(b).toHaveLength(1);
    expect(await readAll(sessionA)).toEqual([]);
    sessionB.close();
    await Promise.all([sessionA.closed, sessionB.closed]);
  });

  it('serves every session from one frozen adapter instance', () => {
    const { adapter } = harness();
    expect(Object.isFrozen(adapter)).toBe(true);
    const session = openSession(adapter, {});
    expect(session.subscriptionId).toBe('listen-1');
    session.close();
  });
});
