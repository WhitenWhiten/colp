import { createBrowserRuleStore, type BrowserRuleStore } from '../automation/browser-rule-store.js';
import { decideBrowserRules, draftFromRule, type BrowserDecision, type FolderLookup } from '../automation/browser-rules.js';
import { automationDatabase, type AutomationDatabase } from '../automation/indexeddb-store.js';
import type { AutomationPlacementView, BrowserRuleCommand, BrowserRuleResponse, BrowserRuleView } from '../automation/messages.js';
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

/** This browser's rules for Options, oldest first. Without bookmark access their folders cannot be named. */
export async function browserRuleViews(): Promise<BrowserRuleView[]> {
  const rules = await browserRuleStore().list();
  if (!rules.length) return [];
  const access = await hasBookmarkPermission();
  return Promise.all(rules.map(async (rule) => {
    const folder = access ? await folderView(rule.folderNativeId) : null;
    return { id: rule.id, name: rule.definition.name, enabled: rule.enabled, match: ruleMatchView(rule.definition.match),
      draft: draftFromRule(rule), folder, folderMissing: access && !folder };
  }));
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
  if (command.kind === 'known.automation.browser.enable') {
    const rule = await store.setEnabled(command.id, command.enabled, now);
    return rule ? { ok: true, rule } : { ok: false, error: 'notFound' };
  }
  const result = await store.save({ ...(command.id ? { id: command.id } : {}), draft: command.draft,
    ...(command.enabled === undefined ? {} : { enabled: command.enabled }) }, now);
  if (result.ok) return { ok: true, rule: result.rule };
  return result.error === 'invalid' ? { ok: false, error: 'invalid', problems: result.problems } : { ok: false, error: result.error };
}
