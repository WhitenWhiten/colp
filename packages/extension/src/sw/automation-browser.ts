import { createBrowserRuleStore, type BrowserRuleStore } from '../automation/browser-rule-store.js';
import { accountEditorUrl, decideBrowserRules, draftFromRule, type BrowserDecision, type FolderLookup } from '../automation/browser-rules.js';
import { automationDatabase, type AutomationDatabase } from '../automation/indexeddb-store.js';
import { relateBrowserRule, replayOverlap, type OverlapRule, type Page } from '../automation/browser-overlap.js';
import type { AutomationPlacementView, BrowserRuleCommand, BrowserRuleOverlapView, BrowserRuleResponse, BrowserRuleView } from '../automation/messages.js';
import { ruleMatchView } from '../automation/rule-match.js';
import type { PreSaveInput } from '../automation/pre-save.js';
import type { BrowserAutomation, CaptureTask } from '../capture/contracts.js';
import { hasBookmarkPermission } from './runtime.js';

/**
 * The worker side of browser rules (design 01 §7.5): the save path asks them
 * only after the account's rules had nothing to say, Options writes them, and a
 * page they filed is logged for Options' recent activity. Nothing here needs an
 * account or the network.
 */
let shared: { readonly database: AutomationDatabase; readonly store: BrowserRuleStore } | undefined;
/** One store per database, so every write goes through the same queue. */
export function browserRuleStore(): BrowserRuleStore {
  const database = automationDatabase();
  if (shared?.database !== database) shared = { database, store: createBrowserRuleStore(database.area()) };
  return shared.store;
}

export const nativeFolderLookup: FolderLookup = async (nativeId) => (await chrome.bookmarks.get(nativeId).catch(() => []))[0] ?? null;

export interface BrowserPreSaveDecision {
  readonly automation: BrowserAutomation;
  /** The rule's folder; only a placement has one. */
  readonly targetNativeId: string | null;
}

function browserAutomation(decision: BrowserDecision, fromNativeId: string): BrowserAutomation {
  return { source: 'browser', outcome: decision.outcome, ...(decision.reason ? { reason: decision.reason } : {}), rule: decision.rule,
    ruleIds: [...decision.ruleIds], ...(decision.folder ? { folderTitle: decision.folder.title } : {}), fromNativeId };
}

/** This browser's rules' decision for a save no account rule decided; null when none matches. */
export async function browserPreSaveDecision(input: PreSaveInput): Promise<BrowserPreSaveDecision | null> {
  if (!await hasBookmarkPermission()) return null;
  const decision = await decideBrowserRules(await browserRuleStore().list(), input, nativeFolderLookup, Date.now());
  return decision ? { automation: browserAutomation(decision, input.parentNativeId), targetNativeId: decision.folder?.nativeId ?? null } : null;
}

/** A save a browser rule placed, for Options. The capture id keeps a repeated acknowledgement from logging it twice. */
export async function recordBrowserPlacement(task: CaptureTask): Promise<void> {
  const automation = task.automation;
  if (automation?.source !== 'browser' || automation.outcome !== 'placed' || !task.nativeId || task.save !== 'local-saved'
    || task.disposition !== 'new') return;
  await browserRuleStore().logPlacement({ id: task.captureId, ruleId: automation.rule.id, ruleName: automation.rule.name,
    folder: automation.folderTitle ?? '', title: task.title, url: task.url, at: task.savedAt ?? Date.now() });
}

/** A folder as Options names it: its title under its parents' ("Bookmarks bar › Reading › Papers"). Null once it is gone. */
async function folderView(nativeId: string): Promise<BrowserRuleView['folder']> {
  const node = await nativeFolderLookup(nativeId);
  if (!node || node.url !== undefined) return null;
  const path = [node.title];
  const seen = new Set([node.id]);
  let parentId = node.parentId;
  while (parentId && parentId !== '0' && !seen.has(parentId) && path.length < 32) {
    seen.add(parentId);
    const parent = await nativeFolderLookup(parentId);
    if (!parent) break;
    if (parent.title) path.unshift(parent.title);
    parentId = parent.parentId;
  }
  return { nativeId: node.id, title: node.title, path };
}

/** An account rule in force here, as the overlap check reads it (sw/automation.ts builds these from the bundle). */
export interface AccountRuleForOverlap extends OverlapRule {
  readonly name: string;
  readonly folderTitle: string | null;
  /** Its revision and binding revision: a review is kept against exactly these. */
  readonly key: string;
}

/** How many of the most recently added bookmarks the overlap check replays (design 01 §7.5). */
export const OVERLAP_SAMPLE = 2_000;

async function recentPages(): Promise<Page[]> {
  const nodes = await chrome.bookmarks.getRecent(OVERLAP_SAMPLE).catch(() => []);
  return nodes.filter((node) => typeof node.url === 'string').map((node) => ({ url: node.url!, title: node.title }));
}

/** What a signed-in page adds to the view: the account's rules here and how a folder here is named in Sync. */
export interface AccountContext {
  readonly account: readonly AccountRuleForOverlap[];
  /** The web Automations page of the connected server. */
  readonly webUrl: string | null;
  /** The synced collection's identity of a folder here; null when it is not (yet) synced. */
  canonical(nativeId: string): Promise<{ readonly collectionId: string; readonly nodeId: string } | null>;
}

/**
 * This browser's rules for Options, oldest first. Without bookmark access their folders cannot be named.
 * Signed in, each switched-on rule also says which account rule it overlaps (AW-69), and a rule whose
 * folder is synced can be moved to the account (AW-71).
 */
export async function browserRuleViews(context: AccountContext | null = null): Promise<BrowserRuleView[]> {
  const rules = await browserRuleStore().list();
  if (!rules.length) return [];
  const account = context?.account ?? [];
  const access = await hasBookmarkPermission(), now = Date.now();
  const enabled = rules.filter((rule) => rule.enabled).map((rule) => ({ id: rule.id, definition: rule.definition, folderNativeId: rule.folderNativeId }));
  const compare = access && account.length > 0 && enabled.length > 0;
  const counts = compare ? replayOverlap(enabled, account, await recentPages(), now) : new Map<string, Map<string, number>>();
  return Promise.all(rules.map(async (rule) => {
    const folder = access ? await folderView(rule.folderNativeId) : null;
    const relation = compare && rule.enabled ? relateBrowserRule({ id: rule.id, definition: rule.definition, folderNativeId: rule.folderNativeId },
      account, counts.get(rule.id), now) : null;
    const other = relation ? account.find((item) => item.id === relation.accountRuleId)! : null;
    const overlap: BrowserRuleOverlapView | null = relation && other ? { kind: relation.kind, pages: relation.pages, reviewKey: other.key,
      rule: { id: other.id, name: other.name, match: ruleMatchView(other.definition.match), folder: other.folderTitle },
      reviewed: (rule.reviewed ?? []).some((item) => item.accountRuleId === other.id && item.key === other.key) } : null;
    const canonical = context && folder ? await context.canonical(rule.folderNativeId).catch(() => null) : null;
    const url = canonical && context?.webUrl ? accountEditorUrl(context.webUrl, rule, canonical) : null;
    return { id: rule.id, name: rule.definition.name, enabled: rule.enabled, match: ruleMatchView(rule.definition.match),
      draft: draftFromRule(rule), folder, folderMissing: access && !folder, account: overlap, move: url ? { url } : null,
      localOnly: Boolean(context && folder && !canonical), moving: rule.movingSince !== undefined };
  }));
}

/**
 * After the account's rules are installed: a rule the Owner moved to the account retires once an enabled
 * account rule does exactly the same here (same conditions, same folder). A draft, an edited copy or a
 * rule into another folder leaves it filing. Returns the names of the rules retired.
 */
export async function retireMovedBrowserRules(account: readonly AccountRuleForOverlap[]): Promise<string[]> {
  if (!account.length) return [];
  const store = browserRuleStore(), now = Date.now(), retired: string[] = [];
  for (const rule of await store.list()) {
    if (rule.movingSince === undefined) continue;
    const relation = relateBrowserRule({ id: rule.id, definition: rule.definition, folderNativeId: rule.folderNativeId }, account, undefined, now);
    if (relation?.kind === 'duplicate' && await store.remove(rule.id)) retired.push(rule.definition.name);
  }
  return retired;
}

/** Pages this browser's rules filed, in the shape of the account's placements; there is nothing to confirm. */
export async function browserPlacementViews(): Promise<AutomationPlacementView[]> {
  return (await browserRuleStore().placements()).map((placement) => {
    let host = '';
    try { host = new URL(placement.url).hostname; } catch { /* the title stands alone */ }
    return { id: placement.id, title: placement.title, host, url: placement.url, ruleName: placement.ruleName, folder: placement.folder,
      at: placement.at, path: 'preSave', state: 'filed' };
  });
}

export async function handleBrowserRuleCommand(command: BrowserRuleCommand): Promise<BrowserRuleResponse> {
  const store = browserRuleStore(), now = Date.now();
  if (command.kind === 'known.automation.browser.remove') {
    return await store.remove(command.id) ? { ok: true, rule: null } : { ok: false, error: 'notFound' };
  }
  if (command.kind === 'known.automation.browser.review') {
    const rule = await store.review(command.id, command.accountRuleId, command.key);
    return rule ? { ok: true, rule } : { ok: false, error: 'notFound' };
  }
  if (command.kind === 'known.automation.browser.moving') {
    const rule = await store.markMoving(command.id, now);
    return rule ? { ok: true, rule } : { ok: false, error: 'notFound' };
  }
  if (command.kind === 'known.automation.browser.enable') {
    const rule = await store.setEnabled(command.id, command.enabled, now);
    return rule ? { ok: true, rule } : { ok: false, error: 'notFound' };
  }
  const result = await store.save({ ...(command.id ? { id: command.id } : {}), draft: command.draft,
    ...(command.enabled === undefined ? {} : { enabled: command.enabled }) }, now);
  if (result.ok) return { ok: true, rule: result.rule };
  return result.error === 'invalid' ? { ok: false, error: 'invalid', problems: result.problems } : { ok: false, error: result.error };
}
