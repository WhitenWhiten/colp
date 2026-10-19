import type { BrowserRuleView } from './messages.js';
import type { RuleMatchView } from './rule-match.js';
import type { EntryDiff, RulesetAddress, ScopeReason } from './ruleset-format.js';
import type { Adjustment } from './subscription-list.js';
import type { SubscriptionFailure, SubscriptionPublisher, SubscriptionRecord } from './subscription-store.js';

/**
 * Options ↔ worker commands for rule-set subscriptions (doc 17 §8, §11), closed like the list's own
 * (messages.ts): check an address before subscribing, subscribe, change its settings, refresh now,
 * adjust it here, copy an entry to the Owner's rules and remove. The worker module is
 * sw/automation-subscriptions.ts.
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
    readonly refreshIntervalHours?: RefreshInterval; readonly paused?: boolean; readonly pinned?: boolean }
  /** What the waiting version changes (RS-12.1); Apply makes it current; Use previous version swaps back and pins (RS-13.3). */
  | { readonly kind: 'known.automation.browser.subscription.review'; readonly id: string }
  | { readonly kind: 'known.automation.browser.subscription.apply'; readonly id: string }
  | { readonly kind: 'known.automation.browser.subscription.rollback'; readonly id: string }
  /** Refresh now: ignores the interval. */
  | { readonly kind: 'known.automation.browser.subscription.refresh'; readonly id: string }
  | { readonly kind: 'known.automation.browser.subscription.remove'; readonly id: string }
  /** Switch an entry, leave a site alone, bind a role, or forget settings for entries gone upstream (RS-05). */
  | { readonly kind: 'known.automation.browser.subscription.adjust'; readonly id: string; readonly change: Adjustment }
  /** Copy to my rules (RS-05.4): above the subscription; the entry here switched off when asked. */
  | { readonly kind: 'known.automation.browser.subscription.copy'; readonly id: string; readonly entryId: string; readonly disableOriginal: boolean };

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
  /**
   * Why the candidate waits (RS-12.3): *Review* is the policy, it is pinned, or *Automatic* may not apply it
   * because it adds or drops a folder role or is another rule set. Null with no candidate.
   */
  readonly candidateWaits: 'review' | 'pinned' | ScopeReason | null;
  /** When the current version arrived. */
  readonly fetchedAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastFailure: SubscriptionFailure | null;
}

/** One of the current version's entries, as the subscription's row lists it. */
export interface BrowserSubscriptionEntryView {
  readonly id: string;
  readonly name: string;
  /** Not switched off here. */
  readonly enabled: boolean;
  /** Its conditions in the editor's words; a site entry is named by its site. Null when they have no short form. */
  readonly match: RuleMatchView | null;
  /** The description of its role; null for an entry that only names a site (matching data). */
  readonly role: string | null;
  readonly folder: BrowserRuleView['folder'];
  /** Its role has no folder here yet: a match is blocked until one is chosen. */
  readonly needsFolder: boolean;
}
/** What a subscription in the list has beyond its record (RS-05, RS-10, RS-15.2). */
export interface BrowserSubscriptionDetail {
  readonly entries: readonly BrowserSubscriptionEntryView[];
  readonly roles: readonly { readonly key: string; readonly description: string; readonly folder: BrowserRuleView['folder'] }[];
  readonly exceptions: readonly { readonly id: string; readonly scope: 'host' | 'domain'; readonly value: string }[];
  /** Entries switched off here that its current version no longer has (R4). */
  readonly goneSettings: number;
  /** Its collection: each site's addresses, revoked and historical ones too, for its history and for rules here. */
  readonly sites: readonly { readonly id: string; readonly name: string; readonly addresses: readonly RulesetAddress[] }[];
}

/** The waiting version against the current one: its entries by id, its folder roles, and what it would do to recent bookmarks. */
export interface BrowserSubscriptionReviewView {
  readonly id: string;
  readonly name: string;
  readonly currentVersion: string;
  readonly candidateVersion: string;
  /** *Automatic* would apply it by itself; otherwise why not (R10). */
  readonly scope: { readonly ok: boolean; readonly reasons: readonly ScopeReason[] };
  readonly diff: EntryDiff;
  /** Of the most recent bookmarks, how many another entry or folder would take; null without bookmark access. */
  readonly sample: { readonly size: number; readonly changed: number; readonly byFolder: readonly { readonly title: string; readonly count: number }[] } | null;
}

const ONE_ID = new Set(['known.automation.browser.subscription.refresh', 'known.automation.browser.subscription.remove',
  'known.automation.browser.subscription.review', 'known.automation.browser.subscription.apply', 'known.automation.browser.subscription.rollback']);
const KINDS = new Set([...ONE_ID, 'known.automation.browser.subscription.check', 'known.automation.browser.subscribe', 'known.automation.browser.subscription.update',
  'known.automation.browser.subscription.adjust', 'known.automation.browser.subscription.copy']);
export const isSubscriptionKind = (kind: unknown): boolean => typeof kind === 'string' && KINDS.has(kind);
export const isSubscriptionCommand = (command: { readonly kind: string }): command is SubscriptionCommand => KINDS.has(command.kind);

const ID = /^[\w-]{1,128}$/u, ROLE = /^[A-Za-z0-9._-]{1,64}$/u, FOLDER = /^[\w.-]{1,128}$/u;
const url = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 2_048;
const policy = (value: unknown) => value === 'review' || value === 'auto';
const interval = (value: unknown) => REFRESH_INTERVALS.includes(value as RefreshInterval);
const bindings = (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length <= 32
  && Object.entries(value as Record<string, unknown>).every(([role, folder]) => ROLE.test(role) && (folder === null || typeof folder === 'string' && FOLDER.test(folder)));

function validAdjustment(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>, keys = Object.keys(raw).length;
  if (raw.kind === 'entry') return keys === 3 && typeof raw.entryId === 'string' && ROLE.test(raw.entryId) && typeof raw.enabled === 'boolean';
  if (raw.kind === 'exception') return keys === 3 && (raw.scope === 'host' || raw.scope === 'domain') && typeof raw.value === 'string'
    && raw.value.length > 0 && raw.value.length <= 253;
  if (raw.kind === 'removeException') return keys === 2 && typeof raw.exceptionId === 'string' && ID.test(raw.exceptionId);
  if (raw.kind === 'bindings') return keys === 2 && bindings(raw.bindings);
  return raw.kind === 'clearGone' && keys === 1;
}

export function validSubscriptionCommand(raw: Record<string, unknown>): boolean {
  const keys = Object.keys(raw).length, id = typeof raw.id === 'string' && ID.test(raw.id);
  if (raw.kind === 'known.automation.browser.subscription.check') return keys === 2 && url(raw.url);
  if (raw.kind === 'known.automation.browser.subscribe') {
    return keys === 5 && url(raw.url) && bindings(raw.bindings) && policy(raw.updatePolicy) && interval(raw.refreshIntervalHours);
  }
  if (raw.kind === 'known.automation.browser.subscription.update') {
    const given = ['updatePolicy', 'refreshIntervalHours', 'paused', 'pinned'].filter((key) => raw[key] !== undefined).length;
    return given > 0 && keys === 2 + given && id && (raw.updatePolicy === undefined || policy(raw.updatePolicy))
      && (raw.refreshIntervalHours === undefined || interval(raw.refreshIntervalHours)) && (raw.paused === undefined || typeof raw.paused === 'boolean')
      && (raw.pinned === undefined || typeof raw.pinned === 'boolean');
  }
  if (raw.kind === 'known.automation.browser.subscription.adjust') return keys === 3 && id && validAdjustment(raw.change);
  if (raw.kind === 'known.automation.browser.subscription.copy') {
    return keys === 4 && id && typeof raw.entryId === 'string' && ROLE.test(raw.entryId) && typeof raw.disableOriginal === 'boolean';
  }
  return ONE_ID.has(String(raw.kind)) && keys === 2 && id;
}
