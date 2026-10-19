import type { SubscriptionFailure, SubscriptionPublisher, SubscriptionRecord } from './subscription-store.js';

/**
 * Options ↔ worker commands for rule-set subscriptions (doc 17 §8, §11), closed like the list's own
 * (messages.ts): check an address before subscribing, subscribe, change its settings, refresh now and
 * remove. The worker module is sw/automation-subscriptions.ts.
 */
export const REFRESH_INTERVALS = [6, 24, 168] as const;
export type RefreshInterval = typeof REFRESH_INTERVALS[number];
type Bindings = Readonly<Record<string, string | null>>;
export type SubscriptionCommand =
  /** Fetches and checks the file at `url` and says what it holds; nothing is kept. */
  | { readonly kind: 'known.automation.browser.subscription.check'; readonly url: string }
  /** Adds the subscription at the end of the list and fetches it; a failed first fetch leaves it `notReady`. */
  | { readonly kind: 'known.automation.browser.subscribe'; readonly url: string; readonly bindings: Bindings;
    readonly updatePolicy: SubscriptionRecord['updatePolicy']; readonly refreshIntervalHours: RefreshInterval }
  | { readonly kind: 'known.automation.browser.subscription.update'; readonly id: string; readonly updatePolicy?: SubscriptionRecord['updatePolicy'];
    readonly refreshIntervalHours?: RefreshInterval; readonly paused?: boolean }
  /** Refresh now: ignores the interval. */
  | { readonly kind: 'known.automation.browser.subscription.refresh'; readonly id: string }
  | { readonly kind: 'known.automation.browser.subscription.remove'; readonly id: string };

/** A subscription as Options shows it: where it comes from, its versions, and how its last fetches went (RS-04.2, RS-15.2). */
export interface BrowserSubscriptionView {
  readonly id: string;
  readonly url: string;
  readonly origin: string;
  readonly name: string;
  readonly publisher: SubscriptionPublisher | null;
  readonly license: string | null;
  readonly state: SubscriptionRecord['state'];
  readonly updatePolicy: SubscriptionRecord['updatePolicy'];
  readonly refreshIntervalHours: RefreshInterval;
  readonly paused: boolean;
  readonly pinned: boolean;
  readonly currentVersion: string | null;
  readonly previousVersion: string | null;
  readonly candidateVersion: string | null;
  /** When the current version arrived. */
  readonly fetchedAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastFailure: SubscriptionFailure | null;
}

const KINDS = new Set(['known.automation.browser.subscription.check', 'known.automation.browser.subscribe', 'known.automation.browser.subscription.update',
  'known.automation.browser.subscription.refresh', 'known.automation.browser.subscription.remove']);
export const isSubscriptionKind = (kind: unknown): boolean => typeof kind === 'string' && KINDS.has(kind);
export const isSubscriptionCommand = (command: { readonly kind: string }): command is SubscriptionCommand => KINDS.has(command.kind);

const ID = /^[\w-]{1,128}$/u, ROLE = /^[A-Za-z0-9._-]{1,64}$/u, FOLDER = /^[\w.-]{1,128}$/u;
const url = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 2_048;
const policy = (value: unknown) => value === 'review' || value === 'auto';
const interval = (value: unknown) => REFRESH_INTERVALS.includes(value as RefreshInterval);
const bindings = (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length <= 32
  && Object.entries(value as Record<string, unknown>).every(([role, folder]) => ROLE.test(role) && (folder === null || typeof folder === 'string' && FOLDER.test(folder)));

export function validSubscriptionCommand(raw: Record<string, unknown>): boolean {
  const keys = Object.keys(raw).length, id = typeof raw.id === 'string' && ID.test(raw.id);
  if (raw.kind === 'known.automation.browser.subscription.check') return keys === 2 && url(raw.url);
  if (raw.kind === 'known.automation.browser.subscribe') {
    return keys === 5 && url(raw.url) && bindings(raw.bindings) && policy(raw.updatePolicy) && interval(raw.refreshIntervalHours);
  }
  if (raw.kind === 'known.automation.browser.subscription.update') {
    const given = ['updatePolicy', 'refreshIntervalHours', 'paused'].filter((key) => raw[key] !== undefined).length;
    return given > 0 && keys === 2 + given && id && (raw.updatePolicy === undefined || policy(raw.updatePolicy))
      && (raw.refreshIntervalHours === undefined || interval(raw.refreshIntervalHours)) && (raw.paused === undefined || typeof raw.paused === 'boolean');
  }
  return (raw.kind === 'known.automation.browser.subscription.refresh' || raw.kind === 'known.automation.browser.subscription.remove') && keys === 2 && id;
}
