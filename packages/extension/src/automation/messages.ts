/**
 * Page ↔ worker messages for automations: the Options page's state and refresh,
 * and the popup's "what would a rule do with this page". All read-only except
 * an explicit refresh.
 */

/** chrome.storage.local key of the installed bundle record (bundle-store.ts); pages watch it to repaint. */
export const AUTOMATION_BUNDLE_KEY = 'known.automation.bundle.v1';
/** chrome.storage.local key of this browser's placement receipts (receipt-sync.ts). */
export const AUTOMATION_RECEIPTS_KEY = 'known.automation.receipts.v1';

export type AutomationRequest =
  | { readonly kind: 'known.automation.state' }
  | { readonly kind: 'known.automation.refresh'; readonly userGesture: true }
  | { readonly kind: 'known.automation.match'; readonly url: string; readonly title: string; readonly parentNativeId: string };

export function validAutomationRequest(value: unknown): value is AutomationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'known.automation.state') return Object.keys(raw).length === 1;
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
}

export type AutomationResponse = { readonly ok: true; readonly state: AutomationStateView }
  | { readonly ok: true; readonly match: AutomationMatchView | null } | { readonly ok: false; readonly error: string };
