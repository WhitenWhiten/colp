import { compilePredicate, type Predicate } from '@know-n/colp/automation';
import { record } from './closed-value.js';
import { CONDITION_KINDS, CONDITION_LIMIT, NAME_LIMIT, VALUE_LIMIT, checkRuleDraft, collectionRef, definitionFor, type CollectionLookup, type RuleAction,
  type RuleCondition } from './rule-conditions.js';
import { LIST_LIMITS, ruleFolderNativeId, type ListEntry, type LocalRule, type LocalSet, type RuleListRecord, type SetOrigin } from './rule-list-store.js';
import { subscriptionAddress } from './subscription-fetch.js';
import { REFRESH_INTERVALS, type RefreshInterval } from './subscription-messages.js';
import type { LocalAdjustments, SubscriptionRecord } from './subscription-store.js';
import { exceptionValue, RISK_EXCEPTION_LIMIT, type RiskMode } from '../risk/risk-settings.js';
import { RISK_LIST_LIMIT } from '../risk/risk-store.js';

/**
 * `known-rules-config/v1` (doc 17 §5.3, RS-19.3): this browser's rule list in a file the Owner keeps,
 * apart from the bookmark backup. It holds the list (conditions or a finite predicate, actions, sets with their origin, roles
 * and bindings, subscriptions with their address, settings and adjustments but none of their content),
 * and a folder table naming every folder an action or binding uses by its title and path. Folder ids in
 * a file are another browser's: an import maps every folder in the table to one here, suggested by an
 * exact path, and uses none of the file's ids (RS-07.4). A subscription comes back not ready, and is
 * fetched once its origin is allowed here (RS-19.3). Risk alerts come with it (§5.3): the mode, the
 * exceptions kept always and each list's address and settings, none of its entries; a file made before
 * they were added has none. The document is closed and versioned; it carries no credential, token or
 * fetched content (RS-19.4).
 */
export const CONFIG_FORMAT = 'known-rules-config/v1';
export const CONFIG_MAX_BYTES = 2 * 1024 * 1024;

export interface ConfigFolder { readonly nativeId: string; readonly title: string; readonly path: readonly string[] }
export interface ConfigRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly combinator: 'all' | 'any';
  readonly conditions: readonly RuleCondition[];
  /** Finite predicate for imported rules the condition editor cannot express. */
  readonly match?: Predicate;
  /** A folder named by its id in the folder table, a role of its set, or keep where saved. */
  readonly action: RuleAction;
}
export interface ConfigSet {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly origin: SetOrigin;
  readonly roles: readonly { readonly key: string; readonly description: string }[];
  /** Role key → a folder in the table. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly rules: readonly ConfigRule[];
}
export interface ConfigSubscription {
  /** Kept on import, so rules naming its sites still do. */
  readonly id: string;
  readonly enabled: boolean;
  readonly url: string;
  readonly updatePolicy: SubscriptionRecord['updatePolicy'];
  readonly refreshIntervalHours: RefreshInterval;
  readonly paused: boolean;
  readonly pinned: boolean;
  readonly disabledEntryIds: readonly string[];
  readonly exceptions: readonly { readonly scope: 'host' | 'domain'; readonly value: string }[];
  /** Role key → a folder in the table. */
  readonly bindings: Readonly<Record<string, string>>;
}
export type ConfigEntry = { readonly kind: 'rule'; readonly rule: ConfigRule } | { readonly kind: 'set'; readonly set: ConfigSet }
  | { readonly kind: 'subscription'; readonly subscription: ConfigSubscription };
/** Risk alerts (doc 17 §4.4): separate from the list, and naming no folder. */
export interface ConfigRisk {
  readonly mode: RiskMode;
  readonly exceptions: readonly { readonly scope: 'host' | 'domain'; readonly value: string }[];
  readonly lists: readonly { readonly url: string; readonly refreshIntervalHours: RefreshInterval; readonly paused: boolean }[];
}
export interface RulesConfig {
  readonly format: typeof CONFIG_FORMAT;
  readonly exportedAt: number;
  readonly list: { readonly enabled: boolean; readonly entries: readonly ConfigEntry[] };
  readonly folders: readonly ConfigFolder[];
  readonly risk?: ConfigRisk;
}

const ruleOf = (rule: LocalRule): ConfigRule => ({ id: rule.id, enabled: rule.enabled, name: rule.name, combinator: rule.combinator,
  conditions: rule.conditions, action: rule.action, ...(rule.conditions.length ? {} : { match: rule.definition.match }) });

type Subscribed = (id: string) => { readonly record: SubscriptionRecord; readonly local: LocalAdjustments } | null;

/**
 * The list as a file. `folder` names a folder here by title and path; a folder gone since keeps its id with no path.
 * A subscription whose record cannot be read is left out: there is no address to subscribe to again.
 */
export async function buildRulesConfig(list: RuleListRecord, folder: (nativeId: string) => Promise<{ readonly title: string; readonly path: readonly string[] } | null>,
  now: number, subscribed: Subscribed = () => null, risk?: ConfigRisk): Promise<RulesConfig> {
  if (list.entries.some(e => e.kind === 'rule' ? !!e.rule.site : e.kind === 'set' && e.set.rules.some(r => r.site))) throw new Error('sourceRulesCannotExport');
  const entries = list.entries.flatMap((entry): ConfigEntry[] => {
    if (entry.kind === 'rule') return [{ kind: 'rule', rule: ruleOf(entry.rule) }];
    if (entry.kind === 'subscription') {
      const found = subscribed(entry.subscriptionId);
      if (!found) return [];
      const { record, local } = found;
      return [{ kind: 'subscription', subscription: { id: record.id, enabled: entry.enabled, url: record.url, updatePolicy: record.updatePolicy,
        refreshIntervalHours: record.refreshIntervalHours, paused: record.paused, pinned: record.pinned, disabledEntryIds: local.disabledEntryIds,
        exceptions: local.exceptions.map(({ scope, value }) => ({ scope, value })), bindings: local.bindings } }];
    }
    const { id, name, enabled, origin, roles, bindings, rules } = entry.set;
    return [{ kind: 'set', set: { id, name, enabled, origin, roles, bindings, rules: rules.map(ruleOf) } }];
  });
  const ids = new Set<string>();
  for (const entry of list.entries) {
    if (entry.kind === 'rule') { const id = ruleFolderNativeId(entry.rule); if (id) ids.add(id); }
    if (entry.kind === 'set') {
      for (const rule of entry.set.rules) if (rule.action.kind === 'file' && 'folderNativeId' in rule.action) ids.add(rule.action.folderNativeId);
      for (const id of Object.values(entry.set.bindings)) ids.add(id);
    }
    if (entry.kind === 'subscription') for (const id of Object.values(subscribed(entry.subscriptionId)?.local.bindings ?? {})) ids.add(id);
  }
  const folders = await Promise.all([...ids].map(async (nativeId) => {
    const found = await folder(nativeId);
    return { nativeId, title: found?.title ?? '', path: found?.path ?? [] };
  }));
  return { format: CONFIG_FORMAT, exportedAt: now, list: { enabled: list.enabled, entries }, folders, ...(risk ? { risk } : {}) };
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!record(value) || !required.every((key) => key in value) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error('config_invalid');
  }
  return value;
}
function text(value: unknown, limit: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length > limit || /\u0000/u.test(value) || (pattern && !pattern.test(value))) throw new Error('config_invalid');
  return value;
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('config_invalid');
  return value;
}
function flag(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('config_invalid'); return value; }
const ID = /^[\w-]{1,128}$/u, FOLDER = /^[\w.-]{1,128}$/u, ROLE = /^[A-Za-z0-9._-]{1,64}$/u;

function parseAction(value: unknown): RuleAction {
  const raw = object(value, ['kind'], ['folderNativeId', 'role']);
  if (raw.kind === 'keepHere' && Object.keys(raw).length === 1) return { kind: 'keepHere' };
  if (raw.kind === 'file' && Object.keys(raw).length === 2 && raw.folderNativeId !== undefined) return { kind: 'file', folderNativeId: text(raw.folderNativeId, 128, FOLDER) };
  if (raw.kind === 'file' && Object.keys(raw).length === 2 && raw.role !== undefined) return { kind: 'file', role: text(raw.role, 64, ROLE) };
  throw new Error('config_invalid');
}
function parseRule(value: unknown): ConfigRule {
  const raw = object(value, ['id', 'enabled', 'name', 'combinator', 'conditions', 'action'], ['match']);
  if (raw.combinator !== 'all' && raw.combinator !== 'any') throw new Error('config_invalid');
  const conditions = list(raw.conditions, CONDITION_LIMIT).map((item) => {
    const condition = object(item, ['kind', 'value']);
    if (!CONDITION_KINDS.includes(condition.kind as RuleCondition['kind'])) throw new Error('config_invalid');
    return { kind: condition.kind as RuleCondition['kind'], value: text(condition.value, VALUE_LIMIT) };
  });
  const compiled = raw.match === undefined ? undefined : compilePredicate(raw.match as Predicate);
  if (compiled && (!compiled.valid || conditions.length)) throw new Error('config_invalid');
  return { id: text(raw.id, 128, ID), enabled: flag(raw.enabled), name: text(raw.name, NAME_LIMIT), combinator: raw.combinator, conditions,
    action: parseAction(raw.action), ...(compiled?.valid ? { match: compiled.normalizedPredicate } : {}) };
}
function parseOrigin(value: unknown): SetOrigin {
  const raw = object(value, ['kind'], ['sourceId', 'sourceName', 'sourceVersion', 'publisher', 'importedAt']);
  if (raw.kind === 'custom' && Object.keys(raw).length === 1) return { kind: 'custom' };
  object(raw, ['kind', 'sourceId', 'sourceName', 'sourceVersion', 'publisher', 'importedAt']);
  if (raw.kind !== 'import' || !Number.isSafeInteger(raw.importedAt)) throw new Error('config_invalid');
  return { kind: 'import', sourceId: text(raw.sourceId, 64), sourceName: text(raw.sourceName, NAME_LIMIT), sourceVersion: text(raw.sourceVersion, 64),
    publisher: raw.publisher === null ? null : text(raw.publisher, NAME_LIMIT), importedAt: raw.importedAt as number };
}
function parseSet(value: unknown): ConfigSet {
  const raw = object(value, ['id', 'name', 'enabled', 'origin', 'roles', 'bindings', 'rules']);
  const roles = list(raw.roles, 32).map((item) => { const role = object(item, ['key', 'description']); return { key: text(role.key, 64, ROLE), description: text(role.description, 512) }; });
  const bindings = object(raw.bindings, [], roles.map((role) => role.key));
  return { id: text(raw.id, 128, ID), name: text(raw.name, NAME_LIMIT), enabled: flag(raw.enabled), origin: parseOrigin(raw.origin), roles,
    bindings: Object.fromEntries(Object.entries(bindings).map(([key, folder]) => [key, text(folder, 128, FOLDER)])),
    rules: list(raw.rules, LIST_LIMITS.localRules).map(parseRule) };
}
function parseSubscription(value: unknown): ConfigSubscription {
  const raw = object(value, ['id', 'enabled', 'url', 'updatePolicy', 'refreshIntervalHours', 'paused', 'pinned', 'disabledEntryIds', 'exceptions', 'bindings']);
  const address = subscriptionAddress(text(raw.url, 2_048));
  if (!address.ok || address.url !== raw.url || (raw.updatePolicy !== 'review' && raw.updatePolicy !== 'auto')
    || !REFRESH_INTERVALS.includes(raw.refreshIntervalHours as RefreshInterval)) throw new Error('config_invalid');
  const exceptions = list(raw.exceptions, 200).map((item) => {
    const exception = object(item, ['scope', 'value']);
    if (exception.scope !== 'host' && exception.scope !== 'domain') throw new Error('config_invalid');
    return { scope: exception.scope as 'host' | 'domain', value: text(exception.value, 253, /^[a-z0-9.-]+$/u) };
  });
  if (!record(raw.bindings)) throw new Error('config_invalid');
  const bindings = object(raw.bindings, [], Object.keys(raw.bindings).filter((key) => ROLE.test(key)));
  return { id: text(raw.id, 128, ID), enabled: flag(raw.enabled), url: address.url, updatePolicy: raw.updatePolicy,
    refreshIntervalHours: raw.refreshIntervalHours as RefreshInterval, paused: flag(raw.paused), pinned: flag(raw.pinned),
    disabledEntryIds: list(raw.disabledEntryIds, 2_000).map((id) => text(id, 64, ROLE)), exceptions,
    bindings: Object.fromEntries(Object.entries(bindings).map(([key, folder]) => [key, text(folder, 128, FOLDER)])) };
}
function parseRisk(value: unknown): ConfigRisk {
  const raw = object(value, ['mode', 'exceptions', 'lists']);
  if (raw.mode !== 'off' && raw.mode !== 'onSave' && raw.mode !== 'onSaveAndBrowse') throw new Error('config_invalid');
  const exceptions = list(raw.exceptions, RISK_EXCEPTION_LIMIT).map((item) => {
    const exception = object(item, ['scope', 'value']);
    if ((exception.scope !== 'host' && exception.scope !== 'domain') || typeof exception.value !== 'string'
      || exceptionValue(exception.scope, exception.value) !== exception.value) throw new Error('config_invalid');
    return { scope: exception.scope as 'host' | 'domain', value: exception.value };
  });
  const lists = list(raw.lists, RISK_LIST_LIMIT).map((item) => {
    const entry = object(item, ['url', 'refreshIntervalHours', 'paused']);
    const address = subscriptionAddress(text(entry.url, 2_048));
    if (!address.ok || address.url !== entry.url || !REFRESH_INTERVALS.includes(entry.refreshIntervalHours as RefreshInterval)) throw new Error('config_invalid');
    return { url: address.url, refreshIntervalHours: entry.refreshIntervalHours as RefreshInterval, paused: flag(entry.paused) };
  });
  return { mode: raw.mode, exceptions, lists };
}
function parseEntry(value: unknown): ConfigEntry {
  const raw = object(value, ['kind'], ['rule', 'set', 'subscription']);
  if (raw.kind === 'rule') { object(raw, ['kind', 'rule']); return { kind: 'rule', rule: parseRule(raw.rule) }; }
  if (raw.kind === 'set') { object(raw, ['kind', 'set']); return { kind: 'set', set: parseSet(raw.set) }; }
  if (raw.kind === 'subscription') { object(raw, ['kind', 'subscription']); return { kind: 'subscription', subscription: parseSubscription(raw.subscription) }; }
  throw new Error('config_invalid');
}

/** A configuration file as this build reads it; anything unknown, oversized or inconsistent is refused whole. */
export function parseRulesConfig(value: unknown): RulesConfig {
  if (!record(value) || value.format !== CONFIG_FORMAT) throw new Error(record(value) && typeof value.format === 'string'
    && value.format.startsWith('known-rules-config/') ? 'config_version_unsupported' : 'config_invalid');
  const raw = object(value, ['format', 'exportedAt', 'list', 'folders'], ['risk']);
  if (!Number.isSafeInteger(raw.exportedAt)) throw new Error('config_invalid');
  const body = object(raw.list, ['enabled', 'entries']);
  const entries = list(body.entries, LIST_LIMITS.rules + LIST_LIMITS.sets + LIST_LIMITS.subscriptions).map(parseEntry);
  const folders = list(raw.folders, 2_000).map((item) => {
    const folder = object(item, ['nativeId', 'title', 'path']);
    return { nativeId: text(folder.nativeId, 128, FOLDER), title: text(folder.title, 1_024), path: list(folder.path, 32).map((part) => text(part, 1_024)) };
  });
  const table = new Set(folders.map((folder) => folder.nativeId));
  if (table.size !== folders.length) throw new Error('config_invalid');
  // Every folder an action or binding names is in the table.
  for (const id of foldersUsed({ list: { entries } }).all) if (!table.has(id)) throw new Error('config_invalid');
  return { format: CONFIG_FORMAT, exportedAt: raw.exportedAt as number, list: { enabled: flag(body.enabled), entries }, folders,
    ...(raw.risk !== undefined ? { risk: parseRisk(raw.risk) } : {}) };
}

/** The table's folders the file uses: by a rule's action (each must be mapped), and those only a set's binding uses (may stay unbound). */
export function foldersUsed(config: Pick<RulesConfig, 'list'> | { readonly list: { readonly entries: readonly ConfigEntry[] } }):
  { readonly actions: ReadonlySet<string>; readonly all: ReadonlySet<string> } {
  const actions = new Set<string>(), all = new Set<string>();
  const rule = (item: ConfigRule) => { if (item.action.kind === 'file' && 'folderNativeId' in item.action) { actions.add(item.action.folderNativeId); all.add(item.action.folderNativeId); } };
  for (const entry of config.list.entries) {
    if (entry.kind === 'rule') rule(entry.rule);
    if (entry.kind === 'set') { entry.set.rules.forEach(rule); for (const id of Object.values(entry.set.bindings)) all.add(id); }
    if (entry.kind === 'subscription') for (const id of Object.values(entry.subscription.bindings)) all.add(id);
  }
  return { actions, all };
}

/** The folder here with exactly the same path, when there is one and only one. */
export function suggestFolders(folders: readonly ConfigFolder[], here: readonly { readonly id: string; readonly path: readonly string[] }[]): Record<string, string | null> {
  const byPath = new Map<string, string[]>();
  for (const folder of here) { const key = JSON.stringify(folder.path); byPath.set(key, [...byPath.get(key) ?? [], folder.id]); }
  return Object.fromEntries(folders.map((folder) => {
    const matches = folder.path.length ? byPath.get(JSON.stringify(folder.path)) ?? [] : [];
    return [folder.nativeId, matches.length === 1 ? matches[0]! : null];
  }));
}

/** A collection's site before its subscription has a version here: compiled to match nothing, from no version, so it waits (subscription-list.ts). */
const PENDING: CollectionLookup = (_subscriptionId, siteId) => ({ name: siteId, version: '',
  predicate: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'collection.invalid' } });
/** A subscription to recreate here, not ready, with its adjustments. */
export interface ImportedSubscription { readonly config: ConfigSubscription; readonly local: LocalAdjustments }

/**
 * The file's entries as list entries here, every folder through `remap` (file id → folder here, or null
 * for a binding left unbound). Rules and sets get new ids; a rule this build cannot check is left out.
 * A rule naming a collection's site waits for its subscription's first version, which compiles it.
 */
export function configEntries(config: RulesConfig, remap: Readonly<Record<string, string | null>>, newId: () => string, now: number):
  { readonly entries: readonly ListEntry[]; readonly skipped: number; readonly subscriptions: readonly ImportedSubscription[] } | { readonly error: 'unmapped' } {
  const used = foldersUsed(config);
  if ([...used.actions].some((id) => !remap[id])) return { error: 'unmapped' };
  let skipped = 0;
  const rule = (item: ConfigRule): LocalRule | null => {
    const action: RuleAction = item.action.kind === 'file' && 'folderNativeId' in item.action ? { kind: 'file', folderNativeId: remap[item.action.folderNativeId]! } : item.action;
    if (item.match) {
      const compiled = compilePredicate(item.match);
      if (!compiled.valid || item.conditions.length) { skipped += 1; return null; }
      return { id: newId(), enabled: item.enabled, name: item.name, combinator: item.combinator, conditions: [], action,
        definition: definitionFor(item.name, compiled.normalizedPredicate), compiledFrom: { contentVersions: {} }, createdAt: now, updatedAt: now };
    }
    const pending = item.conditions.some((condition) => condition.kind === 'siteCollection' && collectionRef(condition.value));
    const checked = checkRuleDraft({ name: item.name, combinator: item.combinator, conditions: item.conditions, action }, pending ? PENDING : undefined);
    if (!checked.ok) { skipped += 1; return null; }
    return { id: newId(), enabled: item.enabled, name: checked.name, combinator: item.combinator, conditions: checked.conditions, action,
      definition: checked.definition, compiledFrom: { contentVersions: checked.contentVersions }, createdAt: now, updatedAt: now };
  };
  const subscriptions: ImportedSubscription[] = [];
  const entries = config.list.entries.flatMap((entry): ListEntry[] => {
    if (entry.kind === 'subscription') {
      const { subscription } = entry;
      subscriptions.push({ config: subscription, local: { disabledEntryIds: subscription.disabledEntryIds,
        exceptions: subscription.exceptions.map((exception) => ({ id: newId(), ...exception, createdAt: now })),
        bindings: Object.fromEntries(Object.entries(subscription.bindings).flatMap(([role, id]) => remap[id] ? [[role, remap[id]!]] : [])) } });
      return [{ kind: 'subscription', subscriptionId: subscription.id, enabled: subscription.enabled }];
    }
    if (entry.kind === 'rule') { const made = rule(entry.rule); return made ? [{ kind: 'rule', rule: made }] : []; }
    const bindings = Object.fromEntries(Object.entries(entry.set.bindings).flatMap(([role, id]) => remap[id] ? [[role, remap[id]!]] : []));
    const set: LocalSet = { id: newId(), name: entry.set.name, enabled: entry.set.enabled, createdAt: now, updatedAt: now, origin: entry.set.origin,
      roles: entry.set.roles, bindings, rules: entry.set.rules.map(rule).filter((item): item is LocalRule => item !== null) };
    return [{ kind: 'set', set }];
  });
  return { entries, skipped, subscriptions };
}
