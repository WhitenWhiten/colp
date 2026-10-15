import { compilePredicate, preparePredicateInput, type EventFacts, type Predicate, type RuleDefinition } from '@know-n/colp/automation';
import { preSaveFacts } from './pre-save.js';

/**
 * How a browser rule stands next to the account's rules (design 01 §7.5,
 * AW-69). Two signals, both through the shared evaluator:
 *
 * - **Witness.** A page built from both rules' own conditions (their sites,
 *   paths and title words) that both match proves they can file the same page.
 *   Finding none proves nothing, so it is only one signal.
 * - **Replay.** Both sets run over this browser's recent bookmarks; the count
 *   is how many real pages both would take.
 *
 * A browser rule that some page shares with an account rule is a *duplicate*
 * when their conditions are the same after normalization and they file into the
 * same folder here, and a *conflict* when the folders differ (the account's
 * rule wins at save, so the browser rule never files those pages). Sharing
 * pages into the same folder with other conditions changes nothing and is not
 * reported. A scope folder on an account rule is not modelled: the overlap may
 * then be narrower than reported, never wider than a real page shows.
 */
export interface OverlapRule {
  readonly id: string;
  readonly definition: RuleDefinition;
  /** Where it files in this browser; null when the folder is not here. */
  readonly folderNativeId: string | null;
}
export interface Page { readonly url: string; readonly title: string }
export interface Relation {
  readonly kind: 'duplicate' | 'conflict';
  readonly accountRuleId: string;
  /** Replayed bookmarks both rules match. */
  readonly pages: number;
}

const WITNESS_HOST = 'witness.invalid';
const MAX_WITNESSES = 256;
type Matcher = (facts: EventFacts, input?: ReturnType<typeof preparePredicateInput>) => boolean;

function matcher(definition: RuleDefinition): Matcher | null {
  const compiled = compilePredicate(definition.match);
  if (!compiled.valid) return null;
  return (facts, input) => compiled.evaluate(facts, input ? { inputSnapshot: input } : undefined).outcome === 'matched';
}

const facts = (page: Page, now: number) => preSaveFacts(page, 'browser', { ancestors: [] }, 'userDefault', now);

/** The values a rule asks for, by field: what a page must look like to have a chance of matching. */
function values(predicate: Predicate, into = { hosts: new Set<string>(), paths: new Set<string>(), titles: new Set<string>() }) {
  if (predicate.kind === 'all' || predicate.kind === 'any') { for (const item of predicate.items) values(item, into); return into; }
  if (predicate.kind !== 'field') return into;
  const list = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
  for (const value of list) {
    if (typeof value !== 'string') continue;
    if (predicate.field === 'bookmark.url.host') into.hosts.add(value);
    else if (predicate.field === 'bookmark.url.path') into.paths.add(value.startsWith('/') ? value : `/${value}`);
    else if (predicate.field === 'bookmark.title') into.titles.add(value);
  }
  return into;
}

/** A page both rules match, built only from their own values; null when none of those pages is shared. */
export function witnessOverlap(a: RuleDefinition, b: RuleDefinition, now: number): Page | null {
  const matchA = matcher(a), matchB = matcher(b);
  if (!matchA || !matchB) return null;
  const left = values(a.match), right = values(b.match);
  const hosts = [...new Set([...left.hosts, ...right.hosts])];
  const paths = [...new Set([...left.paths, ...right.paths, '/'])];
  const words = [...new Set([...left.titles, ...right.titles])];
  const titles = [...new Set([words.join(' '), ...words, ''])];
  let tried = 0;
  for (const host of hosts.length ? hosts : [WITNESS_HOST]) {
    for (const path of paths) {
      for (const title of titles) {
        if (++tried > MAX_WITNESSES) return null;
        const page = { url: `https://${host}${path}`, title };
        const shared = facts(page, now);
        if (matchA(shared) && matchB(shared)) return page;
      }
    }
  }
  return null;
}

/** Group order is not meaning: "a and b" is "b and a". */
function canonical(predicate: Predicate): unknown {
  if (predicate.kind === 'all' || predicate.kind === 'any') {
    const items = predicate.items.map(canonical).map((item) => JSON.stringify(item)).sort();
    return items.length === 1 ? JSON.parse(items[0]!) : { kind: predicate.kind, items };
  }
  if (predicate.kind === 'not') return { kind: 'not', item: canonical(predicate.item) };
  return predicate;
}
export const sameMatch = (a: Predicate, b: Predicate) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** How many of `pages` each browser rule shares with each account rule: browser id → account id → count. */
export function replayOverlap(browser: readonly OverlapRule[], account: readonly OverlapRule[], pages: readonly Page[], now: number): Map<string, Map<string, number>> {
  const left = browser.map((rule) => [rule.id, matcher(rule.definition)] as const).filter((entry): entry is readonly [string, Matcher] => entry[1] !== null);
  const right = account.map((rule) => [rule.id, matcher(rule.definition)] as const).filter((entry): entry is readonly [string, Matcher] => entry[1] !== null);
  const counts = new Map<string, Map<string, number>>();
  if (!left.length || !right.length) return counts;
  for (const page of pages) {
    const shared = facts(page, now), input = preparePredicateInput(shared);
    const hitsRight = right.filter(([, match]) => match(shared, input)).map(([id]) => id);
    if (!hitsRight.length) continue;
    for (const [id, match] of left) {
      if (!match(shared, input)) continue;
      const row = counts.get(id) ?? new Map<string, number>();
      for (const other of hitsRight) row.set(other, (row.get(other) ?? 0) + 1);
      counts.set(id, row);
    }
  }
  return counts;
}

/**
 * The one account rule a browser rule should be shown against: a duplicate
 * first, else the conflict that shares the most pages (then the bundle's order).
 * Null when it has nothing to do with any of them.
 */
export function relateBrowserRule(rule: OverlapRule, account: readonly OverlapRule[], counts: ReadonlyMap<string, number> | undefined, now: number): Relation | null {
  let best: Relation | null = null;
  for (const other of account) {
    const pages = counts?.get(other.id) ?? 0;
    const sameFolder = other.folderNativeId !== null && other.folderNativeId === rule.folderNativeId;
    // The same rule is a duplicate even when no page could satisfy it.
    if (sameFolder && sameMatch(rule.definition.match, other.definition.match)) return { kind: 'duplicate', accountRuleId: other.id, pages };
    if (sameFolder || (!pages && !witnessOverlap(rule.definition, other.definition, now))) continue;
    if (!best || pages > best.pages) best = { kind: 'conflict', accountRuleId: other.id, pages };
  }
  return best;
}
