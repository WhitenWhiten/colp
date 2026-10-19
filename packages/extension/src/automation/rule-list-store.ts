import { validateM1Rule, type RuleDefinition } from '@know-n/colp/automation';
import { relateBrowserRule, witnessOverlap, type OverlapRule } from './browser-overlap.js';
import { editorConditions } from './browser-rules.js';
import type { AtomicStateArea } from './bundle-store.js';
import { CONDITION_KINDS, CONDITION_LIMIT, NAME_LIMIT, checkRuleDraft, type ConditionKind, type DraftProblem, type RuleAction, type RuleCondition,
  type RuleDraft } from './rule-conditions.js';

/**
 * This browser's rules as one ordered list (doc 17 §4.1, R1): individual rules, local sets of rules
 * and subscriptions, evaluated top to bottom after the account's rules. One record in the automation
 * store (indexeddb-store.ts) next to the account's bundle; nothing here is ever sent anywhere, and
 * signing out leaves it in place.
 *
 * Every change is one read-modify-write of the whole record, taken one at a time, so two pages saving
 * at once never lose a rule, and each adds one to `revision`, which explanations, previews and runs
 * cite. The flat list of earlier builds moves here once, in the order it was kept (the order the Owner
 * made the rules in), in the same transaction that deletes it (R2).
 */
export const RULE_LIST_KEY = 'known.automation.browserRules.v2';
/** Where builds before the ordered list kept their rules. */
export const LEGACY_RULES_KEY = 'known.automation.browserRules.v1';

/** Exceeding one is a save error, never a silent truncation. */
export const LIST_LIMITS = { rules: 200, sets: 50, localRules: 1_000, subscriptions: 20 } as const;
const VALUE_LIMIT = 2_048, REVIEW_LIMIT = 20, NOTICE_PAIRS = 20;

export type RuleOrigin = { readonly kind: 'copiedFrom'; readonly subscriptionId: string; readonly entryId: string; readonly contentVersion: string }
  | { readonly kind: 'import'; readonly sourceId: string; readonly sourceName: string; readonly sourceVersion: string; readonly importedAt: number };

export interface LocalRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly combinator: 'all' | 'any';
  /** What the Owner wrote: the truth (R5). Empty for a rule an earlier build stored with conditions this editor cannot write. */
  readonly conditions: readonly RuleCondition[];
  readonly action: RuleAction;
  /** Compiled from `conditions` and normalized the way the evaluator compares, so what is stored is what runs. */
  readonly definition: RuleDefinition;
  /** Subscription id → the content version its site-collection conditions were compiled from. */
  readonly compiledFrom: { readonly contentVersions: Readonly<Record<string, string>> };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly origin?: RuleOrigin;
  /**
   * Individual rules only. Overlaps with the account's rules the Owner looked at and kept (AW-69), by the
   * account rule's revision: a changed account rule is shown again.
   */
  readonly reviewed?: readonly { readonly accountRuleId: string; readonly key: string }[];
  /** Individual rules only. Add mine to the account was chosen (AW-71): it files until the account's enabled copy arrives. */
  readonly movingSince?: number;
}

export type SetOrigin = { readonly kind: 'custom' } | { readonly kind: 'import'; readonly sourceId: string; readonly sourceName: string;
  readonly sourceVersion: string; readonly publisher: string | null; readonly importedAt: number };
/** A named run of rules in the list (R3: one level, no nesting). */
export interface LocalSet {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly origin: SetOrigin;
  /** An imported set's folder roles; a custom set has none. */
  readonly roles: readonly { readonly key: string; readonly description: string }[];
  /** Role key → native folder id. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly rules: readonly LocalRule[];
}

export type ListEntry = { readonly kind: 'rule'; readonly rule: LocalRule } | { readonly kind: 'set'; readonly set: LocalSet }
  | { readonly kind: 'subscription'; readonly subscriptionId: string; readonly enabled: boolean };

export interface RuleListRecord {
  readonly version: 2;
  /** +1 per write. */
  readonly revision: number;
  /** The whole list's switch; the account's pause still overrides it. */
  readonly enabled: boolean;
  /** Execution order, top to bottom. */
  readonly entries: readonly ListEntry[];
  /** Migrated rules that could take one page to different folders (R2): the upper one now files it. Gone once dismissed. */
  readonly orderNotice?: { readonly pairs: readonly (readonly [string, string])[]; readonly shownAt: number | null };
}

export const EMPTY_LIST: RuleListRecord = { version: 2, revision: 0, enabled: true, entries: [] };
export const entryId = (entry: ListEntry): string =>
  entry.kind === 'rule' ? entry.rule.id : entry.kind === 'set' ? entry.set.id : entry.subscriptionId;

/** The rules outside any set, in list order. */
export const individualRules = (list: RuleListRecord): LocalRule[] =>
  list.entries.flatMap((entry) => entry.kind === 'rule' ? [entry.rule] : []);

/** Where a rule files: its own folder, or the one its set binds its role to. Null for keep here and for an unbound role. */
export function ruleFolderNativeId(rule: Pick<LocalRule, 'action'>, set?: Pick<LocalSet, 'bindings'> | null): string | null {
  if (rule.action.kind === 'keepHere') return null;
  return 'folderNativeId' in rule.action ? rule.action.folderNativeId : set?.bindings[rule.action.role] ?? null;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** Closed: every required key is there and no other key is. */
function closed(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
const ID = /^[\w-]{1,128}$/u, FOLDER = /^[\w.-]{1,128}$/u, ROLE = /^[A-Za-z0-9._-]{1,64}$/u;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown, pattern: RegExp): value is Record<string, string> =>
  record(value) && Object.entries(value).every(([key, item]) => pattern.test(key) && typeof item === 'string' && FOLDER.test(item));

function validAction(value: unknown): value is RuleAction {
  if (!record(value)) return false;
  if (value.kind === 'keepHere') return closed(value, ['kind']);
  return value.kind === 'file' && (closed(value, ['kind', 'folderNativeId']) && typeof value.folderNativeId === 'string' && FOLDER.test(value.folderNativeId)
    || closed(value, ['kind', 'role']) && typeof value.role === 'string' && ROLE.test(value.role));
}
function validOrigin(value: unknown): value is RuleOrigin {
  if (!record(value)) return false;
  if (value.kind === 'copiedFrom') return closed(value, ['kind', 'subscriptionId', 'entryId', 'contentVersion'])
    && text(value.subscriptionId, 128) && text(value.entryId, 64) && text(value.contentVersion, 64);
  return value.kind === 'import' && closed(value, ['kind', 'sourceId', 'sourceName', 'sourceVersion', 'importedAt'])
    && text(value.sourceId, 64) && text(value.sourceName, NAME_LIMIT) && text(value.sourceVersion, 64) && time(value.importedAt);
}
function validReviewed(value: unknown): value is LocalRule['reviewed'] {
  return Array.isArray(value) && value.length <= REVIEW_LIMIT && value.every((item) => record(item) && closed(item, ['accountRuleId', 'key'])
    && text(item.accountRuleId, 256) && text(item.key, 512));
}

/** A stored rule this build can run; anything else is dropped rather than guessed at. */
function parseRule(value: unknown): LocalRule | null {
  if (!record(value) || !closed(value, ['id', 'enabled', 'name', 'combinator', 'conditions', 'action', 'definition', 'compiledFrom', 'createdAt',
    'updatedAt'], ['origin', 'reviewed', 'movingSince'])) return null;
  const { compiledFrom } = value;
  const valid = typeof value.id === 'string' && ID.test(value.id) && typeof value.enabled === 'boolean' && text(value.name, NAME_LIMIT)
    && (value.combinator === 'all' || value.combinator === 'any') && Array.isArray(value.conditions) && value.conditions.length <= CONDITION_LIMIT
    && value.conditions.every((item) => record(item) && closed(item, ['kind', 'value'])
      && CONDITION_KINDS.includes(item.kind as ConditionKind) && text(item.value, VALUE_LIMIT))
    && validAction(value.action) && !validateM1Rule(value.definition).length
    && record(compiledFrom) && closed(compiledFrom, ['contentVersions']) && record(compiledFrom.contentVersions)
    && Object.values(compiledFrom.contentVersions).every((version) => text(version, 64))
    && time(value.createdAt) && time(value.updatedAt) && (value.origin === undefined || validOrigin(value.origin))
    && (value.reviewed === undefined || validReviewed(value.reviewed)) && (value.movingSince === undefined || time(value.movingSince));
  return valid ? value as unknown as LocalRule : null;
}

function parseSet(value: unknown): LocalSet | null {
  if (!record(value) || !closed(value, ['id', 'name', 'enabled', 'createdAt', 'updatedAt', 'origin', 'roles', 'bindings', 'rules'])) return null;
  const origin = value.origin;
  const validOriginValue = record(origin) && (origin.kind === 'custom' && closed(origin, ['kind'])
    || origin.kind === 'import' && closed(origin, ['kind', 'sourceId', 'sourceName', 'sourceVersion', 'publisher', 'importedAt'])
      && text(origin.sourceId, 64) && text(origin.sourceName, NAME_LIMIT) && text(origin.sourceVersion, 64)
      && (origin.publisher === null || text(origin.publisher, NAME_LIMIT)) && time(origin.importedAt));
  if (typeof value.id !== 'string' || !ID.test(value.id) || !text(value.name, NAME_LIMIT) || typeof value.enabled !== 'boolean'
    || !time(value.createdAt) || !time(value.updatedAt) || !validOriginValue || !Array.isArray(value.roles)
    || !value.roles.every((role) => record(role) && closed(role, ['key', 'description']) && typeof role.key === 'string' && ROLE.test(role.key)
      && text(role.description, 512)) || !strings(value.bindings, ROLE) || !Array.isArray(value.rules)) return null;
  const rules = value.rules.map(parseRule).filter((rule): rule is LocalRule => rule !== null);
  return { ...value as unknown as LocalSet, rules };
}

function parseEntry(value: unknown): ListEntry | null {
  if (!record(value)) return null;
  if (value.kind === 'rule' && closed(value, ['kind', 'rule'])) { const rule = parseRule(value.rule); return rule ? { kind: 'rule', rule } : null; }
  if (value.kind === 'set' && closed(value, ['kind', 'set'])) { const set = parseSet(value.set); return set ? { kind: 'set', set } : null; }
  return value.kind === 'subscription' && closed(value, ['kind', 'subscriptionId', 'enabled']) && typeof value.subscriptionId === 'string'
    && ID.test(value.subscriptionId) && typeof value.enabled === 'boolean' ? value as unknown as ListEntry : null;
}

/** The stored list as this build reads it. Entries it cannot run are left out; one id appears once. */
export function parseRuleList(value: unknown): RuleListRecord {
  if (!record(value) || value.version !== 2 || !closed(value, ['version', 'revision', 'enabled', 'entries'], ['orderNotice'])
    || !time(value.revision) || typeof value.enabled !== 'boolean' || !Array.isArray(value.entries)) return EMPTY_LIST;
  const seen = new Set<string>();
  const entries = value.entries.map(parseEntry).filter((entry): entry is ListEntry => {
    if (!entry) return false;
    const ids = [entryId(entry), ...entry.kind === 'set' ? entry.set.rules.map((rule) => rule.id) : []];
    if (ids.some((id) => seen.has(id))) return false;
    for (const id of ids) seen.add(id);
    return true;
  });
  const notice = value.orderNotice;
  const orderNotice = record(notice) && closed(notice, ['pairs', 'shownAt']) && Array.isArray(notice.pairs)
    && notice.pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string'))
    && (notice.shownAt === null || time(notice.shownAt)) ? notice as unknown as RuleListRecord['orderNotice'] : undefined;
  return { version: 2, revision: value.revision, enabled: value.enabled, entries, ...(orderNotice ? { orderNotice } : {}) };
}

/** A v1 rule (browser-rules.ts BrowserRule) as a list rule: its conditions read back from its definition. */
function legacyRule(value: unknown): LocalRule | null {
  if (!record(value) || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.folderNativeId !== 'string'
    || !FOLDER.test(value.folderNativeId) || typeof value.enabled !== 'boolean' || !time(value.createdAt) || !time(value.updatedAt)
    || validateM1Rule(value.definition).length) return null;
  const definition = value.definition as RuleDefinition;
  const draft = editorConditions(definition);
  const reviewed = Array.isArray(value.reviewed) ? value.reviewed.filter((item): item is { accountRuleId: string; key: string } =>
    record(item) && typeof item.accountRuleId === 'string' && typeof item.key === 'string').slice(0, REVIEW_LIMIT) : [];
  return { id: value.id, enabled: value.enabled, name: definition.name.slice(0, NAME_LIMIT), combinator: draft?.combinator ?? 'all',
    conditions: draft?.conditions ?? [], action: { kind: 'file', folderNativeId: value.folderNativeId }, definition,
    compiledFrom: { contentVersions: {} }, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(reviewed.length ? { reviewed } : {}),
    ...(time(value.movingSince) ? { movingSince: value.movingSince } : {}) };
}

/**
 * The v1 list in its order. Before, two matching rules with different folders kept the page where it
 * was saved; now the upper one files it, so every such pair is named for the one-time notice (R2).
 */
export function migrateLegacyRules(value: unknown, now: number): RuleListRecord {
  const rules = (record(value) && Array.isArray(value.rules) ? value.rules : []).map(legacyRule)
    .filter((rule): rule is LocalRule => rule !== null)
    .filter((rule, index, all) => all.findIndex((other) => other.id === rule.id) === index);
  const pairs: [string, string][] = [];
  const enabled = rules.filter((rule) => rule.enabled);
  for (let upper = 0; upper < enabled.length && pairs.length < NOTICE_PAIRS; upper++) {
    for (let lower = upper + 1; lower < enabled.length && pairs.length < NOTICE_PAIRS; lower++) {
      const a = enabled[upper]!, b = enabled[lower]!;
      if (ruleFolderNativeId(a) !== ruleFolderNativeId(b) && witnessOverlap(a.definition, b.definition, now)) pairs.push([a.id, b.id]);
    }
  }
  return { version: 2, revision: 1, enabled: true, entries: rules.map((rule) => ({ kind: 'rule', rule })),
    ...(pairs.length ? { orderNotice: { pairs, shownAt: null } } : {}) };
}

/** Over a limit only where a change added something; a list stored over one still opens. */
export function overLimits(entries: readonly ListEntry[]): boolean {
  const sets = entries.filter((entry) => entry.kind === 'set').length;
  const individual = entries.filter((entry) => entry.kind === 'rule').length;
  const local = individual + entries.reduce((sum, entry) => sum + (entry.kind === 'set' ? entry.set.rules.length : 0), 0);
  const subscriptions = entries.filter((entry) => entry.kind === 'subscription').length;
  return individual > LIST_LIMITS.rules || sets > LIST_LIMITS.sets || local > LIST_LIMITS.localRules || subscriptions > LIST_LIMITS.subscriptions;
}

interface Located { readonly rule: LocalRule; readonly set: LocalSet | null }
function locate(list: RuleListRecord, ruleId: string): Located | null {
  for (const entry of list.entries) {
    if (entry.kind === 'rule' && entry.rule.id === ruleId) return { rule: entry.rule, set: null };
    if (entry.kind === 'set') { const rule = entry.set.rules.find((item) => item.id === ruleId); if (rule) return { rule, set: entry.set }; }
  }
  return null;
}
const findSet = (list: RuleListRecord, setId: string): LocalSet | null =>
  list.entries.find((entry): entry is Extract<ListEntry, { kind: 'set' }> => entry.kind === 'set' && entry.set.id === setId)?.set ?? null;
const clamp = (index: number | undefined, length: number) => index === undefined ? length : Math.max(0, Math.min(length, Math.trunc(index)));
function insertAt<T>(items: readonly T[], index: number | undefined, item: T): T[] {
  const next = [...items]; next.splice(clamp(index, next.length), 0, item); return next;
}
/** Every entry and set with `ruleId` taken out; the rest keep their order. */
function withoutRule(entries: readonly ListEntry[], ruleId: string): ListEntry[] {
  return entries.flatMap((entry): ListEntry[] => {
    if (entry.kind === 'rule') return entry.rule.id === ruleId ? [] : [entry];
    if (entry.kind === 'set' && entry.set.rules.some((rule) => rule.id === ruleId)) {
      return [{ kind: 'set', set: { ...entry.set, rules: entry.set.rules.filter((rule) => rule.id !== ruleId) } }];
    }
    return [entry];
  });
}
function mapRule(entries: readonly ListEntry[], ruleId: string, change: (rule: LocalRule) => LocalRule): ListEntry[] {
  return entries.map((entry): ListEntry => {
    if (entry.kind === 'rule') return entry.rule.id === ruleId ? { kind: 'rule', rule: change(entry.rule) } : entry;
    if (entry.kind === 'set' && entry.set.rules.some((rule) => rule.id === ruleId)) {
      return { kind: 'set', set: { ...entry.set, rules: entry.set.rules.map((rule) => rule.id === ruleId ? change(rule) : rule) } };
    }
    return entry;
  });
}
const mapSet = (entries: readonly ListEntry[], setId: string, change: (set: LocalSet) => LocalSet): ListEntry[] =>
  entries.map((entry) => entry.kind === 'set' && entry.set.id === setId ? { kind: 'set', set: change(entry.set) } : entry);

/**
 * A rule leaving its set keeps the folder its role was bound to there: bindings belong to the set.
 * Null when the role is not bound, so there is no folder to keep.
 */
function outsideSet(rule: LocalRule, set: LocalSet | null): LocalRule | null {
  if (!set || rule.action.kind !== 'file' || 'folderNativeId' in rule.action) return rule;
  const folder = set.bindings[rule.action.role];
  return folder ? { ...rule, action: { kind: 'file', folderNativeId: folder } } : null;
}
/** Waiting to move and reviews against the account are kept for individual rules only. */
function insideSet(rule: LocalRule): LocalRule {
  const { reviewed: _reviewed, movingSince: _moving, ...rest } = rule;
  return rest;
}

export type RuleSaveResult = { readonly ok: true; readonly rule: LocalRule }
  | { readonly ok: false; readonly error: 'invalid'; readonly problems: readonly DraftProblem[] }
  | { readonly ok: false; readonly error: 'notFound' | 'limit' };
export type SetSaveResult = { readonly ok: true; readonly set: LocalSet }
  | { readonly ok: false; readonly error: 'invalid' | 'notFound' | 'limit' };
/** `mismatch`: the order names other entries than the list has; `unbound`: a rule would leave its set with no folder to keep. */
export type ListChangeResult = { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly error: 'notFound' | 'mismatch' | 'limit' | 'unbound' };
export type EntryRef = { readonly kind: 'rule' | 'set' | 'subscription'; readonly id: string };

type Change<T> = { readonly result: T; readonly entries?: readonly ListEntry[]; readonly enabled?: boolean; readonly notice?: 'dismiss' };

export function createRuleListStore(area: AtomicStateArea, options: { readonly id?: () => string; readonly now?: () => number } = {}) {
  const newId = options.id ?? (() => crypto.randomUUID());
  const clock = options.now ?? Date.now;
  let lane: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = lane.then(work, work); lane = run.catch(() => undefined); return run;
  }
  /** Inside the lane: a list written by an earlier build moves here with its old key deleted, in one transaction. */
  async function current(): Promise<RuleListRecord> {
    const value = await area.get(RULE_LIST_KEY);
    if (value !== undefined) return parseRuleList(value);
    const legacy = await area.get(LEGACY_RULES_KEY);
    if (legacy === undefined) return EMPTY_LIST;
    const migrated = migrateLegacyRules(legacy, clock());
    await area.commit({ [RULE_LIST_KEY]: migrated }, [LEGACY_RULES_KEY]);
    return migrated;
  }
  /** One change: written with the next revision when it changes anything, else left alone. */
  function update<T>(work: (list: RuleListRecord) => Change<T>): Promise<T> {
    return exclusive(async () => {
      const list = await current();
      const change = work(list);
      if (change.entries === undefined && change.enabled === undefined && change.notice === undefined) return change.result;
      const { orderNotice, ...rest } = list;
      const next: RuleListRecord = { ...rest, revision: list.revision + 1, entries: change.entries ?? list.entries, enabled: change.enabled ?? list.enabled,
        ...(orderNotice && change.notice !== 'dismiss' ? { orderNotice } : {}) };
      await area.set(RULE_LIST_KEY, next);
      return change.result;
    });
  }
  const changed = (list: RuleListRecord, entries: readonly ListEntry[]): Change<ListChangeResult> => overLimits(entries) && !overLimits(list.entries)
    ? { result: { ok: false, error: 'limit' } } : { result: { ok: true, revision: list.revision + 1 }, entries };
  /** Individual rules only: reviews and moving to the account are about a rule outside any set. */
  function individual(id: string, change: (rule: LocalRule) => LocalRule | null): Promise<LocalRule | null> {
    return update((list) => {
      const rule = individualRules(list).find((item) => item.id === id);
      if (!rule) return { result: null };
      const next = change(rule);
      return next === rule || !next ? { result: next } : { result: next, entries: mapRule(list.entries, id, () => next) };
    });
  }

  return {
    /** The list as stored; the first read after an upgrade migrates the v1 list. */
    load: () => exclusive(current),
    /**
     * Creates a rule (no id) at the end of the list or of the set `into`, or replaces one's conditions,
     * name and folder where it is.
     */
    saveRule(input: { readonly id?: string; readonly draft: RuleDraft; readonly enabled?: boolean; readonly into?: string | null;
      readonly index?: number }, now: number): Promise<RuleSaveResult> {
      const checked = checkRuleDraft(input.draft);
      if (!checked.ok) return Promise.resolve({ ok: false, error: 'invalid', problems: checked.problems });
      return update((list): Change<RuleSaveResult> => {
        const found = input.id === undefined ? null : locate(list, input.id);
        if (input.id !== undefined && !found) return { result: { ok: false, error: 'notFound' } };
        const into = input.into ?? null, set = found ? found.set : into === null ? null : findSet(list, into);
        if (!found && into !== null && !set) return { result: { ok: false, error: 'notFound' } };
        // A role names a folder only inside the set that declares it.
        const { action } = input.draft;
        if (action.kind === 'file' && 'role' in action && !set?.roles.some((role) => role.key === action.role)) {
          return { result: { ok: false, error: 'invalid', problems: [{ field: 'folder', code: 'required' }] } };
        }
        const previous = found?.rule;
        // An edited rule is no longer the one sent to the account, so it stops waiting to retire; reviews stay.
        const rule: LocalRule = { id: previous?.id ?? newId(), enabled: input.enabled ?? previous?.enabled ?? true, name: checked.name,
          combinator: input.draft.combinator, conditions: checked.conditions, action, definition: checked.definition,
          compiledFrom: { contentVersions: {} }, createdAt: previous?.createdAt ?? now, updatedAt: now,
          ...(previous?.origin ? { origin: previous.origin } : {}), ...(previous?.reviewed ? { reviewed: previous.reviewed } : {}) };
        if (previous) return { result: { ok: true, rule }, entries: mapRule(list.entries, rule.id, () => rule) };
        const entries = into === null ? insertAt(list.entries, input.index, { kind: 'rule', rule })
          : mapSet(list.entries, into, (target) => ({ ...target, rules: insertAt(target.rules, input.index, insideSet(rule)) }));
        return overLimits(entries) ? { result: { ok: false, error: 'limit' } } : { result: { ok: true, rule }, entries };
      });
    },
    removeRule(id: string): Promise<boolean> {
      return update((list) => locate(list, id) ? { result: true, entries: withoutRule(list.entries, id) } : { result: false });
    },
    /** A rule, a set or a subscription on or off; the list's own place and content stay. */
    setEnabled(target: EntryRef, enabled: boolean, now: number): Promise<ListEntry | null> {
      return update((list): Change<ListEntry | null> => {
        if (target.kind === 'rule') {
          const found = locate(list, target.id);
          if (!found) return { result: null };
          const rule = found.rule.enabled === enabled ? found.rule : { ...found.rule, enabled, updatedAt: now };
          return { result: { kind: 'rule', rule }, ...(rule === found.rule ? {} : { entries: mapRule(list.entries, rule.id, () => rule) }) };
        }
        const at = list.entries.findIndex((entry) => entry.kind === target.kind && entryId(entry) === target.id);
        const entry = list.entries[at];
        if (!entry) return { result: null };
        const next: ListEntry = entry.kind === 'set' ? { kind: 'set', set: { ...entry.set, enabled, updatedAt: now } }
          : entry.kind === 'subscription' ? { ...entry, enabled } : entry;
        const same = entry.kind === 'set' ? entry.set.enabled === enabled : entry.kind === 'subscription' && entry.enabled === enabled;
        return same ? { result: entry } : { result: next, entries: list.entries.map((item, index) => index === at ? next : item) };
      });
    },
    setListEnabled(enabled: boolean): Promise<ListChangeResult> {
      return update((list) => list.enabled === enabled ? { result: { ok: true, revision: list.revision } }
        : { result: { ok: true, revision: list.revision + 1 }, enabled });
    },
    /** The top-level entries in a new order; refused unless it names exactly the entries the list has. */
    reorder(order: readonly string[]): Promise<ListChangeResult> {
      return update((list): Change<ListChangeResult> => {
        const ids = list.entries.map(entryId);
        if (order.length !== ids.length || new Set(order).size !== order.length || !order.every((id) => ids.includes(id))) {
          return { result: { ok: false, error: 'mismatch' } };
        }
        if (order.every((id, index) => ids[index] === id)) return { result: { ok: true, revision: list.revision } };
        return { result: { ok: true, revision: list.revision + 1 }, entries: order.map((id) => list.entries[ids.indexOf(id)]!) };
      });
    },
    /** A rule to `index` among the list's entries (`into` null) or a set's rules, after it is taken from where it was. */
    moveRule(ruleId: string, into: string | null, index: number, now: number): Promise<ListChangeResult> {
      return update((list): Change<ListChangeResult> => {
        const found = locate(list, ruleId);
        if (!found || (into !== null && !findSet(list, into))) return { result: { ok: false, error: 'notFound' } };
        const leaving = found.set !== null && found.set.id !== into;
        const kept = leaving ? outsideSet(found.rule, found.set) : found.rule;
        if (!kept) return { result: { ok: false, error: 'unbound' } };
        const rule = kept === found.rule ? kept : { ...kept, updatedAt: now };
        const rest = withoutRule(list.entries, ruleId);
        const entries = into === null ? insertAt(rest, index, { kind: 'rule', rule })
          : mapSet(rest, into, (set) => ({ ...set, rules: insertAt(set.rules, index, insideSet(rule)) }));
        return changed(list, entries);
      });
    },
    /** Creates an empty set of the Owner's own (no id), or renames one. */
    saveSet(input: { readonly id?: string; readonly name: string; readonly enabled?: boolean; readonly index?: number }, now: number): Promise<SetSaveResult> {
      const name = input.name.trim();
      if (!name || name.length > NAME_LIMIT) return Promise.resolve({ ok: false, error: 'invalid' });
      return update((list): Change<SetSaveResult> => {
        if (input.id !== undefined) {
          const previous = findSet(list, input.id);
          if (!previous) return { result: { ok: false, error: 'notFound' } };
          const set = { ...previous, name, enabled: input.enabled ?? previous.enabled, updatedAt: now };
          return { result: { ok: true, set }, entries: mapSet(list.entries, set.id, () => set) };
        }
        const set: LocalSet = { id: newId(), name, enabled: input.enabled ?? true, createdAt: now, updatedAt: now, origin: { kind: 'custom' },
          roles: [], bindings: {}, rules: [] };
        const entries = insertAt(list.entries, input.index, { kind: 'set', set });
        return overLimits(entries) ? { result: { ok: false, error: 'limit' } } : { result: { ok: true, set }, entries };
      });
    },
    /** Deletes a set with its rules, or (`keepRules`) puts its rules where it was, as individual rules. */
    removeSet(id: string, keepRules: boolean, now: number): Promise<ListChangeResult> {
      return update((list): Change<ListChangeResult> => {
        const at = list.entries.findIndex((entry) => entry.kind === 'set' && entry.set.id === id);
        const entry = list.entries[at];
        if (entry?.kind !== 'set') return { result: { ok: false, error: 'notFound' } };
        const moved: ListEntry[] = [];
        for (const rule of keepRules ? entry.set.rules : []) {
          const kept = outsideSet(rule, entry.set);
          if (!kept) return { result: { ok: false, error: 'unbound' } };
          moved.push({ kind: 'rule', rule: kept === rule ? rule : { ...kept, updatedAt: now } });
        }
        return changed(list, [...list.entries.slice(0, at), ...moved, ...list.entries.slice(at + 1)]);
      });
    },
    /** A copy of a rule right below it, in the same set, or of a set and its rules right below the set. */
    duplicate(target: { readonly kind: 'rule' | 'set'; readonly id: string }, name: string, now: number): Promise<ListChangeResult> {
      const named = name.trim().slice(0, NAME_LIMIT);
      return update((list): Change<ListChangeResult> => {
        if (!named) return { result: { ok: false, error: 'notFound' } };
        const copy = (rule: LocalRule, title = rule.name): LocalRule => {
          const { reviewed: _reviewed, movingSince: _moving, ...rest } = rule;
          return { ...rest, id: newId(), name: title, definition: { ...rule.definition, name: title }, createdAt: now, updatedAt: now };
        };
        if (target.kind === 'set') {
          const at = list.entries.findIndex((entry) => entry.kind === 'set' && entry.set.id === target.id);
          const entry = list.entries[at];
          if (entry?.kind !== 'set') return { result: { ok: false, error: 'notFound' } };
          const set: LocalSet = { ...entry.set, id: newId(), name: named, createdAt: now, updatedAt: now, rules: entry.set.rules.map((rule) => copy(rule)) };
          return changed(list, insertAt(list.entries, at + 1, { kind: 'set', set }));
        }
        const found = locate(list, target.id);
        if (!found) return { result: { ok: false, error: 'notFound' } };
        const rule = copy(found.rule, named);
        if (!found.set) {
          const at = list.entries.findIndex((entry) => entry.kind === 'rule' && entry.rule.id === target.id);
          return changed(list, insertAt(list.entries, at + 1, { kind: 'rule', rule }));
        }
        const index = found.set.rules.findIndex((item) => item.id === target.id);
        return changed(list, mapSet(list.entries, found.set.id, (set) => ({ ...set, rules: insertAt(set.rules, index + 1, rule) })));
      });
    },
    /**
     * A configuration file's entries (rules-config-format.ts), below the list's own or in place of them. A
     * subscription entry already in the list is not added twice; an import past a limit is refused whole.
     */
    importEntries(entries: readonly ListEntry[], replace: boolean): Promise<ListChangeResult> {
      return update((list): Change<ListChangeResult> => {
        const kept = replace ? [] : list.entries;
        const present = new Set(kept.flatMap((entry) => entry.kind === 'subscription' ? [entry.subscriptionId] : []));
        const next = [...kept, ...entries.filter((entry) => entry.kind !== 'subscription' || !present.has(entry.subscriptionId))];
        if (overLimits(next)) return { result: { ok: false, error: 'limit' } };
        return { result: { ok: true, revision: list.revision + 1 }, entries: next, ...(replace ? { notice: 'dismiss' as const } : {}) };
      });
    },
    /** An imported set's roles bound to folders here (RS-07): a role named with null is unbound; roles it does not have are ignored. */
    bindRoles(setId: string, bindings: Readonly<Record<string, string | null>>, now: number): Promise<ListChangeResult> {
      return update((list): Change<ListChangeResult> => {
        const set = findSet(list, setId);
        if (!set) return { result: { ok: false, error: 'notFound' } };
        const next: Record<string, string> = { ...set.bindings };
        for (const role of set.roles) {
          if (!(role.key in bindings)) continue;
          const folder = bindings[role.key];
          if (folder) next[role.key] = folder; else delete next[role.key];
        }
        return { result: { ok: true, revision: list.revision + 1 }, entries: mapSet(list.entries, setId, (item) => ({ ...item, bindings: next, updatedAt: now })) };
      });
    },
    dismissOrderNotice(): Promise<boolean> {
      return update((list) => list.orderNotice ? { result: true, notice: 'dismiss' } : { result: false });
    },
    /** The Owner kept this rule next to an account rule's current revision; the newest few are remembered. */
    review(id: string, accountRuleId: string, key: string): Promise<LocalRule | null> {
      return individual(id, (rule) => ({ ...rule,
        reviewed: [{ accountRuleId, key }, ...(rule.reviewed ?? []).filter((item) => item.accountRuleId !== accountRuleId)].slice(0, REVIEW_LIMIT) }));
    },
    /** Add mine to the account was chosen: the rule retires once the account's enabled copy arrives. */
    markMoving(id: string, now: number): Promise<LocalRule | null> {
      return individual(id, (rule) => rule.movingSince === undefined ? { ...rule, movingSince: now } : rule);
    },
    /** Keep in this browser: it no longer waits to retire (follow-up U5). */
    stopMoving(id: string): Promise<LocalRule | null> {
      return individual(id, (rule) => {
        if (rule.movingSince === undefined) return rule;
        const { movingSince: _since, ...next } = rule;
        return next;
      });
    },
    /** Rechecks the current rule inside the write lane before retiring it for an account duplicate. */
    retireIfDuplicate(id: string, account: readonly OverlapRule[], now: number): Promise<LocalRule | null> {
      return update((list) => {
        const rule = individualRules(list).find((item) => item.id === id);
        if (!rule || rule.movingSince === undefined) return { result: null };
        const relation = relateBrowserRule({ id: rule.id, definition: rule.definition, folderNativeId: ruleFolderNativeId(rule) }, account, undefined, now);
        return relation?.kind === 'duplicate' ? { result: rule, entries: withoutRule(list.entries, id) } : { result: null };
      });
    },
  };
}
export type RuleListStore = ReturnType<typeof createRuleListStore>;
