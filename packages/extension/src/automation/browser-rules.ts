import { compilePredicate, validateM1Rule, type FolderRef, type PlacementIntent, type Predicate, type RuleDefinition } from '@know-n/colp/automation';
import { preSaveFacts } from './pre-save.js';
import { ruleMatchView, type ConditionKind, type RuleMatchView } from './rule-match.js';
import { evaluateLocalRules, type EvaluableRule, type LocalFolder, type LocalRule } from './runtime-profile.js';

/**
 * Browser rules: the Owner's own placement rules, kept in this browser only
 * (design 01 §7.5, ADR-A24). Each is the M1 placement definition the web editor
 * writes, without a collection, plus the native folder it files into. They need
 * no account, work offline and may name any folder.
 *
 * At save they come after the account's rules: an account rule's outcome
 * settles the save, and only a page no account rule matches is decided here.
 * Among themselves they use the shared arbitration, so two rules that send the
 * same page to different folders keep it where it was saved and say so.
 */
export type BrowserConditionKind = Exclude<ConditionKind, 'hasTag'>;
/** Tags are written after the bookmark exists, so a tag condition never matches at save. */
export const BROWSER_CONDITION_KINDS: readonly BrowserConditionKind[] = ['siteIs', 'siteEndsWith', 'titleContains', 'pathStartsWith'];
export const BROWSER_RULE_LIMIT = 100;
export const BROWSER_CONDITION_LIMIT = 8;
const VALUE_LIMIT = 512, NAME_LIMIT = 200;
export const DESTINATION_ROLE = 'destination';
export const BROWSER_PRIORITY = 100;

/** What the editor writes. */
export interface BrowserRuleDraft {
  readonly name: string;
  readonly combinator: 'all' | 'any';
  readonly conditions: readonly { readonly kind: BrowserConditionKind; readonly value: string }[];
  readonly folderNativeId: string;
}

export interface BrowserRule {
  readonly id: string;
  /** Normalized the way the evaluator compares, so what is stored is what runs. */
  readonly definition: RuleDefinition;
  readonly folderNativeId: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Overlaps with the account's rules the Owner looked at and kept (AW-69), by the account rule's
   * revision: a changed account rule is shown again.
   */
  readonly reviewed?: readonly { readonly accountRuleId: string; readonly key: string }[];
  /**
   * When the Owner chose Add mine to the account (AW-71). The rule keeps filing until the account's
   * enabled copy reaches this browser, then retires.
   */
  readonly movingSince?: number;
}

export type DraftProblem =
  | { readonly field: 'conditions'; readonly code: 'required' | 'tooMany' }
  | { readonly field: 'condition'; readonly index: number; readonly code: 'invalidHost' | 'tooLong' | 'kind' }
  | { readonly field: 'folder'; readonly code: 'required' }
  | { readonly field: 'name'; readonly code: 'tooLong' };

const FIELD: Record<BrowserConditionKind, Pick<Extract<Predicate, { kind: 'field' }>, 'field' | 'op'>> = {
  siteIs: { field: 'bookmark.url.host', op: 'eq' },
  siteEndsWith: { field: 'bookmark.url.host', op: 'hostSuffix' },
  titleContains: { field: 'bookmark.title', op: 'contains' },
  pathStartsWith: { field: 'bookmark.url.path', op: 'startsWith' },
};

/** A pasted link stands for its site: "https://arxiv.org/abs/1" is arxiv.org. Anything else is checked as typed. */
function siteValue(raw: string): string {
  const value = raw.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) return value;
  try { return new URL(value).hostname; } catch { return value; }
}

function conditionValue(kind: BrowserConditionKind, raw: string): string {
  return kind === 'siteIs' || kind === 'siteEndsWith' ? siteValue(raw) : raw.trim();
}

/** The M1 placement definition for a draft, before normalization. */
export function browserRuleDefinition(draft: BrowserRuleDraft): RuleDefinition {
  const items: Predicate[] = draft.conditions.filter((condition) => condition.value.trim() !== '')
    .map((condition) => ({ kind: 'field', ...FIELD[condition.kind], value: conditionValue(condition.kind, condition.value) }));
  const [only] = items;
  return {
    apiVersion: 'colp.automation/v1',
    name: draft.name.trim() || fallbackName(draft),
    roles: [{ key: DESTINATION_ROLE, kind: 'folder', required: true, description: 'Folder in this browser that matching pages are saved to' }],
    on: 'bookmark.intake',
    scope: {},
    match: items.length === 1 && only ? only : { kind: draft.combinator, items },
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

/** "arxiv.org" for a site rule, else the first value: what the web suggests when a rule has no name. */
function fallbackName(draft: BrowserRuleDraft): string {
  const first = draft.conditions.find((condition) => condition.value.trim() !== '');
  return first ? conditionValue(first.kind, first.value).slice(0, NAME_LIMIT) : 'Rule';
}

/** Checks a draft and returns the definition to store, or what the editor should point at. */
export function checkBrowserDraft(draft: BrowserRuleDraft): { readonly ok: true; readonly definition: RuleDefinition }
  | { readonly ok: false; readonly problems: readonly DraftProblem[] } {
  const problems: DraftProblem[] = [];
  const filled = draft.conditions.map((condition, index) => ({ ...condition, index })).filter((condition) => condition.value.trim() !== '');
  if (!filled.length) problems.push({ field: 'conditions', code: 'required' });
  if (filled.length > BROWSER_CONDITION_LIMIT) problems.push({ field: 'conditions', code: 'tooMany' });
  for (const condition of filled) {
    if (!BROWSER_CONDITION_KINDS.includes(condition.kind)) { problems.push({ field: 'condition', index: condition.index, code: 'kind' }); continue; }
    const value = conditionValue(condition.kind, condition.value);
    if (value.length > VALUE_LIMIT) { problems.push({ field: 'condition', index: condition.index, code: 'tooLong' }); continue; }
    if (FIELD[condition.kind].field === 'bookmark.url.host' && !compilePredicate({ kind: 'field', ...FIELD[condition.kind], value }).valid) {
      problems.push({ field: 'condition', index: condition.index, code: 'invalidHost' });
    }
  }
  if (!draft.folderNativeId) problems.push({ field: 'folder', code: 'required' });
  if (draft.name.trim().length > NAME_LIMIT) problems.push({ field: 'name', code: 'tooLong' });
  if (problems.length) return { ok: false, problems };
  const definition = browserRuleDefinition(draft);
  const compiled = compilePredicate(definition.match);
  if (!compiled.valid || validateM1Rule(definition).length) return { ok: false, problems: [{ field: 'conditions', code: 'required' }] };
  return { ok: true, definition: { ...definition, match: compiled.normalizedPredicate } };
}

/** The editor's form for a stored rule; null when its conditions have no short form (never written by this editor). */
export function draftFromRule(rule: Pick<BrowserRule, 'definition' | 'folderNativeId'>): BrowserRuleDraft | null {
  const match = ruleMatchView(rule.definition.match);
  if (!match || match.conditions.some((condition) => condition.kind === 'hasTag')) return null;
  return { name: rule.definition.name, combinator: match.combinator, folderNativeId: rule.folderNativeId,
    conditions: match.conditions.map((condition) => ({ kind: condition.kind as BrowserConditionKind, value: condition.value })) };
}

/**
 * The web editor filled in with this rule (AW-70): the same name and conditions, and its folder by the
 * canonical identity Sync gave it. Null for a rule the editor cannot show.
 */
export function accountEditorUrl(webUrl: string, rule: Pick<BrowserRule, 'definition' | 'folderNativeId'>,
  folder: { readonly collectionId: string; readonly nodeId: string }): string | null {
  const draft = draftFromRule(rule);
  if (!draft) return null;
  const url = new URL(`${webUrl.replace(/\/$/u, '')}/new`);
  url.searchParams.set('collectionId', folder.collectionId);
  url.searchParams.set('folderId', folder.nodeId);
  url.searchParams.set('name', rule.definition.name);
  url.searchParams.set('combinator', draft.combinator);
  for (const condition of draft.conditions) url.searchParams.append('condition', `${condition.kind}:${condition.value}`);
  url.searchParams.set('from', 'browser');
  return url.toString();
}

export function browserRuleMatch(rule: BrowserRule): RuleMatchView | null {
  return ruleMatchView(rule.definition.match);
}

/** Browser folders, named in the shared core's terms. No server or collection is involved. */
export const BROWSER_COLLECTION = 'browser';
export const browserFolderRef = (nativeId: string): FolderRef => ({ serverUuid: 'browser', collectionId: BROWSER_COLLECTION, nodeId: nativeId });

/** A browser rule's folder, looked up in this browser now. */
export interface FolderLookup {
  (nativeId: string): Promise<{ readonly id: string; readonly title: string; readonly parentId?: string; readonly url?: string;
    readonly unmodifiable?: string } | null>;
}

export async function resolveBrowserFolder(nativeId: string, lookup: FolderLookup): Promise<LocalFolder> {
  const folder = browserFolderRef(nativeId);
  const node = await lookup(nativeId).catch(() => null);
  if (!node) return { status: 'unresolved', folder, reason: 'deleted' };
  if (node.url !== undefined || node.unmodifiable) return { status: 'unresolved', folder, reason: 'notFolder' };
  return { status: 'resolved', folder, nativeId: node.id, title: node.title };
}

export interface BrowserDecision {
  readonly outcome: 'placed' | 'kept' | 'blocked' | 'conflict';
  readonly reason?: 'bindingUnavailable' | 'evaluation';
  /** The placing rule, or the first matching one. */
  readonly rule: { readonly id: string; readonly name: string };
  readonly ruleIds: readonly string[];
  /** The rule's folder; only a placement has one. */
  readonly folder: { readonly nativeId: string; readonly title: string } | null;
}

/**
 * What the enabled browser rules do with a page saved to `parentNativeId`.
 * `explicit`: the Owner picked that folder for this save, so no rule moves it.
 * Null when no rule matches.
 */
export async function decideBrowserRules(rules: readonly BrowserRule[], page: { readonly url: string; readonly title: string; readonly explicit: boolean },
  lookup: FolderLookup, now: number): Promise<BrowserDecision | null> {
  const enabled = rules.filter((rule) => rule.enabled);
  if (!enabled.length) return null;
  const local: LocalRule<EvaluableRule>[] = await Promise.all(enabled.map(async (rule) => ({
    rule: { ruleId: rule.id, definition: rule.definition },
    folders: { [rule.definition.intake?.folderRole ?? DESTINATION_ROLE]: await resolveBrowserFolder(rule.folderNativeId, lookup) } })));
  const intent: PlacementIntent = page.explicit ? 'userSelected' : 'userDefault';
  const placement = evaluateLocalRules(local, preSaveFacts(page, BROWSER_COLLECTION, { ancestors: [] }, intent, now), intent);
  if (placement.kind === 'none') return null;
  const ruleId = placement.kind === 'place' ? placement.ruleId : placement.ruleIds[0]!;
  const rule = enabled.find((item) => item.id === ruleId)!;
  const named = { id: rule.id, name: rule.definition.name };
  switch (placement.kind) {
    case 'place': return { outcome: 'placed', rule: named, ruleIds: placement.ruleIds,
      folder: { nativeId: placement.folder.nativeId, title: placement.folder.title } };
    case 'keep': return { outcome: 'kept', rule: named, ruleIds: placement.ruleIds, folder: null };
    case 'conflict': return { outcome: 'conflict', rule: named, ruleIds: placement.ruleIds, folder: null };
    case 'blocked': return { outcome: 'blocked', reason: placement.reason, rule: named, ruleIds: placement.ruleIds, folder: null };
    // Only an unknown intent asks for review, and a save always knows whether its folder was picked.
    case 'review': return { outcome: 'blocked', reason: 'evaluation', rule: named, ruleIds: placement.ruleIds, folder: null };
  }
}
