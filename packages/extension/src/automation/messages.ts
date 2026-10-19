import type { BrowserDecisionEntry } from '../capture/contracts.js';
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
    readonly into?: string; readonly index?: number }
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
  /** A copy right below the original, under the name the page gives it. */
  | { readonly kind: 'known.automation.browser.duplicate'; readonly id: string; readonly entry: 'rule' | 'set'; readonly name: string }
  /** The Owner has read the note about rules whose order now decides (doc 17 R2). */
  | { readonly kind: 'known.automation.browser.notice.dismiss' }
  /** Try a page, or a bookmark, or a sample of recent bookmarks, against the whole list; nothing is written (doc 17 RS-08). */
  | { readonly kind: 'known.automation.browser.preview'; readonly url: string; readonly title: string }
  | { readonly kind: 'known.automation.browser.preview'; readonly nativeId: string }
  | { readonly kind: 'known.automation.browser.preview'; readonly sample: true }
  /** Run once over one folder's bookmarks (doc 17 §6.4): preview, then apply that preview, then perhaps undo the run. */
  | { readonly kind: 'known.automation.browser.runPreview'; readonly scopeNativeId: string }
  | { readonly kind: 'known.automation.browser.runApply'; readonly previewId: string }
  | { readonly kind: 'known.automation.browser.runUndo'; readonly runId: string }
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
  | { readonly ok: true; readonly preview: BrowserPreviewView }
  | { readonly ok: true; readonly run: BrowserRunPreviewView }
  /** Apply: moved now; Undo: moved back. `skipped` were left alone, `missing` are gone. */
  | { readonly ok: true; readonly result: { readonly runId: string; readonly moved: number; readonly skipped: number; readonly missing: number } }
  /** `notSynced`: the folder is not in the synced collection; `signedOut`: there is no account to make it in. */
  | { readonly ok: false; readonly error: string; readonly problems?: readonly DraftProblem[] };

export type BrowserRunCommand = Extract<BrowserRuleCommand, { readonly kind: 'known.automation.browser.runPreview' | 'known.automation.browser.runApply'
  | 'known.automation.browser.runUndo' }>;
const RUN_KINDS = new Set(['known.automation.browser.runPreview', 'known.automation.browser.runApply', 'known.automation.browser.runUndo']);
/** Run once's commands go to their own worker module (sw/automation-run.ts). */
export const isBrowserRunCommand = (command: BrowserRuleCommand): command is BrowserRunCommand => RUN_KINDS.has(command.kind);

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
const validIndex = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= INDEX_LIMIT;

export function validBrowserRuleCommand(value: unknown): value is BrowserRuleCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>, keys = Object.keys(raw).length;
  if (raw.kind === 'known.automation.browser.save') {
    return validDraft(raw.draft) && (raw.id === undefined || id(raw.id)) && (raw.into === undefined || id(raw.into))
      && (raw.enabled === undefined || typeof raw.enabled === 'boolean') && (raw.index === undefined || validIndex(raw.index))
      && keys === 2 + Number(raw.id !== undefined) + Number(raw.enabled !== undefined) + Number(raw.into !== undefined) + Number(raw.index !== undefined);
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
    return keys === 4 && id(raw.ruleId) && (raw.into === null || id(raw.into)) && validIndex(raw.index);
  }
  if (raw.kind === 'known.automation.browser.set.save') {
    return keys === 2 + Number(raw.id !== undefined) && (raw.id === undefined || id(raw.id)) && typeof raw.name === 'string' && raw.name.length <= 1024;
  }
  if (raw.kind === 'known.automation.browser.set.remove') return keys === 3 && id(raw.id) && typeof raw.keepRules === 'boolean';
  if (raw.kind === 'known.automation.browser.list.enable') return keys === 2 && typeof raw.enabled === 'boolean';
  if (raw.kind === 'known.automation.browser.duplicate') {
    return keys === 4 && id(raw.id) && (raw.entry === 'rule' || raw.entry === 'set') && typeof raw.name === 'string' && raw.name.length <= 1024;
  }
  if (raw.kind === 'known.automation.browser.notice.dismiss') return keys === 1;
  if (raw.kind === 'known.automation.browser.runPreview') return keys === 2 && typeof raw.scopeNativeId === 'string' && /^[\w.-]{1,128}$/u.test(raw.scopeNativeId);
  if (raw.kind === 'known.automation.browser.runApply') return keys === 2 && id(raw.previewId);
  if (raw.kind === 'known.automation.browser.runUndo') return keys === 2 && id(raw.runId);
  if (raw.kind === 'known.automation.browser.preview') {
    if (raw.sample !== undefined) return keys === 2 && raw.sample === true;
    if (raw.nativeId !== undefined) return keys === 2 && typeof raw.nativeId === 'string' && /^[\w.-]{1,128}$/u.test(raw.nativeId);
    return keys === 3 && typeof raw.url === 'string' && raw.url.length > 0 && raw.url.length <= 4_096
      && typeof raw.title === 'string' && raw.title.length <= 1_024;
  }
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
  /** Its own switch. */
  readonly enabled: boolean;
  /** It takes part in saves now: it, its set and the whole list are on. */
  readonly active: boolean;
  /** The set it is in; null outside any set. */
  readonly setId: string | null;
  /** Its conditions as written, in the editor's kinds; null when it has no short form. */
  readonly match: RuleMatchView | null;
  /** It keeps matching pages where they are saved, so it has no folder. */
  readonly keepHere: boolean;
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

/** An entry as a preview names it: which rule of which set or subscription (and version), by its name now. */
export type BrowserPreviewEntryView = Omit<BrowserDecisionEntry, 'listRevision'> & { readonly id: string; readonly name: string;
  readonly sourceName: string | null };
/** One page tried against the whole list (doc 17 RS-08.2): what would decide it, what was passed over, what it hides. */
export interface BrowserPreviewPageView {
  readonly url: string;
  readonly title: string;
  readonly nativeId?: string;
  readonly outcome: 'placed' | 'kept' | 'blocked' | 'none';
  readonly reason?: 'bindingUnavailable' | 'evaluation' | 'keepHere';
  readonly winner: BrowserPreviewEntryView | null;
  readonly folder: { readonly nativeId: string; readonly title: string } | null;
  /** The winner takes a whole public suffix's sites (RS-08.5). */
  readonly broad: boolean;
  /** With `broad`: how many different later entries it shadows across the sample and this page. */
  readonly broadShadows?: number;
  /** Before the winner: entries that ask about something this page lacks. */
  readonly skipped: readonly BrowserPreviewEntryView[];
  /** After the winner: entries that match too, and never get the page. */
  readonly shadowed: readonly BrowserPreviewEntryView[];
}
export interface BrowserPreviewSampleRow {
  readonly nativeId: string;
  readonly title: string;
  readonly url: string;
  readonly outcome: BrowserPreviewPageView['outcome'];
  readonly winnerId: string | null;
  readonly winnerName: string | null;
  readonly folder: string | null;
}
export interface BrowserPreviewView {
  /** The list it was made from; a page drops it once the list moves on (RS-08.4). */
  readonly listRevision: number;
  readonly contentVersions: Readonly<Record<string, string>>;
  /** Saves are not decided now (the list is off); the preview shows what the list would do. */
  readonly stopped: 'listOff' | 'accountPaused' | null;
  readonly page?: BrowserPreviewPageView;
  readonly sample?: { readonly size: number; readonly rows: readonly BrowserPreviewSampleRow[];
    readonly broad: readonly (BrowserPreviewEntryView & { readonly shadows: number })[] };
}

/** What Run once would do in one folder, before anything moves (doc 17 §6.4). */
export interface BrowserRunPreviewView {
  readonly previewId: string;
  readonly expiresAt: number;
  readonly scope: { readonly nativeId: string; readonly title: string };
  /** Bookmarks looked at, the folder's subfolders included. */
  readonly counted: number;
  /** Over the 20,000 a run takes: nothing was planned. */
  readonly tooMany: boolean;
  readonly moves: number;
  /** Already where their rule files them. */
  readonly unchanged: number;
  /** A rule keeps them where they are. */
  readonly kept: number;
  readonly unmatched: number;
  /** A rule matches, but its folder is not available here. */
  readonly blocked: number;
  /** Subfolders not entered: a bookmark subscription manages them, or they are excluded. */
  readonly excludedFolders: number;
  readonly topFolders: readonly { readonly nativeId: string; readonly title: string; readonly count: number }[];
  readonly examples: readonly { readonly title: string; readonly url: string; readonly to: string }[];
}
/** A run, as Options lists it with its Undo. */
export interface BrowserRunView {
  readonly runId: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly scopeTitle: string;
  /** `interrupted`: the worker stopped before the run finished; what it moved can still be undone. */
  readonly state: 'running' | 'interrupted' | 'done' | 'undone';
  readonly moved: number;
  readonly skipped: number;
  readonly undone: number;
  readonly undoneAt: number | null;
  readonly canUndo: boolean;
}

/** This browser's ordered list, as Options shows it (doc 17 §4.1): its entries in the order saves try them. */
export interface BrowserListView {
  readonly revision: number;
  /** The whole list's switch. */
  readonly enabled: boolean;
  readonly entries: readonly BrowserListEntryView[];
  /** Rules from the earlier list that can take one page to different folders; the upper one files it now (R2). Null once read. */
  readonly orderNotice: readonly { readonly upper: string; readonly lower: string }[] | null;
}
export type BrowserListEntryView = { readonly kind: 'rule'; readonly rule: BrowserRuleView } | { readonly kind: 'set'; readonly set: BrowserSetView }
  | { readonly kind: 'subscription'; readonly id: string; readonly enabled: boolean };
export interface BrowserSetView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** Made here, or imported from a rule-set file: where its rules came from, and nothing more. */
  readonly origin: { readonly kind: 'custom' } | { readonly kind: 'import'; readonly sourceName: string; readonly sourceVersion: string;
    readonly publisher: string | null };
  readonly rules: readonly BrowserRuleView[];
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
  /** A browser rule's placement (doc 17 RS-15): the list entry that decided, absent on pages filed before the ordered list. */
  readonly entry?: BrowserDecisionEntry;
  /** The set or subscription of that entry, by its name at the save. */
  readonly sourceName?: string;
  /** With `entry`: where that rule (or subscription) stands in the list now, on, switched off (or its set or the list is), or gone. */
  readonly entryState?: 'on' | 'off' | 'gone';
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
  /** This browser's own rules, signed in or not, in the order saves try them, those in sets included. */
  readonly browserRules: readonly BrowserRuleView[];
  /** The same rules as the list they are kept in: individual rules, sets and subscriptions. */
  readonly browserList: BrowserListView;
  /** Run once's last runs, newest first (doc 17 §6.4); absent where nothing reads them. */
  readonly browserRuns?: readonly BrowserRunView[];
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
