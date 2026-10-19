import { REFRESH_INTERVALS, type RefreshInterval } from '../automation/subscription-messages.js';
import type { FailureCode, SubscriptionFailure, SubscriptionPublisher, SubscriptionRecord } from '../automation/subscription-store.js';
import type { Freshness, RiskMatch } from './risk-check.js';
import type { RiskMode } from './risk-settings.js';

/**
 * Commands for risk alerts (doc 17 §9, §11), answered by sw/risk.ts. Subscribing, refreshing and removing
 * a list come from Options only; `known.risk.check` is a read the popup makes next to the rule match
 * (RS-18.2) and answers from stored indexes alone (RS-16.2).
 */
export type RiskCommand =
  /** Adds the list last and fetches it; a failed first fetch leaves it `notReady` with the failure. */
  | { readonly kind: 'known.risk.subscribe'; readonly url: string; readonly refreshIntervalHours: RefreshInterval }
  /** Refresh now: ignores the interval. */
  | { readonly kind: 'known.risk.refresh'; readonly id: string }
  | { readonly kind: 'known.risk.remove'; readonly id: string }
  /** What the subscribed lists say about this address; nothing at all when alerts are off. */
  | { readonly kind: 'known.risk.check'; readonly url: string };

/** A risk list as Options shows it: where it comes from, its version, its last fetches and how fresh it is (R11). */
export interface RiskListView {
  readonly id: string;
  readonly url: string;
  readonly origin: string;
  readonly name: string;
  readonly publisher: SubscriptionPublisher | null;
  readonly state: SubscriptionRecord['state'];
  readonly refreshIntervalHours: RefreshInterval;
  readonly paused: boolean;
  readonly currentVersion: string | null;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastFailure: SubscriptionFailure | null;
  /** Null until a version arrived. */
  readonly freshness: Freshness | null;
}
export interface RiskCheckView { readonly mode: RiskMode; readonly matches: readonly RiskMatch[] }
export type RiskError = FailureCode | 'duplicate' | 'limit' | 'notFound';
export type RiskResponse = { readonly ok: true; readonly list?: RiskListView; readonly check?: RiskCheckView }
  | { readonly ok: false; readonly error: RiskError; readonly status?: number };

const ID = /^[\w-]{1,128}$/u;
const url = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 8_192;
export function validRiskCommand(message: unknown): message is RiskCommand {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const raw = message as Record<string, unknown>, keys = Object.keys(raw).length;
  if (raw.kind === 'known.risk.subscribe') return keys === 3 && url(raw.url) && REFRESH_INTERVALS.includes(raw.refreshIntervalHours as RefreshInterval);
  if (raw.kind === 'known.risk.refresh' || raw.kind === 'known.risk.remove') return keys === 2 && typeof raw.id === 'string' && ID.test(raw.id);
  if (raw.kind === 'known.risk.check') return keys === 2 && url(raw.url);
  return false;
}
