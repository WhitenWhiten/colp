import type { RuleDefinition } from '@know-n/colp/automation';

/**
 * A rule's conditions in the shapes the web's rule editor writes, so Options
 * can say them the way the web does ("From arxiv.org"). Anything the editor
 * cannot write (a nested group, a CEL expression, a list value) has no short
 * form here, and the page falls back to "matches its conditions".
 */
/** `siteCollection` is shown by its site's name, from what the browser rule wrote. */
export type ConditionKind = 'siteIs' | 'siteEndsWith' | 'titleContains' | 'hasTag' | 'pathStartsWith' | 'pathUnder' | 'siteCollection';

export interface RuleMatchView {
  readonly combinator: 'all' | 'any';
  readonly conditions: readonly { readonly kind: ConditionKind; readonly value: string }[];
}

type Predicate = RuleDefinition['match'];

/** A browser rule's "path is or is under" compiles to a group (rule-conditions.ts), so it is only ever shown from what was written. */
const KINDS: readonly (readonly [Exclude<ConditionKind, 'pathUnder' | 'siteCollection'>, string, string])[] = [
  ['siteIs', 'bookmark.url.host', 'eq'],
  ['siteEndsWith', 'bookmark.url.host', 'hostSuffix'],
  ['titleContains', 'bookmark.title', 'contains'],
  ['hasTag', 'bookmark.tags', 'hasTag'],
  ['pathStartsWith', 'bookmark.url.path', 'startsWith'],
];

function condition(predicate: Predicate): RuleMatchView['conditions'][number] | null {
  if (predicate.kind !== 'field' || typeof predicate.value !== 'string') return null;
  const found = KINDS.find(([, field, op]) => field === predicate.field && op === predicate.op);
  return found ? { kind: found[0], value: predicate.value } : null;
}

export function ruleMatchView(match: Predicate): RuleMatchView | null {
  const grouped = match.kind === 'all' || match.kind === 'any';
  const items = grouped ? match.items : [match];
  const conditions = items.map(condition);
  if (!conditions.length || conditions.some((item) => item === null)) return null;
  return { combinator: match.kind === 'any' ? 'any' : 'all', conditions: conditions as RuleMatchView['conditions'] };
}
