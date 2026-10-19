import { compilePredicate, validateM1Rule, type Predicate, type RuleDefinition } from '@know-n/colp/automation';

/**
 * A browser rule's conditions as the Owner writes them (doc 17 R5): the stored truth, compiled into the
 * M1 placement definition the shared evaluator runs. Every kind compiles to an operator the shared
 * core already has, so nothing here changes `@know-n/colp/automation`:
 *
 * - *Site is* → host `eq`; *Site or its subdomains* → host `hostSuffix` (dot boundary);
 * - *Title contains* → title `contains`; *Link path starts with* → path `startsWith` (literal);
 * - *Link path is or is under /x* → `any(path eq /x, path startsWith /x/)`, so `/team` matches
 *   `/team` and `/team/x` but not `/team-other`;
 * - *Site from a collection* (`<subscriptionId>/<siteId>`) → `any` over that site's live addresses in the
 *   subscription's current version (RS-10), recompiled whenever it activates another version.
 *
 * Tags are written after the bookmark exists, so no tag condition is offered: it would never match at save.
 */
export type ConditionKind = 'siteIs' | 'siteEndsWith' | 'titleContains' | 'pathStartsWith' | 'pathUnder' | 'siteCollection';
export const CONDITION_KINDS: readonly ConditionKind[] = ['siteIs', 'siteEndsWith', 'titleContains', 'pathStartsWith', 'pathUnder', 'siteCollection'];
export const CONDITION_LIMIT = 8;
export const VALUE_LIMIT = 512, NAME_LIMIT = 200;
export const DESTINATION_ROLE = 'destination';
export const BROWSER_PRIORITY = 100;

export interface RuleCondition { readonly kind: ConditionKind; readonly value: string }
/** A site of a subscription's collection as a condition names it, and back. */
export const collectionValue = (subscriptionId: string, siteId: string) => `${subscriptionId}/${siteId}`;
export function collectionRef(value: string): { readonly subscriptionId: string; readonly siteId: string } | null {
  const match = /^([\w-]{1,128})\/([A-Za-z0-9._-]{1,64})$/u.exec(value.trim());
  return match ? { subscriptionId: match[1]!, siteId: match[2]! } : null;
}
/** A collection's site in its subscription's current version: its name, its live addresses as one predicate (null: none left), and that version. */
export interface CollectionSite { readonly name: string; readonly predicate: Predicate | null; readonly version: string }
export type CollectionLookup = (subscriptionId: string, siteId: string) => CollectionSite | null;
/** What a matching rule does: file into a folder here (by native id, or by its set's role) or keep the page where it was saved. */
export type RuleAction = { readonly kind: 'file'; readonly folderNativeId: string } | { readonly kind: 'file'; readonly role: string }
  | { readonly kind: 'keepHere' };

/** What the editor writes. */
export interface RuleDraft {
  readonly name: string;
  readonly combinator: 'all' | 'any';
  readonly conditions: readonly RuleCondition[];
  readonly action: RuleAction;
}

export type DraftProblem =
  | { readonly field: 'conditions'; readonly code: 'required' | 'tooMany' }
  /**
   * `collection`: the site is gone from its subscription, the subscription is, or it has no live address;
   * `oneCollection`: a rule's sites come from one subscription, so each version recompiles it whole.
   */
  | { readonly field: 'condition'; readonly index: number; readonly code: 'invalidHost' | 'invalidPath' | 'tooLong' | 'kind' | 'collection' | 'oneCollection' }
  | { readonly field: 'folder'; readonly code: 'required' }
  | { readonly field: 'name'; readonly code: 'tooLong' };

const isSite = (kind: ConditionKind) => kind === 'siteIs' || kind === 'siteEndsWith';
const isPath = (kind: ConditionKind) => kind === 'pathStartsWith' || kind === 'pathUnder';

/** A pasted link stands for its site ("https://arxiv.org/abs/1" is arxiv.org) or its path; anything else is checked as typed. */
export function conditionValue(kind: ConditionKind, raw: string): string {
  const value = raw.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(value) || !(isSite(kind) || isPath(kind))) return value;
  try { const url = new URL(value); return isSite(kind) ? url.hostname : url.pathname; } catch { return value; }
}

/** `/team/` and `team` are `/team`; the root stays `/`. */
const pathRoot = (value: string) => `/${value.replace(/^\/+|\/+$/gu, '')}`;

const FIELD: Record<Exclude<ConditionKind, 'pathUnder' | 'siteCollection'>, Pick<Extract<Predicate, { kind: 'field' }>, 'field' | 'op'>> = {
  siteIs: { field: 'bookmark.url.host', op: 'eq' },
  siteEndsWith: { field: 'bookmark.url.host', op: 'hostSuffix' },
  titleContains: { field: 'bookmark.title', op: 'contains' },
  pathStartsWith: { field: 'bookmark.url.path', op: 'startsWith' },
};
const field = (kind: Exclude<ConditionKind, 'pathUnder' | 'siteCollection'>, value: string): Predicate => ({ kind: 'field', ...FIELD[kind], value });

/** Null only for a collection's site that cannot be read now. */
export function conditionPredicate(condition: RuleCondition, collections?: CollectionLookup): Predicate | null {
  const value = conditionValue(condition.kind, condition.value);
  if (condition.kind === 'siteCollection') {
    const ref = collectionRef(value);
    return ref ? collections?.(ref.subscriptionId, ref.siteId)?.predicate ?? null : null;
  }
  if (condition.kind !== 'pathUnder') return field(condition.kind, value);
  const root = pathRoot(value);
  return root === '/' ? field('pathStartsWith', '/')
    : { kind: 'any', items: [{ kind: 'field', field: 'bookmark.url.path', op: 'eq', value: root }, field('pathStartsWith', `${root}/`)] };
}

/** "arxiv.org" for a site rule, else the first value: what the web suggests when a rule has no name. */
export function fallbackName(conditions: readonly RuleCondition[], collections?: CollectionLookup): string {
  const first = conditions.find((condition) => condition.value.trim() !== '');
  if (!first) return 'Rule';
  const ref = first.kind === 'siteCollection' ? collectionRef(first.value) : null;
  const site = ref ? collections?.(ref.subscriptionId, ref.siteId) : null;
  return (site ? site.name : conditionValue(first.kind, first.value)).slice(0, NAME_LIMIT);
}

/** The M1 placement definition for these conditions, before normalization. */
export function ruleDefinition(name: string, combinator: 'all' | 'any', conditions: readonly RuleCondition[], collections?: CollectionLookup): RuleDefinition {
  const items = conditions.filter((condition) => condition.value.trim() !== '').flatMap((condition) => conditionPredicate(condition, collections) ?? []);
  const [only] = items;
  return definitionFor(name.trim() || fallbackName(conditions, collections), items.length === 1 && only ? only : { kind: combinator, items });
}

/** The M1 placement definition around a match, whoever wrote it: the editor, or a rule set's entry (ruleset-format.ts). */
export function definitionFor(name: string, match: Predicate): RuleDefinition {
  return {
    apiVersion: 'colp.automation/v1',
    name,
    roles: [{ key: DESTINATION_ROLE, kind: 'folder', required: true, description: 'Folder in this browser that matching pages are saved to' }],
    on: 'bookmark.intake',
    scope: {},
    match,
    intake: { folderRole: DESTINATION_ROLE, constraint: 'withinSubtree', satisfies: ['classify.root'], onUnusableBinding: 'keepOriginalAndBlock',
      respectExplicitSelection: true },
    trigger: { mode: 'each' },
    tasks: [],
    route: { mode: 'targets', targetIds: [], execution: 'single' },
    policy: { history: 'fromActivation', imports: 'exclude', restores: 'exclude', userEdits: 'preserve', sameStageReentry: 'deny', maxHops: 8,
      conflictingPlacement: 'review', privacy: 'standard', broadcastAllowed: false, maxRunsPerDay: 100, pauseMode: 'stopAdmissionHoldPending',
      missingInput: 'defer' },
    priority: BROWSER_PRIORITY,
  };
}

export type CheckedDraft = { readonly ok: true; readonly name: string; readonly conditions: readonly RuleCondition[]; readonly definition: RuleDefinition;
  /** Subscription id → the version its collection's sites were read from. */
  readonly contentVersions: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly problems: readonly DraftProblem[] };

/**
 * Checks a draft and returns what to store: the filled conditions as written (a pasted link reduced to
 * its site or path), and their definition normalized the way the evaluator compares, so what is
 * stored is what runs. Problems name the field the editor should point at. A collection's site is read
 * through `collections`; without it such a condition is a problem.
 */
export function checkRuleDraft(draft: RuleDraft, collections?: CollectionLookup): CheckedDraft {
  const problems: DraftProblem[] = [];
  const filled = draft.conditions.map((condition, index) => ({ ...condition, index })).filter((condition) => condition.value.trim() !== '');
  if (!filled.length) problems.push({ field: 'conditions', code: 'required' });
  if (filled.length > CONDITION_LIMIT) problems.push({ field: 'conditions', code: 'tooMany' });
  for (const condition of filled) {
    if (!CONDITION_KINDS.includes(condition.kind)) { problems.push({ field: 'condition', index: condition.index, code: 'kind' }); continue; }
    const value = conditionValue(condition.kind, condition.value);
    if (value.length > VALUE_LIMIT) { problems.push({ field: 'condition', index: condition.index, code: 'tooLong' }); continue; }
    if (condition.kind === 'siteCollection') {
      const predicate = conditionPredicate(condition, collections), first = filled.find((item) => item.kind === 'siteCollection')!;
      if (collectionRef(value)?.subscriptionId !== collectionRef(first.value)?.subscriptionId) {
        problems.push({ field: 'condition', index: condition.index, code: 'oneCollection' });
      } else if (!predicate || !compilePredicate(predicate).valid) problems.push({ field: 'condition', index: condition.index, code: 'collection' });
      continue;
    }
    if (isSite(condition.kind) && !compilePredicate(conditionPredicate(condition)!).valid) {
      problems.push({ field: 'condition', index: condition.index, code: 'invalidHost' });
    } else if (isPath(condition.kind) && !compilePredicate(conditionPredicate(condition)!).valid) {
      problems.push({ field: 'condition', index: condition.index, code: 'invalidPath' });
    }
  }
  if (draft.action.kind === 'file' && 'folderNativeId' in draft.action && !draft.action.folderNativeId) problems.push({ field: 'folder', code: 'required' });
  if (draft.name.trim().length > NAME_LIMIT) problems.push({ field: 'name', code: 'tooLong' });
  if (problems.length) return { ok: false, problems };
  const conditions = filled.map(({ kind, value }) => ({ kind, value: conditionValue(kind, value) }));
  const definition = ruleDefinition(draft.name, draft.combinator, conditions, collections);
  const compiled = compilePredicate(definition.match);
  if (!compiled.valid || validateM1Rule(definition).length) return { ok: false, problems: [{ field: 'conditions', code: 'required' }] };
  const contentVersions: Record<string, string> = {};
  for (const condition of conditions) {
    const ref = condition.kind === 'siteCollection' ? collectionRef(condition.value) : null;
    const site = ref ? collections?.(ref.subscriptionId, ref.siteId) : null;
    if (ref && site) contentVersions[ref.subscriptionId] = site.version;
  }
  return { ok: true, name: definition.name, conditions, definition: { ...definition, match: compiled.normalizedPredicate }, contentVersions };
}
