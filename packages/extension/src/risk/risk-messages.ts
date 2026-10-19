import { REFRESH_INTERVALS, type RefreshInterval } from '../automation/subscription-messages.js';
import type { FailureCode, SubscriptionFailure, SubscriptionPublisher, SubscriptionRecord } from '../automation/subscription-store.js';
import type { Freshness, RiskMatch } from './risk-check.js';
import type { RiskMode } from './risk-settings.js';

/**
 * Commands for risk alerts (doc 17 §9, §11), answered by sw/risk.ts. The settings and the lists are
 * changed from Options; the popup makes two of these: `known.risk.check`, a read next to the rule match
 * (RS-18.2) answered from stored indexes alone (RS-16.2), and `known.risk.exception.add` from its notice.
 */
export const POPUP_RISK_KINDS = new Set(['known.risk.check', 'known.risk.exception.add']);
export type ExceptionDuration = 'session' | 'always';
export type RiskCommand =
  | { readonly kind: 'known.risk.state' }
  | { readonly kind: 'known.risk.mode'; readonly mode: RiskMode }
  /** A host, or a registrable domain with the hosts under it, that gets no risk alerts; this session or always (R12). */
  | { readonly kind: 'known.risk.exception.add'; readonly scope: 'host' | 'domain'; readonly value: string; readonly duration: ExceptionDuration }
  | { readonly kind: 'known.risk.exception.remove'; readonly id: string }
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
  /** Hosts, domains and prefixes its version names; null until a version arrived. */
  readonly entries: number | null;
}
export interface RiskExceptionView { readonly id: string; readonly scope: 'host' | 'domain'; readonly value: string; readonly duration: ExceptionDuration; readonly createdAt: number }
export interface RiskStateView { readonly mode: RiskMode; readonly lists: readonly RiskListView[]; readonly exceptions: readonly RiskExceptionView[] }
export interface RiskCheckView {
  readonly mode: RiskMode;
  readonly matches: readonly RiskMatch[];
  /** The page's host and registrable domain, for the notice's exception choices; null for an address that isn't a web page. */
  readonly site: { readonly host: string; readonly domain: string | null } | null;
}
export type RiskError = FailureCode | 'duplicate' | 'limit' | 'notFound' | 'invalid';
export type RiskResponse = { readonly ok: true; readonly list?: RiskListView; readonly check?: RiskCheckView; readonly state?: RiskStateView;
  readonly exception?: RiskExceptionView }
  | { readonly ok: false; readonly error: RiskError; readonly status?: number };

const ID = /^[\w-]{1,128}$/u, MODES = new Set<unknown>(['off', 'onSave', 'onSaveAndBrowse']);
const url = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 8_192;
export function validRiskCommand(message: unknown): message is RiskCommand {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const raw = message as Record<string, unknown>, keys = Object.keys(raw).length;
  if (raw.kind === 'known.risk.subscribe') return keys === 3 && url(raw.url) && REFRESH_INTERVALS.includes(raw.refreshIntervalHours as RefreshInterval);
  if (raw.kind === 'known.risk.refresh' || raw.kind === 'known.risk.remove') return keys === 2 && typeof raw.id === 'string' && ID.test(raw.id);
  if (raw.kind === 'known.risk.check') return keys === 2 && url(raw.url);
  if (raw.kind === 'known.risk.state') return keys === 1;
  if (raw.kind === 'known.risk.mode') return keys === 2 && MODES.has(raw.mode as string);
  if (raw.kind === 'known.risk.exception.add') return keys === 4 && (raw.scope === 'host' || raw.scope === 'domain') && typeof raw.value === 'string'
    && raw.value.length <= 253 && (raw.duration === 'session' || raw.duration === 'always');
  if (raw.kind === 'known.risk.exception.remove') return keys === 2 && typeof raw.id === 'string' && ID.test(raw.id);
  return false;
}
