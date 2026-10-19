import { normalizeHost } from '@know-n/colp/automation';
import { isPublicSuffix, registrableDomain } from './public-suffix.js';
import { checkRuleDraft, collectionRef, type CollectionLookup } from './rule-conditions.js';
import type { FlatItem, SubscriptionItems } from './rule-list-flatten.js';
import type { ListEntry, LocalRule } from './rule-list-store.js';
import { sitePredicate, withinScope, type CompiledEntry, type ParsedRuleset } from './ruleset-format.js';
import type { BrowserSubscriptionView } from './subscription-messages.js';
import type { LocalAdjustments, SubscriptionRecord } from './subscription-store.js';

/**
 * A subscription in the list (doc 17 §6.1, R4, RS-05, RS-10): what its current version gives a save, the
 * Owner's adjustments to it, and the Owner's rules that name its sites. Upstream order is the order;
 * here an entry can be switched off, a site left alone by this subscription only, and a role bound to a
 * folder. Adjustments name entries by id, so one renamed upstream keeps them and one that comes back
 * under its old id gets them again (R4). Nothing here reads storage or the network.
 */
type Parsed = Extract<ParsedRuleset, { ok: true }>;
export interface SubscriptionSource {
  readonly record: SubscriptionRecord;
  /** Its current version, parsed; null while it has none. */
  readonly current: Parsed | null;
  /** When that version arrived. */
  readonly fetchedAt: number | null;
  /** A version waiting for review, parsed. */
  readonly candidate?: Parsed | null;
  readonly local: LocalAdjustments;
}

/** A subscription as Options shows it (RS-04.2, RS-15.2). */
export function subscriptionRecordView({ record, current, candidate, fetchedAt }: SubscriptionSource): BrowserSubscriptionView {
  const scope = current && candidate ? withinScope(current.ruleset, candidate.ruleset) : null;
  const waits = record.candidateVersion === null ? null : record.pinned ? 'pinned' : record.updatePolicy === 'review' ? 'review' : scope?.reasons[0] ?? 'review';
  return { id: record.id, url: record.url, origin: record.origin, name: record.name, publisher: record.publisher, license: current?.ruleset.license ?? null,
    state: record.state, updatePolicy: record.updatePolicy, refreshIntervalHours: record.refreshIntervalHours, paused: record.paused, pinned: record.pinned,
    currentVersion: record.currentVersion, previousVersion: record.previousVersion, candidateVersion: record.candidateVersion, candidateWaits: waits, fetchedAt,
    lastAttemptAt: record.lastAttemptAt, lastSuccessAt: record.lastSuccessAt, lastFailure: record.lastFailure };
}

/** Its current version's entries that file somewhere, in document order, less those switched off here, each filing where its role is bound. */
export function subscriptionItems(source: SubscriptionSource): SubscriptionItems {
  const { record, current, local } = source;
  if (record.state !== 'ready' || !current) return { name: record.name, ready: false, contentVersion: null, items: [] };
  const version = current.ruleset.version, off = new Set(local.disabledEntryIds);
  const exceptions = local.exceptions.map(({ scope, value }) => ({ scope, value }));
  const items = current.compiled.filter((item) => !off.has(item.entry.id)).map((item): FlatItem => ({
    ref: { kind: 'subscriptionEntry', subscriptionId: record.id, entryId: item.entry.id, contentVersion: version },
    // Two subscriptions may use one entry id; the item's own id stays unique in the list.
    id: `${record.id}:${item.entry.id}`, name: item.name, source: { id: record.id, name: record.name }, definition: item.definition,
    action: { kind: 'file', folderNativeId: local.bindings[item.entry.role!] ?? null }, exceptions }));
  return { name: record.name, ready: true, contentVersion: version, items };
}

/** The subscriptions whose collections a rule's conditions name. */
export const collectionsOf = (rule: Pick<LocalRule, 'conditions'>): string[] => [...new Set(rule.conditions.flatMap((condition) => {
  const ref = condition.kind === 'siteCollection' ? collectionRef(condition.value) : null;
  return ref ? [ref.subscriptionId] : [];
}))];

/** A collection's sites as rules read them: from each subscription's current version. */
export function collectionLookup(sources: ReadonlyMap<string, SubscriptionSource>): CollectionLookup {
  return (subscriptionId, siteId) => {
    const current = sources.get(subscriptionId)?.current;
    return current ? siteOf(current, siteId) : null;
  };
}
function siteOf(parsed: Parsed, siteId: string) {
  const site = parsed.ruleset.sites.find((item) => item.id === siteId);
  return site ? { name: site.name, predicate: sitePredicate(site), version: parsed.ruleset.version } : null;
}

/**
 * Rules with a site of this subscription's collection, compiled again from the version about to be
 * current (RS-10.4): where they stand, what they do and whether they are on stay as they were. A rule
 * whose site is gone keeps its last definition and the version it came from, and the list shows it as
 * needing attention until it is edited.
 */
export function recompileCollections(entries: readonly ListEntry[], subscriptionId: string, next: Parsed): ListEntry[] {
  const lookup: CollectionLookup = (id, siteId) => id === subscriptionId ? siteOf(next, siteId) : null;
  const again = (rule: LocalRule): LocalRule => {
    // A rule's sites come from one subscription (rule-conditions.ts), so this version is all it needs.
    if (!collectionsOf(rule).includes(subscriptionId)) return rule;
    const checked = checkRuleDraft({ name: rule.name, combinator: rule.combinator, conditions: rule.conditions, action: rule.action }, lookup);
    return checked.ok ? { ...rule, definition: checked.definition,
      compiledFrom: { contentVersions: { ...rule.compiledFrom.contentVersions, ...checked.contentVersions } } } : rule;
  };
  return entries.map((entry): ListEntry => entry.kind === 'rule' ? { kind: 'rule', rule: again(entry.rule) }
    : entry.kind === 'set' ? { kind: 'set', set: { ...entry.set, rules: entry.set.rules.map(again) } } : entry);
}

/** A rule that names a collection's site is tried only while it was compiled from that subscription's current version. */
export function collectionStale(rule: Pick<LocalRule, 'conditions' | 'compiledFrom'>, currentVersion: (subscriptionId: string) => string | null): boolean {
  return collectionsOf(rule).some((id) => {
    const version = currentVersion(id);
    return version === null || rule.compiledFrom.contentVersions[id] !== version;
  });
}

export type Adjustment =
  | { readonly kind: 'entry'; readonly entryId: string; readonly enabled: boolean }
  /** A site this subscription leaves alone: one host, or a registrable domain with every host under it. */
  | { readonly kind: 'exception'; readonly scope: 'host' | 'domain'; readonly value: string }
  | { readonly kind: 'removeException'; readonly exceptionId: string }
  /** Role key → folder id here; null unbinds. */
  | { readonly kind: 'bindings'; readonly bindings: Readonly<Record<string, string | null>> }
  /** Forget the switched-off entries no longer in the current version (RS-05.5). */
  | { readonly kind: 'clearGone' };
export const EXCEPTION_LIMIT = 200;

/** The adjustments after one change; `invalid` for a site that is no site, a public suffix, or past the limit. */
export function adjusted(local: LocalAdjustments, change: Adjustment, current: Parsed | null, newId: () => string, now: number): LocalAdjustments | 'invalid' {
  switch (change.kind) {
    case 'entry': {
      const others = local.disabledEntryIds.filter((id) => id !== change.entryId);
      return { ...local, disabledEntryIds: change.enabled ? others : [...others, change.entryId] };
    }
    case 'exception': {
      const host = normalizeHost(change.value.trim());
      if (!host || local.exceptions.length >= EXCEPTION_LIMIT) return 'invalid';
      const value = change.scope === 'domain' ? registrableDomain(host) ?? host : host;
      if (isPublicSuffix(value)) return 'invalid';
      if (local.exceptions.some((item) => item.scope === change.scope && item.value === value)) return local;
      return { ...local, exceptions: [...local.exceptions, { id: newId(), scope: change.scope, value, createdAt: now }] };
    }
    case 'removeException': return { ...local, exceptions: local.exceptions.filter((item) => item.id !== change.exceptionId) };
    case 'bindings': {
      const bindings: Record<string, string> = { ...local.bindings };
      for (const [role, folder] of Object.entries(change.bindings)) { if (folder) bindings[role] = folder; else delete bindings[role]; }
      return { ...local, bindings };
    }
    case 'clearGone': {
      const present = new Set(current?.ruleset.entries.map((entry) => entry.id) ?? []);
      return { ...local, disabledEntryIds: local.disabledEntryIds.filter((id) => present.has(id)) };
    }
  }
}

/** Switched-off entries the current version no longer has: kept, in case they return (R4), and counted for *Clear*. */
export const goneSettings = (local: LocalAdjustments, current: Parsed | null): number => current
  ? local.disabledEntryIds.filter((id) => !current.ruleset.entries.some((entry) => entry.id === id)).length : 0;

/**
 * Copy to my rules from a subscription (RS-05.4): the entry as a rule of the Owner's, filing where its role
 * is bound here, with where it came from. Conditions the editor can write are kept; otherwise only its
 * definition, so it switches, moves and is deleted but not edited. Null while its role has no folder.
 */
export function copiedRule(item: CompiledEntry, source: SubscriptionSource & { readonly current: Parsed }, id: string, now: number): LocalRule | null {
  const folderNativeId = source.local.bindings[item.entry.role!];
  if (!folderNativeId) return null;
  const action = { kind: 'file' as const, folderNativeId };
  const checked = item.conditions ? checkRuleDraft({ name: item.name, ...item.conditions, action }) : null;
  return { id, enabled: true, name: item.name, combinator: checked?.ok ? item.conditions!.combinator : 'all', conditions: checked?.ok ? checked.conditions : [],
    action, definition: checked?.ok ? checked.definition : item.definition, compiledFrom: { contentVersions: {} }, createdAt: now, updatedAt: now,
    origin: { kind: 'copiedFrom', subscriptionId: source.record.id, entryId: item.entry.id, contentVersion: source.current.ruleset.version } };
}
