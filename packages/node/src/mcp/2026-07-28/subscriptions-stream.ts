import { snapshotMcpData } from '../safe-data.js';
import type { McpChangeSignal, McpChangeSignalSubscription } from '../shared/change-signal.js';
import { snapshotMcpChangeSignal } from '../shared/change-signal.js';
import type {
  Mcp20260728ListenClosedReason,
  Mcp20260728ListenNotification,
  Mcp20260728ListenNotificationMethod,
  Mcp20260728ListenTeardown,
  Mcp20260728SubscriptionFilter,
} from './subscriptions.js';
import type { Mcp20260728RequestContext } from './request-context.js';
import { createMcpListenIdleTimer, type McpListenIdleTimer } from './subscriptions-idle.js';
import { SUBSCRIPTION_ID_META_KEY } from '../../shared/mcp-sdk-boundary.js';

export interface Mcp20260728ListenStreamOptions {
  readonly context: Mcp20260728RequestContext;
  readonly subscriptionId: string | number;
  readonly filter: Mcp20260728SubscriptionFilter;
  readonly isAuthorized: (context: Mcp20260728RequestContext) => boolean;
  readonly maxQueueSize: number;
  readonly maxRatePerWindow: number;
  readonly rateWindowMs: number;
  readonly maxLifetimeMs: number;
  readonly maxNotifications: number;
  readonly idleTimeoutMs: number;
  readonly buildNotification: (method: Mcp20260728ListenNotificationMethod, params: Readonly<Record<string, unknown>>) => Mcp20260728ListenNotification;
}

/**
 * One listen stream: bounded queue + async iterator, rate window, lifetime
 * timer, abort listener, per-send authorization recheck and deterministic
 * teardown. All request-scoped state lives here and is released on end.
 */
export class Mcp20260728ListenStream {
  private readonly context: Mcp20260728RequestContext;
  private readonly subscriptionId: string | number;
  private readonly filter: Mcp20260728SubscriptionFilter;
  private readonly resourceUris: ReadonlySet<string>;
  private readonly isAuthorized: (context: Mcp20260728RequestContext) => boolean;
  private readonly maxQueueSize: number;
  private readonly maxRatePerWindow: number;
  private readonly rateWindowMs: number;
  private readonly maxLifetimeMs: number;
  private readonly maxNotifications: number;
  private readonly buildNotification: Mcp20260728ListenStreamOptions['buildNotification'];
  private readonly queue: Mcp20260728ListenNotification[] = [];
  private readonly waiters: Array<() => void> = [];

  private sourceSubscription: McpChangeSignalSubscription | undefined;
  private abortListener: (() => void) | undefined;
  private lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleTimer: McpListenIdleTimer;
  private ended = false;
  private received = 0;
  private delivered = 0;
  private overflow = 0;
  private rateLimited = 0;
  private rateWindowStart = Date.now();
  private rateWindowCount = 0;
  private closedResolve!: (teardown: Mcp20260728ListenTeardown) => void;

  readonly closed: Promise<Mcp20260728ListenTeardown>;

  constructor(options: Mcp20260728ListenStreamOptions) {
    this.context = options.context;
    this.subscriptionId = options.subscriptionId;
    this.filter = options.filter;
    this.resourceUris = new Set(options.filter.resourceSubscriptions ?? []);
    this.isAuthorized = options.isAuthorized;
    this.maxQueueSize = options.maxQueueSize;
    this.maxRatePerWindow = options.maxRatePerWindow;
    this.rateWindowMs = options.rateWindowMs;
    this.maxLifetimeMs = options.maxLifetimeMs;
    this.maxNotifications = options.maxNotifications;
    this.buildNotification = options.buildNotification;
    this.idleTimer = createMcpListenIdleTimer(options.idleTimeoutMs, () => this.teardown('idle-timeout', false));
    this.closed = new Promise<Mcp20260728ListenTeardown>((resolve) => {
      this.closedResolve = resolve;
    });
  }

  start(subscription: McpChangeSignalSubscription): void {
    // A source may synchronously publish enough signals to end this stream
    // before subscribe returns its handle. Do not resurrect closed resources.
    if (this.ended) {
      subscription.unsubscribe();
      return;
    }
    this.sourceSubscription = subscription;
    this.abortListener = () => this.teardown('aborted', true);
    this.context.abortSignal.addEventListener('abort', this.abortListener, { once: true });
    if (this.context.abortSignal.aborted) {
      this.teardown('aborted', true);
      return;
    }
    this.lifetimeTimer = setTimeout(() => {
      this.lifetimeTimer = undefined;
      this.teardown('lifetime-expired', false);
    }, this.maxLifetimeMs);
    if (typeof (this.lifetimeTimer as { unref?: () => void }).unref === 'function') {
      (this.lifetimeTimer as { unref: () => void }).unref();
    }
    this.refreshIdleTimer();
  }

  close(): void {
    this.teardown('closed', false);
  }

  onSignal(raw: unknown): void {
    if (this.ended) return;
    this.refreshIdleTimer();
    const signal = snapshotMcpChangeSignal(raw);
    if (!this.isAuthorized(this.context)) {
      this.teardown('unauthorized', true);
      return;
    }
    const mapped = this.mapSignal(signal);
    if (mapped === undefined) return;
    this.received += 1;
    if (this.delivered >= this.maxNotifications) {
      this.teardown('notification-budget-exhausted', false);
      return;
    }
    const now = Date.now();
    if (now - this.rateWindowStart >= this.rateWindowMs) {
      this.rateWindowStart = now;
      this.rateWindowCount = 0;
    }
    if (this.rateWindowCount >= this.maxRatePerWindow) {
      this.rateLimited += 1;
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.overflow += 1;
      return;
    }
    const notification = this.buildNotification(mapped.method, {
      _meta: { [SUBSCRIPTION_ID_META_KEY]: this.subscriptionId },
      ...mapped.params,
    });
    this.queue.push(notification);
    this.delivered += 1;
    this.rateWindowCount += 1;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter();
  }

  async next(): Promise<IteratorResult<Mcp20260728ListenNotification>> {
    for (;;) {
      if (!this.isAuthorized(this.context)) {
        this.teardown('unauthorized', true);
        return { done: true, value: undefined };
      }
      const item = this.queue.shift();
      if (item !== undefined) {
        this.refreshIdleTimer();
        return { value: item, done: false };
      }
      if (this.ended) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  private mapSignal(
    signal: McpChangeSignal,
  ): { readonly method: Mcp20260728ListenNotificationMethod; readonly params: Readonly<Record<string, unknown>> } | undefined {
    switch (signal.type) {
      case 'resource-updated': {
        if (!this.resourceUris.has(signal.resourceUri as string)) return undefined;
        return { method: 'notifications/resources/updated', params: { uri: signal.resourceUri as string } };
      }
      case 'resource-list-changed':
        return this.filter.resourcesListChanged === true
          ? { method: 'notifications/resources/list_changed', params: {} }
          : undefined;
      case 'tool-list-changed':
        return this.filter.toolsListChanged === true
          ? { method: 'notifications/tools/list_changed', params: {} }
          : undefined;
      case 'prompt-list-changed':
        return this.filter.promptsListChanged === true
          ? { method: 'notifications/prompts/list_changed', params: {} }
          : undefined;
    }
  }

  private teardown(reason: Mcp20260728ListenClosedReason, abrupt: boolean): void {
    if (this.ended) return;
    this.ended = true;
    const subscription = this.sourceSubscription;
    this.sourceSubscription = undefined;
    if (this.lifetimeTimer !== undefined) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = undefined;
    }
    this.idleTimer.clear();
    if (this.abortListener !== undefined) {
      this.context.abortSignal.removeEventListener('abort', this.abortListener);
      this.abortListener = undefined;
    }
    if (abrupt) this.queue.length = 0;
    while (this.waiters.length > 0) {
      this.waiters.shift()!();
    }
    this.closedResolve(Object.freeze({
      reason,
      graceful: !abrupt,
      received: this.received,
      delivered: this.delivered,
      overflow: this.overflow,
      rateLimited: this.rateLimited,
    }));
    // Settle local resources before invoking host code, which may throw or
    // reenter close. The host error still reaches the initiating caller.
    subscription?.unsubscribe();
  }

  private refreshIdleTimer(): void {
    if (!this.ended && this.sourceSubscription !== undefined) this.idleTimer.refresh();
  }
}
