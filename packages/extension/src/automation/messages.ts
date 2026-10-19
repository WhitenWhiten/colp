import type { DigestIndicator } from './digest-indicator.js';
import type { DraftProblem, RuleDraft } from './rule-conditions.js';
import type { RuleMatchView } from './rule-match.js';
import type { LocalRule, LocalSet } from './rule-list-store.js';

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
    // Empty: the save has no folder of its own yet, and only a rule could give it one.
    && typeof raw.parentNativeId === 'string' && /^[\w.-]{0,128}$/u.test(raw.parentNativeId);
  return raw.kind === 'known.automation.refresh' && raw.userGesture === true && Object.keys(raw).length === 2;
}

/** Options writes this browser's own rules (rule-list-store.ts); only the Options page may send these. */
export type BrowserRuleCommand =
  /** A new rule goes to the end of the list, or of the set `into`; an edited one stays where it is. */
  | { readonly kind: 'known.automation.browser.save'; readonly id?: string; readonly draft: RuleDraft; readonly enabled?: boolean;
    readonly into?: string }
  /** A rule (`entry` left out), a set or a subscription on or off. */
  | { readonly kind: 'known.automation.browser.enable'; readonly id: string; readonly enabled: boolean; readonly entry?: 'rule' | 'set' | 'subscription' }
  | { readonly kind: 'known.automation.browser.remove'; readonly id: string }
  /** The list's entries in a new order: exactly the ids it has (doc 17 RS-01.1). */
  | { readonly kind: 'known.automation.browser.reorder'; readonly order: readonly string[] }
  /** A rule into a set (`into`) or out to the list (`into` null), at `index` there. */
  | { readonly kind: 'known.automation.browser.moveRule'; readonly ruleId: string; readonly into: string | null; readonly index: number }
  | { readonly kind: 'known.automation.browser.set.save'; readonly id?: string; readonly name: string }
  /** `keepRules`: its rules stay, as individual rules where the set was. */
  | { readonly kind: 'known.automation.browser.set.remove'; readonly id: string; readonly keepRules: boolean }
  | { readonly kind: 'known.automation.browser.list.enable'; readonly enabled: boolean }
  /** Keep this rule next to the account rule it overlaps, at that rule's current revision (`reviewKey`). */
  | { readonly kind: 'known.automation.browser.review'; readonly id: string; readonly accountRuleId: string; readonly key: string }
  /** Add mine to the account was opened on the web: retire this rule once the account's enabled copy arrives. */
  | { readonly kind: 'known.automation.browser.moving'; readonly id: string }
  /** Keep in this browser: stop waiting for the account's copy (follow-up U5). The rule keeps filing as before. */
  | { readonly kind: 'known.automation.browser.stay'; readonly id: string }
  /** A new rule for all the account's devices: the web editor, filled in with this draft. Nothing is stored here. */
  | { readonly kind: 'known.automation.browser.forAccount'; readonly draft: RuleDraft };

export type BrowserRuleResponse = { readonly ok: true; readonly rule: LocalRule | null }
  | { readonly ok: true; readonly set: LocalSet | null }
  /** A change to the list's order or switch: its revision after it. */
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: true; readonly url: string }
  /** `notSynced`: the folder is not in the synced collection; `signedOut`: there is no account to make it in. */
  | { readonly ok: false; readonly error: string; readonly problems?: readonly DraftProblem[] };

const RULE_ID = /^[\w-]{1,128}$/u;
const KINDS = new Set(['siteIs', 'siteEndsWith', 'titleContains', 'pathStartsWith', 'pathUnder']);

/** File into a folder here (empty while none is chosen, so the worker can say so), by a set's role, or keep here. */
function validAction(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>, keys = Object.keys(raw).length;
  if (raw.kind === 'keepHere') return keys === 1;
  return raw.kind === 'file' && keys === 2 && (typeof raw.folderNativeId === 'string' && /^[\w.-]{0,128}$/u.test(raw.folderNativeId)
    || typeof raw.role === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(raw.role));
}

function validDraft(value: unknown): value is RuleDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return Object.keys(raw).length === 4 && typeof raw.name === 'string' && raw.name.length <= 1024
    && (raw.combinator === 'all' || raw.combinator === 'any') && validAction(raw.action)
    && Array.isArray(raw.conditions) && raw.conditions.length <= 16 && raw.conditions.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const condition = item as Record<string, unknown>;
      return Object.keys(condition).length === 2 && typeof condition.kind === 'string' && KINDS.has(condition.kind)
        && typeof condition.value === 'string' && condition.value.length <= 2048;
    });
}

const id = (value: unknown): value is string => typeof value === 'string' && RULE_ID.test(value);
/** Room for every entry the list's limits allow (rule-list-store.ts LIST_LIMITS). */
const ORDER_LIMIT = 512, INDEX_LIMIT = 1_000;

export function validBrowserRuleCommand(value: unknown): value is BrowserRuleCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>, keys = Object.keys(raw).length;
  if (raw.kind === 'known.automation.browser.save') {
    return validDraft(raw.draft) && (raw.id === undefined || id(raw.id)) && (raw.into === undefined || id(raw.into))
      && (raw.enabled === undefined || typeof raw.enabled === 'boolean')
      && keys === 2 + Number(raw.id !== undefined) + Number(raw.enabled !== undefined) + Number(raw.into !== undefined);
  }
  if (raw.kind === 'known.automation.browser.forAccount') return keys === 2 && validDraft(raw.draft);
  if (raw.kind === 'known.automation.browser.enable') {
    return keys === 3 + Number(raw.entry !== undefined) && id(raw.id) && typeof raw.enabled === 'boolean'
      && (raw.entry === undefined || raw.entry === 'rule' || raw.entry === 'set' || raw.entry === 'subscription');
  }
  if (raw.kind === 'known.automation.browser.reorder') {
    return keys === 2 && Array.isArray(raw.order) && raw.order.length <= ORDER_LIMIT && raw.order.every(id);
  }
  if (raw.kind === 'known.automation.browser.moveRule') {
    return keys === 4 && id(raw.ruleId) && (raw.into === null || id(raw.into)) && Number.isInteger(raw.index)
      && (raw.index as number) >= 0 && (raw.index as number) <= INDEX_LIMIT;
  }
  if (raw.kind === 'known.automation.browser.set.save') {
    return keys === 2 + Number(raw.id !== undefined) && (raw.id === undefined || id(raw.id)) && typeof raw.name === 'string' && raw.name.length <= 1024;
  }
  if (raw.kind === 'known.automation.browser.set.remove') return keys === 3 && id(raw.id) && typeof raw.keepRules === 'boolean';
  if (raw.kind === 'known.automation.browser.list.enable') return keys === 2 && typeof raw.enabled === 'boolean';
  if (raw.kind === 'known.automation.browser.review') {
    return keys === 4 && typeof raw.id === 'string' && RULE_ID.test(raw.id) && typeof raw.accountRuleId === 'string'
      && raw.accountRuleId.length > 0 && raw.accountRuleId.length <= 256 && typeof raw.key === 'string' && raw.key.length > 0 && raw.key.length <= 512;
  }
  return (raw.kind === 'known.automation.browser.remove' || raw.kind === 'known.automation.browser.moving' || raw.kind === 'known.automation.browser.stay')
    && keys === 2
    && typeof raw.id === 'string' && RULE_ID.test(raw.id);
}

/** What the rules would do with a page saved to the popup's default folder. */
export interface AutomationMatchView {
  readonly outcome: 'placed' | 'kept' | 'blocked' | 'conflict' | 'review' | 'expired';
  readonly ruleName: string;
  /** The set or subscription of a browser rule, for "By Community › GitHub"; null for an account rule or an individual one. */
  readonly sourceName: string | null;
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
  /** Its conditions in the web editor's shapes; null when they have no short form. */
  readonly match: RuleMatchView | null;
}

/** One of this browser's own rules, as Options lists and edits it. */
export interface BrowserRuleView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly match: RuleMatchView | null;
  /** What the editor opens with; null for a rule it cannot show (never written by this build's editor). */
  readonly draft: RuleDraft | null;
  /** Its folder here; null while bookmark access is off or once the folder is gone (`folderMissing`). */
  readonly folder: { readonly nativeId: string; readonly title: string; readonly path: readonly string[] } | null;
  readonly folderMissing: boolean;
  /**
   * The account rule it overlaps (AW-69), when signed in with rules in force: the same rule (`duplicate`),
   * or one that takes some of its pages to another folder first (`conflict`). Null otherwise.
   */
  readonly account: BrowserRuleOverlapView | null;
  /** Signed in: the web editor filled in with this rule (AW-71); null without an account or a synced folder. */
  readonly move: { readonly url: string } | null;
  /** Signed in, and its folder is outside the synced collection: it can only stay in this browser. */
  readonly localOnly: boolean;
  /** Add mine to the account was chosen; it keeps filing until the account's copy arrives. */
  readonly moving: boolean;
  /** Moving for over a day and the account's copy is still not here: it was never turned on, or changed on the web. */
  readonly movingStale: boolean;
}

export interface BrowserRuleOverlapView {
  readonly kind: 'duplicate' | 'conflict';
  readonly rule: { readonly id: string; readonly name: string; readonly match: RuleMatchView | null; readonly folder: string | null };
  /** This browser's recent bookmarks both match. */
  readonly pages: number;
  /** The Owner kept both at the account rule's current revision. */
  readonly reviewed: boolean;
  /** What `known.automation.browser.review` sends back. */
  readonly reviewKey: string;
}

/** A receipt as the page shows it: placement happened here; the server's answer is the rest. */
export interface AutomationPlacementView {
  readonly id: string;
  readonly title: string;
  readonly host: string;
  /** The saved page, for its favicon. */
  readonly url: string;
  readonly ruleName: string;
  readonly folder: string;
  readonly at: number;
  readonly path: 'preSave' | 'observed';
  /**
   * waitingForSync: not yet joined to its Sync operations; confirmed: the server accepted the placement.
   * filed: one of this browser's own rules filed it, and there is nothing for a server to confirm.
   * keptHere: one of this browser's rules matched, but the page stayed where it was saved (`kept` says why).
   */
  readonly state: 'waitingForSync' | 'confirmed' | 'review' | 'rejected' | 'attention' | 'filed' | 'keptHere';
  readonly kept?: 'conflict' | 'blocked' | 'keepHere';
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
  /** Recent placements in this browser, by this account's rules and this browser's own, newest first. */
  readonly placements: readonly AutomationPlacementView[];
  /** This browser's own rules, signed in or not, in the order they were made. */
  readonly browserRules: readonly BrowserRuleView[];
  readonly pausedAt: number | null;
  readonly pausedBy: 'owner' | 'restore' | 'capacity' | null;
  readonly expiresAt: number | null;
  readonly lastRefreshAt: number | null;
  readonly problem: AutomationProblem | null;
  /** The web Automations page on the connected server. */
  readonly webUrl: string | null;
  /** What the server says it is doing; null when signed out or the server has no automations. */
  readonly server: AutomationServerView | null;
  /** What decides a saved page's folder after the rules: the save mode and the AI in use here (follow-up U3). */
  readonly saving: SavingFlowView;
}

export interface SavingFlowView {
  readonly mode: 'manual' | 'automatic';
  /** The AI that picks a folder in Automatic mode: the Owner's own service, Know-N (an account that consented), or none. */
  readonly ai: 'own' | 'knowN' | null;
  /** Manual mode: a folder is suggested as the form opens. */
  readonly suggestInForm: boolean;
}

export type AutomationResponse = { readonly ok: true; readonly state: AutomationStateView }
  | { readonly ok: true; readonly digest: DigestIndicator | null }
  | { readonly ok: true; readonly match: AutomationMatchView | null } | { readonly ok: false; readonly error: string };
