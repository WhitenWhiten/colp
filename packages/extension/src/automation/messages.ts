import type { DigestIndicator } from './digest-indicator.js';

/**
 * Page ↔ worker messages for automations: the Options page's state and refresh,
 * the popup's "what would a rule do with this page" and its new-results line.
 * All read-only except an explicit refresh.
 */

/** Key of the installed bundle record (bundle-store.ts). */
export const AUTOMATION_BUNDLE_KEY = 'known.automation.bundle.v1';
/** Key of this browser's placement receipts (receipt-sync.ts). */
export const AUTOMATION_RECEIPTS_KEY = 'known.automation.receipts.v1';

/**
 * The bundle and receipts live in IndexedDB (indexeddb-store.ts) under the two keys above. The worker bumps
 * this chrome.storage.local marker after each write so open pages repaint.
 */
export const AUTOMATION_CHANGED_KEY = 'known.automation.changed.v1';

export type AutomationRequest =
  | { readonly kind: 'known.automation.state' }
  | { readonly kind: 'known.automation.refresh'; readonly userGesture: true }
  | { readonly kind: 'known.automation.match'; readonly url: string; readonly title: string; readonly parentNativeId: string }
  | { readonly kind: 'known.automation.digest' };

export function validAutomationRequest(value: unknown): value is AutomationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'known.automation.state' || raw.kind === 'known.automation.digest') return Object.keys(raw).length === 1;
  if (raw.kind === 'known.automation.match') return Object.keys(raw).length === 4 && typeof raw.url === 'string'
    && raw.url.length <= 8192 && typeof raw.title === 'string' && raw.title.length <= 4096
    && typeof raw.parentNativeId === 'string' && /^[\w.-]{1,128}$/u.test(raw.parentNativeId);
  return raw.kind === 'known.automation.refresh' && raw.userGesture === true && Object.keys(raw).length === 2;
}

/** What the rules would do with a page saved to the popup's default folder. */
export interface AutomationMatchView {
  readonly outcome: 'placed' | 'kept' | 'blocked' | 'conflict' | 'review' | 'expired';
  readonly ruleName: string;
  readonly ruleCount: number;
  /** The rule's folder in this browser; only a placement has one. */
  readonly folderNativeId: string | null;
  readonly folderTitle: string | null;
}

export interface AutomationRuleView {
  readonly id: string;
  readonly name: string;
  /** The destination's title in this browser, when it is mapped here. */
  readonly folder: string | null;
  readonly resolved: boolean;
}

/** A receipt as the page shows it: placement happened here; the server's answer is the rest. */
export interface AutomationPlacementView {
  readonly id: string;
  readonly title: string;
  readonly host: string;
  readonly ruleName: string;
  readonly folder: string;
  readonly at: number;
  readonly path: 'preSave' | 'observed';
  /** waitingForSync: not yet joined to its Sync operations; confirmed: the server accepted the placement. */
  readonly state: 'waitingForSync' | 'confirmed' | 'review' | 'rejected' | 'attention';
}

export type AutomationProblem = 'offline' | 'signedOut' | 'unavailable' | 'rateLimited' | 'server' | 'rejected';

/** A rule as the server reports it: its state and the server's own counts, nothing worked out here. */
export interface AutomationServerRuleView {
  readonly id: string;
  readonly name: string;
  readonly state: 'draft' | 'active' | 'degraded' | 'blocked' | 'paused' | 'archived';
  /** It files bookmarks in the browser, even while a pause keeps it out of the bundle; false: it works only on the server. */
  readonly inBrowser: boolean;
  /** Jobs ready for an agent, held by a cap, and waiting for the Owner's approval; null before the server reports usage. */
  readonly waiting: number | null;
  readonly held: number | null;
  readonly approvals: number | null;
  /** The server's own words for what the work costs ("billed by your agent"). */
  readonly cost: string | null;
}

/** One server run, in its own state: never merged with a placement this browser made. */
export interface AutomationRunView {
  readonly id: string;
  readonly ruleName: string | null;
  readonly kind: 'intake' | 'batch' | 'manual';
  readonly status: 'waiting' | 'running' | 'review' | 'completed' | 'partial' | 'blocked' | 'cancelled' | 'failed';
  readonly held: boolean;
  readonly explanation: string | null;
  readonly at: number;
  readonly unread: boolean;
  readonly outputCount: number;
  /** The run's page on the web. */
  readonly url: string;
}

export interface AutomationServerView {
  /** When the server was last read; null before the first good read. */
  readonly fetchedAt: number | null;
  /** Why the latest read failed, when it failed after that copy was read. */
  readonly problem: 'offline' | 'signedOut' | 'rateLimited' | 'server' | 'invalid' | null;
  readonly rules: readonly AutomationServerRuleView[];
  /** Newest first. */
  readonly runs: readonly AutomationRunView[];
}

export interface AutomationStateView {
  readonly account: 'signedOut' | 'signedIn';
  /** `none`: no bundle yet. `active`/`paused`: what the installed bundle says. `expired`: placement is off until a refresh. */
  readonly state: 'none' | 'active' | 'paused' | 'expired';
  readonly rules: readonly AutomationRuleView[];
  /** This account's recent placements in this browser, newest first. */
  readonly placements: readonly AutomationPlacementView[];
  readonly pausedAt: number | null;
  readonly pausedBy: 'owner' | 'restore' | 'capacity' | null;
  readonly expiresAt: number | null;
  readonly lastRefreshAt: number | null;
  readonly problem: AutomationProblem | null;
  /** The web Automations page on the connected server. */
  readonly webUrl: string | null;
  /** What the server says it is doing; null when signed out or the server has no automations. */
  readonly server: AutomationServerView | null;
}

export type AutomationResponse = { readonly ok: true; readonly state: AutomationStateView }
  | { readonly ok: true; readonly digest: DigestIndicator | null }
  | { readonly ok: true; readonly match: AutomationMatchView | null } | { readonly ok: false; readonly error: string };
