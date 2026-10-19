import { createBrowserPlacementLog, type BrowserPlacementLog } from '../automation/browser-rule-store.js';
import { accountEditorUrl, type FolderLookup } from '../automation/browser-rules.js';
import { automationDatabase, type AutomationDatabase } from '../automation/indexeddb-store.js';
import { checkRuleDraft, type RuleDraft } from '../automation/rule-conditions.js';
import { decideList, type ListDecision, type ListResult } from '../automation/rule-list-decide.js';
import { flattenList, type FlatItem } from '../automation/rule-list-flatten.js';
import { createRuleListStore, individualRules, ruleFolderNativeId, type LocalRule, type LocalSet, type RuleListStore } from '../automation/rule-list-store.js';
import { relateBrowserRule, replayOverlap, type OverlapRule, type Page } from '../automation/browser-overlap.js';
import type { AutomationPlacementView, BrowserListEntryView, BrowserListView, BrowserRuleCommand, BrowserRuleOverlapView, BrowserRuleResponse,
  BrowserRuleView, BrowserRunCommand, BrowserConfigCommand } from '../automation/messages.js';
import { ruleMatchView } from '../automation/rule-match.js';
import { PREVIEW_SAMPLE, previewList, type PreviewPage } from '../automation/rule-preview.js';
import type { PreSaveInput } from '../automation/pre-save.js';
import type { BrowserAutomation, CaptureTask } from '../capture/contracts.js';
import { hasBookmarkPermission } from './runtime.js';

/**
 * The worker side of browser rules (design 01 §7.5): the save path asks them
 * only after the account's rules had nothing to say, Options writes them, and a
 * page they filed is logged for Options' recent activity. Nothing here needs an
 * account or the network.
 */
let shared: { readonly database: AutomationDatabase; readonly store: RuleListStore; readonly log: BrowserPlacementLog } | undefined;
function stores() {
  const database = automationDatabase();
  if (shared?.database !== database) shared = { database, store: createRuleListStore(database.area()), log: createBrowserPlacementLog(database.area()) };
  return shared;
}
/** One store per database, so every write goes through the same queue. */
export const browserRuleStore = (): RuleListStore => stores().store;
export const browserPlacementLog = (): BrowserPlacementLog => stores().log;

/** Individual rules that file into a folder of their own, as the overlap check with the account reads them. */
const filing = (rules: readonly LocalRule[]) => rules.flatMap((rule) => {
  const folderNativeId = ruleFolderNativeId(rule);
  return folderNativeId === null ? [] : [{ id: rule.id, definition: rule.definition, folderNativeId, enabled: rule.enabled }];
});

export const nativeFolderLookup: FolderLookup = async (nativeId) => (await chrome.bookmarks.get(nativeId).catch(() => []))[0] ?? null;

export interface BrowserPreSaveDecision {
  readonly automation: BrowserAutomation;
  /** The rule's folder; only a placement has one. */
  readonly targetNativeId: string | null;
}

const skippedRef = (item: FlatItem) => ({ ...item.ref.kind === 'subscriptionEntry' ? { entryId: item.id } : { ruleId: item.id },
  reason: 'missingInput' as const });

/** The decision as the capture task keeps it: which entry of which list revision decided, and what it passed over (doc 17 §4.3). */
function browserAutomation(decision: ListDecision, result: ListResult, listRevision: number, fromNativeId: string): BrowserAutomation {
  const { item } = decision;
  return { source: 'browser', outcome: decision.outcome, ...(decision.reason ? { reason: decision.reason } : {}), rule: { id: item.id, name: item.name },
    ruleIds: [item.id], ...(decision.folder ? { folderTitle: decision.folder.title } : {}), fromNativeId, entry: { listRevision, ...item.ref },
    ...(item.source ? { sourceName: item.source.name } : {}), ...(result.skipped.length ? { skipped: result.skipped.map(skippedRef) } : {}) };
}

/** This browser's list's decision for a save no account rule decided, first match wins (doc 17 §6.3); null when none matches. */
export async function browserPreSaveDecision(input: PreSaveInput): Promise<BrowserPreSaveDecision | null> {
  if (!await hasBookmarkPermission()) return null;
  const flat = flattenList(await browserRuleStore().load());
  if (flat.stopped || !flat.items.length) return null;
  const result = await decideList(flat.items, input, nativeFolderLookup, Date.now());
  if (!result.decision) return null;
  return { automation: browserAutomation(result.decision, result, flat.revision, input.parentNativeId),
    targetNativeId: result.decision.folder?.nativeId ?? null };
}

/**
 * A save a browser rule decided, for Options' recent activity. The capture id keeps a repeated acknowledgement
 * from logging it twice. A rule that matched but could not file the page is logged too (follow-up U6), so its
 * reason outlives the save panel, and so is a rule that keeps pages where they are saved; a folder the Owner
 * picked is their choice, not news.
 */
export async function recordBrowserPlacement(task: CaptureTask): Promise<void> {
  const automation = task.automation;
  if (automation?.source !== 'browser' || (automation.outcome === 'kept' && automation.reason !== 'keepHere') || !task.nativeId
    || task.save !== 'local-saved' || task.disposition !== 'new') return;
  const kept = automation.outcome === 'placed' ? undefined : automation.outcome === 'kept' ? 'keepHere' as const : automation.outcome;
  await browserPlacementLog().logPlacement({ id: task.captureId, ruleId: automation.rule.id, ruleName: automation.rule.name,
    folder: kept ? task.localLocation?.path.at(-1) ?? '' : automation.folderTitle ?? '', title: task.title, url: task.url,
    at: task.savedAt ?? Date.now(), ...(kept ? { kept } : {}), ...(automation.entry ? { entry: automation.entry } : {}),
    ...(automation.sourceName ? { sourceName: automation.sourceName } : {}) });
}

/** A folder as Options names it: its title under its parents' ("Bookmarks bar › Reading › Papers"). Null once it is gone. */
export async function folderView(nativeId: string): Promise<BrowserRuleView['folder']> {
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

/** How a folder here is named in the signed-in account's synced collection, and where its web editor is. */
export interface AccountLink {
  /** The web Automations page of the connected server. */
  readonly webUrl: string | null;
  /** The synced collection's identity of a folder here; null when it is not (yet) synced. */
  canonical(nativeId: string): Promise<{ readonly collectionId: string; readonly nodeId: string } | null>;
}
/** What a signed-in page adds to the view: the account's rules here, and the link to the account. */
export interface AccountContext extends AccountLink {
  readonly account: readonly AccountRuleForOverlap[];
}

/** A move the account has not finished after a day is said to be stuck (follow-up U5). */
export const MOVING_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * This browser's list for Options, in the order saves try it (doc 17 §4.1), and the same rules flat.
 * Without bookmark access their folders cannot be named. Signed in, each switched-on individual rule
 * also says which account rule it overlaps (AW-69), and one whose folder is synced can be moved to the
 * account (AW-71); a rule in a set belongs to the set and stays here.
 */
export async function browserListViews(context: AccountContext | null = null): Promise<{ readonly rules: BrowserRuleView[]; readonly list: BrowserListView }> {
  const stored = await browserRuleStore().load();
  const individual = individualRules(stored);
  const account = context?.account ?? [];
  const access = await hasBookmarkPermission(), now = Date.now();
  const enabled = filing(individual).filter((rule) => rule.enabled);
  const compare = access && account.length > 0 && enabled.length > 0;
  const counts = compare ? replayOverlap(enabled, account, await recentPages(), now) : new Map<string, Map<string, number>>();
  const view = async (rule: LocalRule, set: LocalSet | null): Promise<BrowserRuleView> => {
    const folderNativeId = ruleFolderNativeId(rule, set);
    const folder = access && folderNativeId ? await folderView(folderNativeId) : null;
    const relation = compare && rule.enabled && !set ? relateBrowserRule({ id: rule.id, definition: rule.definition, folderNativeId },
      account, counts.get(rule.id), now) : null;
    const other = relation ? account.find((item) => item.id === relation.accountRuleId)! : null;
    const overlap: BrowserRuleOverlapView | null = relation && other ? { kind: relation.kind, pages: relation.pages, reviewKey: other.key,
      rule: { id: other.id, name: other.name, match: ruleMatchView(other.definition.match), folder: other.folderTitle },
      reviewed: (rule.reviewed ?? []).some((item) => item.accountRuleId === other.id && item.key === other.key) } : null;
    const canonical = context && folder && folderNativeId && !set ? await context.canonical(folderNativeId).catch(() => null) : null;
    const url = canonical && context?.webUrl ? accountEditorUrl(context.webUrl, rule, canonical) : null;
    // The conditions as written are what the editor opens with; a rule an earlier build wrote without them only switches.
    const draft: RuleDraft | null = rule.conditions.length ? { name: rule.name, combinator: rule.combinator, conditions: rule.conditions, action: rule.action } : null;
    return { id: rule.id, name: rule.name, enabled: rule.enabled, active: stored.enabled && rule.enabled && (set?.enabled ?? true), setId: set?.id ?? null,
      match: rule.conditions.length ? { combinator: rule.combinator, conditions: rule.conditions } : ruleMatchView(rule.definition.match),
      keepHere: rule.action.kind === 'keepHere', draft, folder, folderMissing: access && rule.action.kind !== 'keepHere' && !folder,
      account: overlap, move: url ? { url } : null,
      // Signed out no account copy can arrive, so nothing is shown as waiting for one.
      localOnly: Boolean(context && folder && !set && !canonical), moving: Boolean(context) && rule.movingSince !== undefined,
      movingStale: Boolean(context) && rule.movingSince !== undefined && now - rule.movingSince > MOVING_STALE_MS };
  };
  const entries = await Promise.all(stored.entries.map(async (entry): Promise<BrowserListEntryView> => {
    if (entry.kind === 'rule') return { kind: 'rule', rule: await view(entry.rule, null) };
    if (entry.kind === 'subscription') return { kind: 'subscription', id: entry.subscriptionId, enabled: entry.enabled };
    const { set } = entry;
    return { kind: 'set', set: { id: set.id, name: set.name, enabled: set.enabled, rules: await Promise.all(set.rules.map((rule) => view(rule, set))),
      origin: set.origin.kind === 'custom' ? { kind: 'custom' } : { kind: 'import', sourceName: set.origin.sourceName,
        sourceVersion: set.origin.sourceVersion, publisher: set.origin.publisher } } };
  }));
  const names = new Map(entries.flatMap((entry) => entry.kind === 'rule' ? [[entry.rule.id, entry.rule.name] as const]
    : entry.kind === 'set' ? entry.set.rules.map((rule) => [rule.id, rule.name] as const) : []));
  const pairs = (stored.orderNotice?.pairs ?? []).flatMap(([upper, lower]) => names.has(upper) && names.has(lower)
    ? [{ upper: names.get(upper)!, lower: names.get(lower)! }] : []);
  return { rules: entries.flatMap((entry) => entry.kind === 'rule' ? [entry.rule] : entry.kind === 'set' ? entry.set.rules : []),
    list: { revision: stored.revision, enabled: stored.enabled, entries, orderNotice: stored.orderNotice ? pairs : null } };
}

/**
 * After the account's rules are installed: a rule the Owner moved to the account retires once an enabled
 * account rule does exactly the same here (same conditions, same folder). A draft, an edited copy or a
 * rule into another folder leaves it filing. Returns the names of the rules retired.
 */
export async function retireMovedBrowserRules(account: readonly AccountRuleForOverlap[]): Promise<string[]> {
  if (!account.length) return [];
  const store = browserRuleStore(), now = Date.now(), retired: string[] = [];
  for (const rule of individualRules(await store.load())) {
    if (rule.movingSince === undefined) continue;
    const removed = await store.retireIfDuplicate(rule.id, account, now);
    if (removed) retired.push(removed.definition.name);
  }
  return retired;
}

/**
 * Pages this browser's rules filed, in the shape of the account's placements; there is nothing to confirm.
 * Each says which entry decided and where that rule stands in the list now, for Options' row actions (doc 17 RS-15).
 */
export async function browserPlacementViews(): Promise<AutomationPlacementView[]> {
  const [placements, list] = await Promise.all([browserPlacementLog().placements(), browserRuleStore().load()]);
  const standing = new Map<string, 'on' | 'off'>();
  for (const entry of list.entries) {
    if (entry.kind === 'rule') standing.set(entry.rule.id, list.enabled && entry.rule.enabled ? 'on' : 'off');
    if (entry.kind === 'set') for (const rule of entry.set.rules) standing.set(rule.id, list.enabled && entry.set.enabled && rule.enabled ? 'on' : 'off');
    if (entry.kind === 'subscription') standing.set(`subscription:${entry.subscriptionId}`, list.enabled && entry.enabled ? 'on' : 'off');
  }
  return placements.map((placement) => {
    let host = '';
    try { host = new URL(placement.url).hostname; } catch { /* the title stands alone */ }
    return { id: placement.id, title: placement.title, host, url: placement.url, ruleName: placement.ruleName, folder: placement.folder,
      at: placement.at, path: 'preSave', ...(placement.kept ? { state: 'keptHere', kept: placement.kept } : { state: 'filed' }),
      ...(placement.sourceName ? { sourceName: placement.sourceName } : {}),
      ...(placement.entry ? { entry: placement.entry, entryState: standing.get(placement.entry.kind === 'subscriptionEntry'
        ? `subscription:${placement.entry.subscriptionId}` : placement.entry.ruleId ?? '') ?? 'gone' } : {}) } satisfies AutomationPlacementView;
  });
}

export async function handleBrowserRuleCommand(command: Exclude<BrowserRuleCommand, BrowserRunCommand | BrowserConfigCommand>,
  link: () => Promise<AccountLink | null> = async () => null): Promise<BrowserRuleResponse> {
  const store = browserRuleStore(), now = Date.now();
  const rule = (value: LocalRule | null): BrowserRuleResponse => value ? { ok: true, rule: value } : { ok: false, error: 'notFound' };
  switch (command.kind) {
    case 'known.automation.browser.forAccount': return forAccount(command.draft, await link().catch(() => null));
    case 'known.automation.browser.remove': return await store.removeRule(command.id) ? { ok: true, rule: null } : { ok: false, error: 'notFound' };
    case 'known.automation.browser.review': return rule(await store.review(command.id, command.accountRuleId, command.key));
    case 'known.automation.browser.stay': return rule(await store.stopMoving(command.id));
    case 'known.automation.browser.moving': return rule(await store.markMoving(command.id, now));
    case 'known.automation.browser.enable': {
      const entry = await store.setEnabled({ kind: command.entry ?? 'rule', id: command.id }, command.enabled, now);
      if (!entry) return { ok: false, error: 'notFound' };
      return entry.kind === 'rule' ? { ok: true, rule: entry.rule } : entry.kind === 'set' ? { ok: true, set: entry.set }
        : { ok: true, revision: (await store.load()).revision };
    }
    case 'known.automation.browser.reorder': return store.reorder(command.order);
    case 'known.automation.browser.moveRule': return store.moveRule(command.ruleId, command.into, command.index, now);
    case 'known.automation.browser.set.save': return store.saveSet({ ...(command.id ? { id: command.id } : {}), name: command.name }, now);
    case 'known.automation.browser.set.remove': return store.removeSet(command.id, command.keepRules, now);
    case 'known.automation.browser.list.enable': return store.setListEnabled(command.enabled);
    case 'known.automation.browser.duplicate': return store.duplicate({ kind: command.entry, id: command.id }, command.name, now);
    case 'known.automation.browser.notice.dismiss': await store.dismissOrderNotice(); return { ok: true, revision: (await store.load()).revision };
    case 'known.automation.browser.preview': return browserPreview(command);
    case 'known.automation.browser.save': {
      const result = await store.saveRule({ ...(command.id ? { id: command.id } : {}), draft: command.draft,
        ...(command.enabled === undefined ? {} : { enabled: command.enabled }), ...(command.into ? { into: command.into } : {}),
        ...(command.index === undefined ? {} : { index: command.index }) }, now);
      if (result.ok) return { ok: true, rule: result.rule };
      return result.error === 'invalid' ? { ok: false, error: 'invalid', problems: result.problems } : { ok: false, error: result.error };
    }
  }
}

/**
 * Try a page, a bookmark or the recent bookmarks against the list as it stands (doc 17 RS-08). A list that
 * is switched off is tried as if it were on, and says so. Nothing is written.
 */
async function browserPreview(command: Extract<BrowserRuleCommand, { kind: 'known.automation.browser.preview' }>): Promise<BrowserRuleResponse> {
  if (!await hasBookmarkPermission()) return { ok: false, error: 'noAccess' };
  const list = await browserRuleStore().load();
  const flat = flattenList({ ...list, enabled: true }), stopped = list.enabled ? null : 'listOff' as const;
  const recent = async (): Promise<PreviewPage[]> => (await chrome.bookmarks.getRecent(PREVIEW_SAMPLE).catch(() => []))
    .filter((node) => typeof node.url === 'string').map((node) => ({ url: node.url!, title: node.title, nativeId: node.id }));
  const now = Date.now();
  if ('sample' in command) return { ok: true, preview: await previewList(flat, stopped, { sample: await recent() }, nativeFolderLookup, now) };
  let page: PreviewPage;
  if ('nativeId' in command) {
    const node = (await chrome.bookmarks.get(command.nativeId).catch(() => []))[0];
    if (!node?.url) return { ok: false, error: 'notFound' };
    page = { url: node.url, title: node.title, nativeId: node.id };
  } else {
    let protocol = '';
    try { protocol = new URL(command.url).protocol; } catch { /* not a link */ }
    if (protocol !== 'http:' && protocol !== 'https:') return { ok: false, error: 'invalidUrl' };
    page = { url: command.url, title: command.title };
  }
  return { ok: true, preview: await previewList(flat, stopped, { page, sample: await recent() }, nativeFolderLookup, now) };
}

/**
 * One New rule for both kinds (follow-up U2): a rule for all the account's devices is made on the web, so
 * this only checks the draft here and fills in the web editor with it. Its folder must be synced, because
 * the account names folders by their identity in the collection.
 */
async function forAccount(draft: RuleDraft, link: AccountLink | null): Promise<BrowserRuleResponse> {
  const checked = checkRuleDraft(draft);
  if (!checked.ok) return { ok: false, error: 'invalid', problems: checked.problems };
  // The account's rules file into a synced folder by the web editor's own conditions.
  const folderNativeId = ruleFolderNativeId(draft);
  if (!folderNativeId) return { ok: false, error: 'notOnWeb' };
  if (!link?.webUrl) return { ok: false, error: 'signedOut' };
  const folder = await link.canonical(folderNativeId).catch(() => null);
  if (!folder) return { ok: false, error: 'notSynced' };
  const url = accountEditorUrl(link.webUrl, { definition: checked.definition }, folder);
  return url ? { ok: true, url } : { ok: false, error: 'notOnWeb' };
}
