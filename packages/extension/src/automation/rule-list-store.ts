import { relateBrowserRule, type OverlapRule } from './browser-overlap.js';
import type { AtomicStateArea } from './bundle-store.js';
import { createLane } from './lane.js';
import { checkRuleDraft, NAME_LIMIT, type CollectionLookup, type DraftProblem, type RuleDraft } from './rule-conditions.js';
import { EMPTY_LIST, entryId, individualRules, LEGACY_RULES_KEY, migrateLegacyRules, migrateOrderedRules, PREVIOUS_RULE_LIST_KEY, RULE_MIGRATION_KEY, overLimits, parseRuleList, REVIEW_LIMIT, RULE_LIST_KEY,
  ruleFolderNativeId, type ListEntry, type LocalRule, type LocalSet, type RuleListRecord } from './rule-list-record.js';

export * from './rule-list-record.js';

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
  /** `unbound`: a set's rule copied out (or moved out) has no folder bound to its role to file into. */
  | { readonly ok: false; readonly error: 'notFound' | 'limit' | 'unbound' };
export type SetSaveResult = { readonly ok: true; readonly set: LocalSet }
  | { readonly ok: false; readonly error: 'invalid' | 'notFound' | 'limit' };
/** `mismatch`: the order names other entries than the list has; `unbound`: a rule would leave its set with no folder to keep. */
export type ListChangeResult = { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly error: 'notFound' | 'mismatch' | 'limit' | 'unbound' };
export type EntryRef = { readonly kind: 'rule' | 'set' | 'subscription'; readonly id: string };

/** `writes` and `deletes`: a subscription's own keys (subscription-store.ts), in the list's transaction; `touch`: a new revision with nothing else changed. */
type Change<T> = { readonly result: T; readonly entries?: readonly ListEntry[]; readonly enabled?: boolean; readonly notice?: 'dismiss';
  readonly writes?: Readonly<Record<string, unknown>>; readonly deletes?: readonly string[]; readonly touch?: true };

export function createRuleListStore(area: AtomicStateArea, options: { readonly id?: () => string; readonly now?: () => number } = {}) {
  const newId = options.id ?? (() => crypto.randomUUID());
  const clock = options.now ?? Date.now;
  const exclusive = createLane();
  /** Inside the lane: a list written by an earlier build moves here with its old key deleted, in one transaction. */
  async function current(): Promise<RuleListRecord> {
    const value = await area.get(RULE_LIST_KEY);
    const previous = await area.get(PREVIOUS_RULE_LIST_KEY), legacy = await area.get(LEGACY_RULES_KEY);
    if (value !== undefined) {
      if (previous !== undefined || legacy !== undefined) throw new Error('legacyRuleMergeRequired');
      return parseRuleList(value);
    }
    if (previous === undefined && legacy === undefined) return EMPTY_LIST;
    const migrated = previous !== undefined ? migrateOrderedRules(previous) : migrateLegacyRules(legacy, clock());
    await area.commit({ [RULE_LIST_KEY]: migrated, [RULE_MIGRATION_KEY]: { migratedAt: clock(), previous, legacy } },
      [PREVIOUS_RULE_LIST_KEY, LEGACY_RULES_KEY]);
    return migrated;
  }
  /** One change: written with the next revision when it changes anything, else left alone. */
  function update<T>(work: (list: RuleListRecord) => Change<T>): Promise<T> {
    return updateAsync((list) => Promise.resolve(work(list)));
  }
  /** The same, for a change that reads more of the store first: it reads inside the lane, so nothing is written between its read and its write. */
  function updateAsync<T>(work: (list: RuleListRecord) => Promise<Change<T>>): Promise<T> {
    return exclusive(async () => {
      const list = await current();
      const change = await work(list);
      if (change.entries === undefined && change.enabled === undefined && change.notice === undefined && !change.touch) return change.result;
      const { orderNotice, ...rest } = list;
      const next: RuleListRecord = { ...rest, revision: list.revision + 1, entries: change.entries ?? list.entries, enabled: change.enabled ?? list.enabled,
        ...(orderNotice && change.notice !== 'dismiss' ? { orderNotice } : {}) };
      if (change.writes || change.deletes) await area.commit({ ...change.writes, [RULE_LIST_KEY]: next }, change.deletes);
      else await area.set(RULE_LIST_KEY, next);
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
    /** Repair/export remains possible even when activation is blocked. Never parses away unknown data. */
    raw: () => exclusive(async () => ({ current: await area.get(RULE_LIST_KEY), previous: await area.get(PREVIOUS_RULE_LIST_KEY),
      legacy: await area.get(LEGACY_RULES_KEY), migration: await area.get(RULE_MIGRATION_KEY) })),
    /**
     * Creates a rule (no id) at the end of the list or of the set `into`, or replaces one's conditions,
     * name and folder where it is. A collection's sites are read through `collections`; given as a function
     * of the list, they are read inside the write lane, so a version activated meanwhile cannot leave the
     * rule compiled from the one before (RS-10.4).
     */
    saveRule(input: { readonly id?: string; readonly draft: RuleDraft; readonly enabled?: boolean; readonly into?: string | null;
      readonly index?: number }, now: number, collections?: CollectionLookup | { readonly read: (list: RuleListRecord) => Promise<CollectionLookup> }): Promise<RuleSaveResult> {
      return updateAsync(async (list): Promise<Change<RuleSaveResult>> => {
        const found = input.id === undefined ? null : locate(list, input.id);
        const draft = { ...input.draft, ...(input.draft.site ?? found?.rule.site ? { site: input.draft.site ?? found?.rule.site } : {}) };
        const checked = checkRuleDraft(draft, typeof collections === 'function' || collections === undefined ? collections : await collections.read(list));
        if (!checked.ok) return { result: { ok: false, error: 'invalid', problems: checked.problems } };
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
          ...(draft.site ? { site: draft.site } : {}),
          compiledFrom: { contentVersions: checked.contentVersions }, createdAt: previous?.createdAt ?? now, updatedAt: now,
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
    /**
     * Copy to my rules (doc 17 RS-03.4, RW-11): a set's rule as a rule of the Owner's own, just above its set so it is
     * tried first, filing where the set binds its role. The original stays in its set, switched off when asked.
     * Subscription entries are copied the same way once subscriptions have content (RW-13).
     */
    copyToMine(ruleId: string, disableOriginal: boolean, now: number): Promise<RuleSaveResult> {
      return update((list): Change<RuleSaveResult> => {
        const found = locate(list, ruleId);
        if (!found?.set) return { result: { ok: false, error: 'notFound' } };
        const kept = outsideSet(found.rule, found.set);
        if (!kept) return { result: { ok: false, error: 'unbound' } };
        const { reviewed: _reviewed, movingSince: _moving, ...rest } = kept;
        const rule: LocalRule = { ...rest, id: newId(), enabled: true, createdAt: now, updatedAt: now };
        const at = list.entries.findIndex((entry) => entry.kind === 'set' && entry.set.id === found.set!.id);
        const entries = insertAt(disableOriginal ? mapRule(list.entries, ruleId, (item) => ({ ...item, enabled: false, updatedAt: now })) : list.entries,
          at, { kind: 'rule', rule });
        const result = changed(list, entries);
        return result.result.ok ? { result: { ok: true, rule }, entries } : { result: { ok: false, error: 'limit' } };
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
    importEntries(entries: readonly ListEntry[], replace: boolean, extra: { readonly writes?: Readonly<Record<string, unknown>>;
      readonly dropped?: (subscriptionId: string) => readonly string[]; readonly enabled?: boolean } = {}): Promise<ListChangeResult> {
      return update((list): Change<ListChangeResult> => {
        const kept = replace ? [] : list.entries;
        const present = new Set(kept.flatMap((entry) => entry.kind === 'subscription' ? [entry.subscriptionId] : []));
        const next = [...kept, ...entries.filter((entry) => entry.kind !== 'subscription' || !present.has(entry.subscriptionId))];
        if (overLimits(next)) return { result: { ok: false, error: 'limit' } };
        // A subscription the replaced list had and the new one does not goes with its keys (subscription-store.ts).
        const staying = new Set(next.flatMap((entry) => entry.kind === 'subscription' ? [entry.subscriptionId] : []));
        const deletes = list.entries.flatMap((entry) => entry.kind === 'subscription' && !staying.has(entry.subscriptionId)
          ? extra.dropped?.(entry.subscriptionId) ?? [] : []);
        return { result: { ok: true, revision: list.revision + 1 }, entries: next, ...(replace ? { notice: 'dismiss' as const, ...(extra.enabled === undefined ? {} : { enabled: extra.enabled }) } : {}),
          ...(extra.writes ? { writes: extra.writes } : {}), ...(deletes.length ? { deletes } : {}) };
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
    /**
     * A subscription's records written with the list (doc 17 §4.2, §8), one transaction each so no save sees one
     * without the other: added at `index` (the end when absent) with its record, its content activated (the
     * revision moves on, so open previews are stale), or taken out with every key it had.
     */
    addSubscription(id: string, writes: Readonly<Record<string, unknown>>, index?: number): Promise<ListChangeResult> {
      return update((list): Change<ListChangeResult> => {
        if (list.entries.some((entry) => entry.kind === 'subscription' && entry.subscriptionId === id)) return { result: { ok: false, error: 'mismatch' } };
        const entries = insertAt(list.entries, index, { kind: 'subscription', subscriptionId: id, enabled: true });
        return overLimits(entries) ? { result: { ok: false, error: 'limit' } } : { result: { ok: true, revision: list.revision + 1 }, entries, writes };
      });
    },
    /** A version activated, or adjustments changed: what saves get from it changes, so the revision moves on; `recompile` gives the new entries. */
    subscriptionWrite(writes: Readonly<Record<string, unknown>>, deletes: readonly string[] = [],
      recompile?: (entries: readonly ListEntry[]) => readonly ListEntry[]): Promise<number> {
      return update((list) => ({ result: list.revision + 1, touch: true, writes, deletes, ...(recompile ? { entries: recompile(list.entries) } : {}) }));
    },
    /** Copy to my rules from a subscription (RS-05.4): the rule goes just above it, with the subscription's own keys written alongside. */
    addAbove(subscriptionId: string, rule: LocalRule, writes: Readonly<Record<string, unknown>>): Promise<RuleSaveResult> {
      return update((list): Change<RuleSaveResult> => {
        const at = list.entries.findIndex((entry) => entry.kind === 'subscription' && entry.subscriptionId === subscriptionId);
        if (at < 0) return { result: { ok: false, error: 'notFound' } };
        const entries = insertAt(list.entries, at, { kind: 'rule', rule });
        return overLimits(entries) ? { result: { ok: false, error: 'limit' } } : { result: { ok: true, rule }, entries, writes };
      });
    },
    removeSubscription(id: string, deletes: readonly string[]): Promise<ListChangeResult> {
      return update((list) => ({ result: { ok: true, revision: list.revision + 1 }, deletes,
        entries: list.entries.filter((entry) => entry.kind !== 'subscription' || entry.subscriptionId !== id) }));
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
      return individual(id, (rule) => rule.site ? null : rule.movingSince === undefined ? { ...rule, movingSince: now } : rule);
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
        if (!rule || rule.site || rule.movingSince === undefined) return { result: null };
        const relation = relateBrowserRule({ id: rule.id, definition: rule.definition, folderNativeId: ruleFolderNativeId(rule) }, account, undefined, now);
        return relation?.kind === 'duplicate' ? { result: rule, entries: withoutRule(list.entries, id) } : { result: null };
      });
    },
  };
}
export type RuleListStore = ReturnType<typeof createRuleListStore>;
