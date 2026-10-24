import { validateM1Rule, type RuleDefinition } from '@know-n/colp/automation';
import type { BrowserSiteRuleExtension } from '../site-adapters/contracts.js';
import { validSiteRule } from './site-rule.js';
import { witnessOverlap } from './browser-overlap.js';
import { editorConditions } from './browser-rules.js';
import { closed, record } from './closed-value.js';
import { CONDITION_KINDS, CONDITION_LIMIT, NAME_LIMIT, type ConditionKind, type RuleAction, type RuleCondition } from './rule-conditions.js';

/**
 * The record of this browser's ordered rule list (doc 17 §4.1): its types, its limits, the closed parsers
 * that read it back from the automation store, and the one-time move of the flat v1 list into it (R2).
 * The store that changes it is rule-list-store.ts.
 */
export const RULE_LIST_KEY = 'known.automation.browserRules.v3';
export const PREVIOUS_RULE_LIST_KEY = 'known.automation.browserRules.v2';
export const RULE_MIGRATION_KEY = 'known.automation.browserRules.migration.v3';
/** Where builds before the ordered list kept their rules. */
export const LEGACY_RULES_KEY = 'known.automation.browserRules.v1';

/** Exceeding one is a save error, never a silent truncation. */
export const LIST_LIMITS = { rules: 200, sets: 50, localRules: 1_000, subscriptions: 20 } as const;
const VALUE_LIMIT = 2_048, NOTICE_PAIRS = 20;
/** How many account rules one individual rule remembers reviews against. */
export const REVIEW_LIMIT = 20;

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
  readonly site?: BrowserSiteRuleExtension;
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
  readonly version: 3;
  /** +1 per write. */
  readonly revision: number;
  /** The whole list's switch; the account's pause still overrides it. */
  readonly enabled: boolean;
  /** Execution order, top to bottom. */
  readonly entries: readonly ListEntry[];
  /** Migrated rules that could take one page to different folders (R2): the upper one now files it. Gone once dismissed. */
  readonly orderNotice?: { readonly pairs: readonly (readonly [string, string])[]; readonly shownAt: number | null };
}

export const EMPTY_LIST: RuleListRecord = { version: 3, revision: 0, enabled: true, entries: [] };
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

/** Internal parser; the v3 wrapper rejects any loss while v2 migration preserves historical filtering. */
function parseRule(value: unknown): LocalRule | null {
  if (!record(value) || !closed(value, ['id', 'enabled', 'name', 'combinator', 'conditions', 'action', 'definition', 'compiledFrom', 'createdAt',
    'updatedAt'], ['origin', 'reviewed', 'movingSince', 'site'])) return null;
  const { compiledFrom } = value;
  const valid = typeof value.id === 'string' && ID.test(value.id) && typeof value.enabled === 'boolean' && text(value.name, NAME_LIMIT)
    && (value.combinator === 'all' || value.combinator === 'any') && Array.isArray(value.conditions) && value.conditions.length <= CONDITION_LIMIT
    && value.conditions.every((item) => record(item) && closed(item, ['kind', 'value'])
      && CONDITION_KINDS.includes(item.kind as ConditionKind) && text(item.value, VALUE_LIMIT))
    && validAction(value.action) && !validateM1Rule(value.definition).length
    && (value.site === undefined || validSiteRule(value.site) && value.action.kind === 'file'
      && (!value.site.admission.entries.includes('siteImport') || (value.definition as RuleDefinition).policy.imports === 'include'))
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

/** Internal normalization used by strict v3 parsing and the historical v2 migration. */
function parseList(value: unknown): RuleListRecord {
  if (!record(value) || value.version !== 3 || !closed(value, ['version', 'revision', 'enabled', 'entries'], ['orderNotice'])
    || !time(value.revision) || typeof value.enabled !== 'boolean' || !Array.isArray(value.entries)) return EMPTY_LIST;
  const seen = new Set<string>();
  const entries = value.entries.map(parseEntry).filter((entry): entry is ListEntry => {
    if (!entry) return false;
    const ids = [entryId(entry), ...entry.kind === 'set' ? entry.set.rules.map((rule) => rule.id) : []];
    if (new Set(ids).size !== ids.length || ids.some((id) => seen.has(id))) return false;
    for (const id of ids) seen.add(id);
    return true;
  });
  const notice = value.orderNotice;
  const orderNotice = record(notice) && closed(notice, ['pairs', 'shownAt']) && Array.isArray(notice.pairs)
    && notice.pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string'))
    && (notice.shownAt === null || time(notice.shownAt)) ? notice as unknown as RuleListRecord['orderNotice'] : undefined;
  return { version: 3, revision: value.revision, enabled: value.enabled, entries, ...(orderNotice ? { orderNotice } : {}) };
}

/** v3 is fail-closed: an unsupported field or duplicate never disappears during a save. */
export function parseRuleList(value: unknown): RuleListRecord {
  if (value === undefined) return EMPTY_LIST;
  const parsed = parseList(value);
  if (!record(value) || value.version !== 3 || parsed === EMPTY_LIST || !Array.isArray(value.entries)
    || value.entries.length !== parsed.entries.length || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || value.orderNotice !== undefined && parsed.orderNotice === undefined
    || value.entries.some((e, i) => record(e) && e.kind === 'set' && record(e.set)
      && Array.isArray(e.set.rules) && e.set.rules.length !== (parsed.entries[i]?.kind === 'set' ? parsed.entries[i].set.rules.length : -1))) {
    throw new Error('rulesSchemaIncompatible');
  }
  return parsed;
}

/** v2 retains its historical parser semantics, but never accepts source capabilities. */
export function migrateOrderedRules(value: unknown): RuleListRecord {
  if (!record(value) || value.version !== 2 || !Array.isArray(value.entries)) throw new Error('rulesSchemaIncompatible');
  for (const e of value.entries) {
    const rules = record(e) && e.kind === 'set' && record(e.set) && Array.isArray(e.set.rules) ? e.set.rules : [record(e) ? e.rule : null];
    if (rules.some(r => record(r) && r.site !== undefined)) throw new Error('rulesSchemaIncompatible');
  }
  return parseList({ ...value, version: 3 });
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
  return { version: 3, revision: 1, enabled: true, entries: rules.map((rule) => ({ kind: 'rule', rule })),
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
