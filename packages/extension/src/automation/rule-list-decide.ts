import { admitsSiteEdge, type SiteRuleEdge } from './site-rule.js';
import { compilePredicate, preparePredicateInput, type PlacementIntent } from '@know-n/colp/automation';
import { BROWSER_COLLECTION, resolveBrowserFolder, type FolderLookup } from './browser-rules.js';
import { preSaveFacts } from './pre-save.js';
import type { FlatItem } from './rule-list-flatten.js';

/**
 * First match over this browser's ordered list (doc 17 §6.2, R8). Entries are tried top to bottom
 * against one prepared input; the first that matches decides and nothing below it is consulted:
 *
 * - `notMatched` → the next entry; `missingInput` → the next entry, noted as skipped;
 * - `error` → stop, `blocked` (`evaluation`);
 * - a match that keeps the page here → stop, `kept` (`keepHere`);
 * - a match whose folder is gone, not a folder, or not bound → stop, `blocked` (`bindingUnavailable`);
 * - a match with its folder → stop, `placed`.
 *
 * A folder the Owner picked for this save is theirs: the first entry that matches it is named, and the
 * page is `kept` where they put it, as the shared arbitration does for `userSelected`. Preview runs the
 * same loop to the end and reports every later match as shadowed by the winner (RS-08.2). The only
 * side input is the folder lookup, which the caller supplies.
 */
export interface ListDecision {
  readonly outcome: 'placed' | 'kept' | 'blocked';
  /** Absent on a kept save: the Owner chose its folder. */
  readonly reason?: 'bindingUnavailable' | 'evaluation' | 'keepHere';
  readonly item: FlatItem;
  readonly folder: { readonly nativeId: string; readonly title: string } | null;
}
export interface ListResult {
  /** Null: no entry matched. */
  readonly decision: ListDecision | null;
  /** Entries passed over because the page lacks what they ask about (R8), the first ten. */
  readonly skipped: readonly FlatItem[];
  /** Preview only: later entries that match too, shadowed by the winner. */
  readonly shadowed: readonly FlatItem[];
}
export interface Page { readonly url: string; readonly title: string; readonly explicit: boolean }

const SKIPPED_LIMIT = 10, CACHE_LIMIT = 2_048;
type Compiled = ReturnType<typeof compilePredicate>;
/** Compiled predicates by their exact form; the oldest goes first once the cache is full. */
const compiledCache = new Map<string, Compiled>();
function compiled(item: FlatItem): Compiled {
  const key = JSON.stringify(item.definition.match);
  const hit = compiledCache.get(key);
  if (hit) { compiledCache.delete(key); compiledCache.set(key, hit); return hit; }
  const fresh = compilePredicate(item.definition.match);
  compiledCache.set(key, fresh);
  if (compiledCache.size > CACHE_LIMIT) compiledCache.delete(compiledCache.keys().next().value!);
  return fresh;
}

/** An exception names a host, or a registrable domain with every host under it. */
function excepted(item: FlatItem, host: string): boolean {
  return Boolean(host) && item.exceptions.some((exception) => exception.scope === 'host' ? host === exception.value
    : host === exception.value || host.endsWith(`.${exception.value}`));
}

export async function decideList(items: readonly FlatItem[], page: Page, lookup: FolderLookup, now: number,
  options: { readonly preview?: boolean; readonly site?: SiteRuleEdge } = {}): Promise<ListResult> {
  const intent: PlacementIntent = page.explicit ? 'userSelected' : 'userDefault';
  const initial = preSaveFacts(page, BROWSER_COLLECTION, { ancestors: [] }, options.site ? 'rulePlacement' : intent, now);
  const facts = options.site?.entry === 'siteImport' ? { ...initial, origin: 'import' as const } : initial;
  const input = preparePredicateInput(facts), host = facts.bookmark.url.host;
  const skipped: FlatItem[] = [], shadowed: FlatItem[] = [];
  let winner: FlatItem | null = null, failed = false;
  for (const item of items) {
    if (!admitsSiteEdge(item.site, options.site) || options.site?.entry === 'siteImport' && item.definition.policy.imports !== 'include') continue;
    if (excepted(item, host)) continue;
    const predicate = compiled(item);
    const outcome = predicate.valid ? predicate.evaluate(facts, { inputSnapshot: input }).outcome : 'error';
    if (outcome === 'notMatched') continue;
    if (outcome === 'missingInput') { if (!winner && skipped.length < SKIPPED_LIMIT) skipped.push(item); continue; }
    if (winner) { if (outcome === 'matched') shadowed.push(item); continue; }
    winner = item; failed = outcome === 'error';
    if (!options.preview) break;
  }
  if (!winner) return { decision: null, skipped, shadowed };
  const decision = await decided(winner, failed, page.explicit, lookup);
  return { decision, skipped, shadowed };
}

async function decided(item: FlatItem, failed: boolean, explicit: boolean, lookup: FolderLookup): Promise<ListDecision> {
  if (explicit) return { outcome: 'kept', item, folder: null };
  if (failed) return { outcome: 'blocked', reason: 'evaluation', item, folder: null };
  if (item.action.kind === 'keepHere') return { outcome: 'kept', reason: 'keepHere', item, folder: null };
  const folder = item.action.folderNativeId === null ? null : await resolveBrowserFolder(item.action.folderNativeId, lookup);
  if (folder?.status !== 'resolved') return { outcome: 'blocked', reason: 'bindingUnavailable', item, folder: null };
  return { outcome: 'placed', item, folder: { nativeId: folder.nativeId, title: folder.title } };
}
