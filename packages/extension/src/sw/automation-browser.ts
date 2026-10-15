import { createBrowserRuleStore, type BrowserRuleStore } from '../automation/browser-rule-store.js';
import { decideBrowserRules, type BrowserDecision, type FolderLookup } from '../automation/browser-rules.js';
import { automationDatabase, type AutomationDatabase } from '../automation/indexeddb-store.js';
import type { BrowserRuleCommand, BrowserRuleResponse } from '../automation/messages.js';
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
