import { automationDigest } from '@know-n/colp/automation';
import type { SnapshotStateArea } from './bundle-store.js';
import { closed, formatOf, record } from './closed-value.js';
import { createLane } from './lane.js';
import { parseRuleList, RULE_LIST_KEY, PREVIOUS_RULE_LIST_KEY, LEGACY_RULES_KEY, type ListChangeResult, type ListEntry, type LocalRule, type RuleListRecord,
  type RuleSaveResult } from './rule-list-store.js';
import { parseRuleset, withinScope, type ParsedRuleset, type Ruleset } from './ruleset-format.js';
import { adjusted, copiedRule, recompileCollections, type Adjustment, type SubscriptionSource } from './subscription-list.js';
import { REFRESH_INTERVALS, type RefreshInterval } from './subscription-messages.js';

/**
 * Rule-set subscriptions in this browser (doc 17 §4.2, §8, R14): a `colp.ruleset/v1` address the Owner
 * subscribed to, the versions fetched from it and the Owner's own adjustments, each under its own key in
 * the automation store. The list (rule-list-store.ts) holds where a subscription stands; adding,
 * activating and removing write the list and these keys in one transaction, so a save reads one version
 * whole or the other (RS-12.4). Until a version validates the subscription is `notReady` and adds nothing.
 * A later version waits as the candidate unless *Automatic* may apply it (R10) and it is not pinned; *Apply*
 * takes the candidate, *Use previous version* swaps back and pins. A failure leaves the current version in
 * force (RS-13.1). Nothing here reaches the network: fetching is subscription-fetch.ts, called from the worker.
 */
export const SUBSCRIPTION_RECORD_PREFIX = 'known.automation.subscription.v1:';
export const SUBSCRIPTION_CONTENT_PREFIX = 'known.automation.subscriptionContent.v1:';
export const SUBSCRIPTION_LOCAL_PREFIX = 'known.automation.subscriptionLocal.v1:';
export type ContentSlot = 'current' | 'previous' | 'candidate';
export const subscriptionKeys = (id: string) => ({
  record: `${SUBSCRIPTION_RECORD_PREFIX}${id}`, local: `${SUBSCRIPTION_LOCAL_PREFIX}${id}`,
  content: (slot: ContentSlot) => `${SUBSCRIPTION_CONTENT_PREFIX}${id}:${slot}` });

/** The refresh alarm's tick takes at most this many, oldest attempt first (§8 Refresh). */
export const REFRESH_PER_TICK = 3;
const HOUR = 60 * 60 * 1000, LOCAL_LIMIT = 2_000, ETAG_LIMIT = 512;

export type FailureCode = 'network' | 'http' | 'tooLarge' | 'invalid' | 'unsupported' | 'permission';
export interface SubscriptionFailure { readonly code: FailureCode; readonly status?: number; readonly at: number }
export interface SubscriptionPublisher { readonly name: string; readonly url: string | null; readonly feedbackUrl: string | null }
export interface SubscriptionRecord {
  readonly id: string;
  readonly url: string;
  readonly origin: string;
  /** The rule set's own id in its current version. */
  readonly documentId: string | null;
  readonly name: string;
  readonly publisher: SubscriptionPublisher | null;
  readonly updatePolicy: 'review' | 'auto';
  readonly refreshIntervalHours: RefreshInterval;
  /** No refresh is attempted. */
  readonly paused: boolean;
  /** No version is applied by itself, whatever the policy. */
  readonly pinned: boolean;
  readonly state: 'notReady' | 'ready';
  readonly currentVersion: string | null;
  readonly previousVersion: string | null;
  readonly candidateVersion: string | null;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  /** Of the current or candidate version, sent back so an unchanged file is not sent again. */
  readonly etag: string | null;
  readonly lastFailure: SubscriptionFailure | null;
  readonly createdAt: number;
}
export interface ContentRecord { readonly version: string; readonly digest: string; readonly fetchedAt: number; readonly document: Ruleset }
export interface LocalAdjustments {
  readonly disabledEntryIds: readonly string[];
  /** Hosts and registrable domains this subscription's entries leave alone (RS-05.3). */
  readonly exceptions: readonly { readonly id: string; readonly scope: 'host' | 'domain'; readonly value: string; readonly createdAt: number }[];
  /** Role key → native folder id. */
  readonly bindings: Readonly<Record<string, string>>;
}
export const NO_ADJUSTMENTS: LocalAdjustments = { disabledEntryIds: [], exceptions: [], bindings: {} };

/** What one fetch came back with (subscription-fetch.ts). */
export type RefreshOutcome = { readonly kind: 'failed'; readonly code: FailureCode; readonly status?: number }
  | { readonly kind: 'notModified' }
  | { readonly kind: 'fetched'; readonly text: string; readonly etag: string | null };

const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;
const textOrNull = (value: unknown, limit: number) => value === null || text(value, limit);
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timeOrNull = (value: unknown) => value === null || time(value);
const ID = /^[\w-]{1,128}$/u, ENTRY = /^[A-Za-z0-9._-]{1,64}$/u, FOLDER = /^[\w.-]{1,128}$/u;
const FAILURES = new Set<string>(['network', 'http', 'tooLarge', 'invalid', 'unsupported', 'permission']);
const RECORD_KEYS = ['id', 'url', 'origin', 'documentId', 'name', 'publisher', 'updatePolicy', 'refreshIntervalHours', 'paused', 'pinned', 'state',
  'currentVersion', 'previousVersion', 'candidateVersion', 'lastAttemptAt', 'lastSuccessAt', 'etag', 'lastFailure', 'createdAt'];

/** A record this build can read, or null: a key it does not know means a newer build wrote it. */
export function parseSubscriptionRecord(value: unknown): SubscriptionRecord | null {
  if (!record(value) || !closed(value, RECORD_KEYS)) return null;
  const { publisher, lastFailure } = value;
  const publisherOk = publisher === null || record(publisher) && closed(publisher, ['name', 'url', 'feedbackUrl']) && text(publisher.name, 200)
    && textOrNull(publisher.url, 2_048) && textOrNull(publisher.feedbackUrl, 2_048);
  const failureOk = lastFailure === null || record(lastFailure) && closed(lastFailure, ['code', 'at'], ['status']) && typeof lastFailure.code === 'string'
    && FAILURES.has(lastFailure.code) && time(lastFailure.at) && (lastFailure.status === undefined || Number.isInteger(lastFailure.status));
  const ok = typeof value.id === 'string' && ID.test(value.id) && text(value.url, 2_048) && text(value.origin, 2_048) && textOrNull(value.documentId, 64)
    && text(value.name, 200) && publisherOk && (value.updatePolicy === 'review' || value.updatePolicy === 'auto')
    && REFRESH_INTERVALS.includes(value.refreshIntervalHours as RefreshInterval) && typeof value.paused === 'boolean' && typeof value.pinned === 'boolean'
    && (value.state === 'notReady' || value.state === 'ready') && textOrNull(value.currentVersion, 64) && textOrNull(value.previousVersion, 64)
    && textOrNull(value.candidateVersion, 64) && timeOrNull(value.lastAttemptAt) && timeOrNull(value.lastSuccessAt) && textOrNull(value.etag, ETAG_LIMIT)
    && failureOk && time(value.createdAt) && (value.state === 'ready') === (value.currentVersion !== null);
  return ok ? value as unknown as SubscriptionRecord : null;
}

/** Content is read through the same parser that checked it when it arrived, once per digest. */
const parsedByDigest = new Map<string, Extract<ParsedRuleset, { ok: true }>>();
const PARSED_CACHE = 64;
export function contentRuleset(content: ContentRecord): Extract<ParsedRuleset, { ok: true }> | null {
  const known = parsedByDigest.get(content.digest);
  if (known) return known;
  const parsed = parseRuleset(JSON.stringify(content.document));
  if (!parsed.ok || automationDigest(parsed.ruleset) !== content.digest || parsed.ruleset.version !== content.version) return null;
  if (parsedByDigest.size >= PARSED_CACHE) parsedByDigest.delete(parsedByDigest.keys().next().value!);
  parsedByDigest.set(content.digest, parsed);
  return parsed;
}
export function parseContentRecord(value: unknown): ContentRecord | null {
  if (!record(value) || !closed(value, ['version', 'digest', 'fetchedAt', 'document']) || !text(value.version, 64) || !text(value.digest, 128)
    || !time(value.fetchedAt) || !record(value.document)) return null;
  const content = value as unknown as ContentRecord;
  return contentRuleset(content) ? content : null;
}
export function parseLocalAdjustments(value: unknown): LocalAdjustments {
  if (!record(value) || !closed(value, ['disabledEntryIds', 'exceptions', 'bindings'])) return NO_ADJUSTMENTS;
  const { disabledEntryIds, exceptions, bindings } = value;
  const ok = Array.isArray(disabledEntryIds) && disabledEntryIds.length <= LOCAL_LIMIT && disabledEntryIds.every((item) => typeof item === 'string' && ENTRY.test(item))
    && Array.isArray(exceptions) && exceptions.length <= LOCAL_LIMIT && exceptions.every((item) => record(item) && closed(item, ['id', 'scope', 'value', 'createdAt'])
      && typeof item.id === 'string' && ID.test(item.id) && (item.scope === 'host' || item.scope === 'domain') && text(item.value, 253) && time(item.createdAt))
    && record(bindings) && Object.entries(bindings).every(([role, folder]) => ENTRY.test(role) && typeof folder === 'string' && FOLDER.test(folder));
  return ok ? value as unknown as LocalAdjustments : NO_ADJUSTMENTS;
}

/** A checked file as it is kept: the parsed document and its digest. */
export function contentFrom(parsed: Extract<ParsedRuleset, { ok: true }>, now: number): ContentRecord {
  const digest = automationDigest(parsed.ruleset);
  parsedByDigest.set(digest, parsed);
  return { version: parsed.ruleset.version, digest, fetchedAt: now, document: parsed.ruleset };
}
const publisherOf = (ruleset: Ruleset): SubscriptionPublisher | null => ruleset.publisher
  ? { name: ruleset.publisher.name, url: ruleset.publisher.url ?? null, feedbackUrl: ruleset.publisher.feedbackUrl ?? null } : null;

/** The list's side of a subscription (rule-list-store.ts). */
export interface SubscriptionListPort {
  load(): Promise<RuleListRecord>;
  addSubscription(id: string, writes: Readonly<Record<string, unknown>>, index?: number): Promise<ListChangeResult>;
  subscriptionWrite(writes: Readonly<Record<string, unknown>>, deletes?: readonly string[],
    recompile?: (entries: readonly ListEntry[]) => readonly ListEntry[]): Promise<number>;
  addAbove(subscriptionId: string, rule: LocalRule, writes: Readonly<Record<string, unknown>>): Promise<RuleSaveResult>;
  removeSubscription(id: string, deletes: readonly string[]): Promise<ListChangeResult>;
}
export interface SubscribeInput {
  readonly url: string;
  readonly origin: string;
  readonly updatePolicy: SubscriptionRecord['updatePolicy'];
  readonly refreshIntervalHours: RefreshInterval;
  readonly bindings: Readonly<Record<string, string>>;
  readonly index?: number;
}
export type SubscribeResult = { readonly ok: true; readonly record: SubscriptionRecord } | { readonly ok: false; readonly error: 'limit' | 'duplicate' };

/** A subscription not fetched yet: named by its host until a version says otherwise. */
export function newSubscription(id: string, input: Omit<SubscribeInput, 'bindings' | 'index'> & { readonly paused?: boolean; readonly pinned?: boolean },
  now: number): SubscriptionRecord {
  return { id, url: input.url, origin: input.origin, documentId: null, name: new URL(input.url).host.slice(0, 200), publisher: null,
    updatePolicy: input.updatePolicy, refreshIntervalHours: input.refreshIntervalHours, paused: input.paused ?? false, pinned: input.pinned ?? false,
    state: 'notReady', currentVersion: null, previousVersion: null, candidateVersion: null, lastAttemptAt: null, lastSuccessAt: null, etag: null,
    lastFailure: null, createdAt: now };
}
/** Every key a subscription has, for removing it with the list. */
export const subscriptionKeyList = (id: string): string[] => {
  const keys = subscriptionKeys(id);
  return [keys.record, keys.local, keys.content('current'), keys.content('previous'), keys.content('candidate')];
};
export type SettingsPatch = Partial<Pick<SubscriptionRecord, 'updatePolicy' | 'refreshIntervalHours' | 'paused' | 'pinned'>>;

/** A subscription's source from values read together: its record, current and waiting versions, and adjustments. */
function sourceOf(id: string, values: Readonly<Record<string, unknown>>): SubscriptionSource | null {
  const keys = subscriptionKeys(id), record = parseSubscriptionRecord(values[keys.record]);
  if (!record) return null;
  const current = record.state === 'ready' ? parseContentRecord(values[keys.content('current')]) : null;
  const candidate = record.candidateVersion !== null ? parseContentRecord(values[keys.content('candidate')]) : null;
  return { record, current: current ? contentRuleset(current) : null, fetchedAt: current?.fetchedAt ?? null,
    candidate: candidate ? contentRuleset(candidate) : null, local: parseLocalAdjustments(values[keys.local]) };
}
const sourceKeys = (id: string) => { const keys = subscriptionKeys(id); return [keys.record, keys.local, keys.content('current'), keys.content('candidate')]; };

export function createSubscriptionStore(area: SnapshotStateArea, list: SubscriptionListPort, options: { readonly id?: () => string } = {}) {
  const newId = options.id ?? (() => crypto.randomUUID());
  const exclusive = createLane();
  const read = async (id: string) => parseSubscriptionRecord(await area.get(subscriptionKeys(id).record));
  const content = async (id: string, slot: ContentSlot) => parseContentRecord(await area.get(subscriptionKeys(id).content(slot)));
  async function all(): Promise<{ readonly id: string; readonly enabled: boolean; readonly record: SubscriptionRecord | null }[]> {
    const entries = (await list.load()).entries.flatMap((entry) => entry.kind === 'subscription' ? [entry] : []);
    return Promise.all(entries.map(async (entry) => ({ id: entry.subscriptionId, enabled: entry.enabled, record: await read(entry.subscriptionId) })));
  }

  /** A fetched file: the first that checks becomes current at once; a later new version waits as the candidate. */
  async function arrived(previous: SubscriptionRecord, text: string, etag: string | null, now: number): Promise<SubscriptionRecord> {
    const attempted = { ...previous, lastAttemptAt: now };
    const parsed = parseRuleset(text);
    if (!parsed.ok) {
      const unsupported = parsed.problems.some((problem) => problem.code === 'format') && /^colp\.ruleset\//u.test(String(formatOf(text)));
      return failed(attempted, unsupported ? 'unsupported' : 'invalid', now);
    }
    const next = contentFrom(parsed, now), keys = subscriptionKeys(previous.id);
    const [current, candidate] = await Promise.all([content(previous.id, 'current'), content(previous.id, 'candidate')]);
    const succeeded = { ...attempted, lastSuccessAt: now, lastFailure: null, etag: etag !== null && etag.length <= ETAG_LIMIT ? etag : null };
    if (current?.digest === next.digest || candidate?.digest === next.digest) { await area.set(keys.record, succeeded); return succeeded; }
    // A version names one content: a file that changes without a new version is refused, so explanations stay true.
    if (current?.version === next.version || candidate?.version === next.version) return failed(attempted, 'invalid', now);
    if (previous.state === 'notReady' || !current) return activate(succeeded, next, null, null);
    // Automatic applies what keeps the same rule set and folder roles; pinned, or anything else, waits (R10).
    const scoped = contentRuleset(current);
    if (previous.updatePolicy === 'auto' && !previous.pinned && scoped && withinScope(scoped.ruleset, parsed.ruleset).ok) return activate(succeeded, next, current, null);
    const waiting: SubscriptionRecord = { ...succeeded, candidateVersion: next.version };
    await area.commit({ [keys.record]: waiting, [keys.content('candidate')]: next });
    return waiting;
  }
  /**
   * `current` in force from now, `previous` kept to go back to, `candidate` still waiting: the three slots, the
   * record and every rule naming its sites (recompiled, RS-10.4) in one write with a new list revision (RS-12.4).
   */
  async function activate(record: SubscriptionRecord, current: ContentRecord, previous: ContentRecord | null, candidate: ContentRecord | null,
    patch: SettingsPatch = {}): Promise<SubscriptionRecord> {
    const parsed = contentRuleset(current)!, keys = subscriptionKeys(record.id);
    const next: SubscriptionRecord = { ...record, ...patch, state: 'ready', currentVersion: current.version, previousVersion: previous?.version ?? null,
      candidateVersion: candidate?.version ?? null, documentId: parsed.ruleset.id, name: parsed.ruleset.name, publisher: publisherOf(parsed.ruleset) };
    const slots = { current, previous, candidate } as const;
    const writes: Record<string, unknown> = { [keys.record]: next }, deletes: string[] = [];
    for (const [slot, value] of Object.entries(slots)) { if (value) writes[keys.content(slot as ContentSlot)] = value; else deletes.push(keys.content(slot as ContentSlot)); }
    await list.subscriptionWrite(writes, deletes, (entries) => recompileCollections(entries, record.id, parsed));
    return next;
  }
  /** Under *Automatic* and not pinned, a waiting version the scope allows is applied (after Unpin, or switching to Automatic). */
  async function resume(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    if (record.updatePolicy !== 'auto' || record.pinned || record.candidateVersion === null) return record;
    const [current, candidate] = await Promise.all([content(record.id, 'current'), content(record.id, 'candidate')]);
    const from = current && contentRuleset(current), to = candidate && contentRuleset(candidate);
    return from && to && withinScope(from.ruleset, to.ruleset).ok ? activate(record, candidate!, current, null) : record;
  }
  async function failed(attempted: SubscriptionRecord, code: FailureCode, now: number, status?: number): Promise<SubscriptionRecord> {
    const next = { ...attempted, lastFailure: { code, ...(status !== undefined ? { status } : {}), at: now } };
    await area.set(subscriptionKeys(attempted.id).record, next);
    return next;
  }

  const adjustments = async (id: string) => parseLocalAdjustments(await area.get(subscriptionKeys(id).local));
  /** Its record, versions and adjustments, read together; null once it is gone. */
  const source = async (id: string): Promise<SubscriptionSource | null> => sourceOf(id, await area.getMany(sourceKeys(id)));

  return {
    all,
    get: read,
    content,
    adjustments,
    source,
    /**
     * The list and every subscription in it, read in one transaction: a save or a preview sees one version of
     * each, with the rules compiled from it, never a mixture (RS-12.4).
     */
    async snapshot(): Promise<{ readonly list: RuleListRecord; readonly sources: Map<string, SubscriptionSource> }> {
      const ids = (await list.load()).entries.flatMap((entry) => entry.kind === 'subscription' ? [entry.subscriptionId] : []);
      const values = await area.getMany([RULE_LIST_KEY, PREVIOUS_RULE_LIST_KEY, LEGACY_RULES_KEY, ...ids.flatMap(sourceKeys)]);
      if (values[PREVIOUS_RULE_LIST_KEY] !== undefined || values[LEGACY_RULES_KEY] !== undefined) throw new Error('legacyRuleMergeRequired');
      const current = parseRuleList(values[RULE_LIST_KEY]);
      const sources = new Map(ids.flatMap((id) => { const found = sourceOf(id, values); return found ? [[id, found] as const] : []; }));
      return { list: current, sources };
    },
    /** Apply: the waiting version becomes current; the one it replaces is kept as previous. */
    apply(id: string): Promise<SubscriptionRecord | null> {
      return exclusive(async () => {
        const record = await read(id);
        const [current, candidate] = await Promise.all([content(id, 'current'), content(id, 'candidate')]);
        return record && current && candidate ? activate(record, candidate, current, null) : null;
      });
    },
    /** Use previous version (RS-13.3): previous and current swap, and it is pinned there; a waiting version stays waiting. */
    rollback(id: string): Promise<SubscriptionRecord | null> {
      return exclusive(async () => {
        const record = await read(id);
        const [current, previous, candidate] = await Promise.all([content(id, 'current'), content(id, 'previous'), content(id, 'candidate')]);
        return record && current && previous ? activate(record, previous, current, candidate, { pinned: true }) : null;
      });
    },
    /** One adjustment (subscription-list.ts), written with a new list revision: what saves get from it changes. */
    adjust(id: string, change: Adjustment, now: number): Promise<ListChangeResult | { readonly ok: false; readonly error: 'invalid' }> {
      return exclusive(async () => {
        const found = await source(id);
        if (!found) return { ok: false, error: 'notFound' } as const;
        const next = adjusted(found.local, change, found.current, newId, now);
        if (next === 'invalid') return { ok: false, error: 'invalid' } as const;
        return { ok: true, revision: await list.subscriptionWrite({ [subscriptionKeys(id).local]: next }) } as const;
      });
    },
    /** Copy to my rules (RS-05.4): the rule just above the subscription and, when asked, the entry switched off, in one write. */
    copyEntry(id: string, entryId: string, disableOriginal: boolean, now: number): Promise<RuleSaveResult> {
      return exclusive(async (): Promise<RuleSaveResult> => {
        const found = await source(id);
        const item = found?.current?.compiled.find((entry) => entry.entry.id === entryId);
        if (!found?.current || !item) return { ok: false, error: 'notFound' };
        const rule = copiedRule(item, { ...found, current: found.current }, newId(), now);
        if (!rule) return { ok: false, error: 'unbound' };
        const local = disableOriginal ? adjusted(found.local, { kind: 'entry', entryId, enabled: false }, found.current, newId, now) : null;
        return list.addAbove(id, rule, local && local !== 'invalid' ? { [subscriptionKeys(id).local]: local } : {});
      });
    },
    /** Subscribe: the record and its place in the list, with nothing to file until a version checks. */
    create(input: SubscribeInput, now: number): Promise<SubscribeResult> {
      return exclusive(async (): Promise<SubscribeResult> => {
        if ((await all()).some((item) => item.record?.url === input.url)) return { ok: false, error: 'duplicate' };
        const id = newId(), keys = subscriptionKeys(id), made = newSubscription(id, input, now);
        const local: LocalAdjustments = { ...NO_ADJUSTMENTS, bindings: { ...input.bindings } };
        const added = await list.addSubscription(id, { [keys.record]: made, [keys.local]: local }, input.index);
        return added.ok ? { ok: true, record: made } : { ok: false, error: added.error === 'limit' ? 'limit' : 'duplicate' };
      });
    },
    /** One fetch's result, recorded; null when the subscription was removed meanwhile. */
    settle(id: string, outcome: RefreshOutcome, now: number): Promise<SubscriptionRecord | null> {
      return exclusive(async () => {
        const previous = await read(id);
        if (!previous) return null;
        if (outcome.kind === 'failed') return failed({ ...previous, lastAttemptAt: now }, outcome.code, now, outcome.status);
        if (outcome.kind === 'fetched') return arrived(previous, outcome.text, outcome.etag, now);
        const unchanged = { ...previous, lastAttemptAt: now, lastSuccessAt: now, lastFailure: null };
        await area.set(subscriptionKeys(id).record, unchanged);
        return unchanged;
      });
    },
    update(id: string, patch: SettingsPatch): Promise<SubscriptionRecord | null> {
      return exclusive(async () => {
        const previous = await read(id);
        if (!previous) return null;
        const next = { ...previous, ...patch };
        await area.set(subscriptionKeys(id).record, next);
        return resume(next);
      });
    },
    /** Its versions, adjustments and place in the list go together; rules copied from it stay. */
    remove(id: string): Promise<ListChangeResult> {
      return exclusive(async (): Promise<ListChangeResult> => {
        const listed = (await list.load()).entries.some((entry) => entry.kind === 'subscription' && entry.subscriptionId === id);
        if (!listed && !await read(id)) return { ok: false, error: 'notFound' };
        return list.removeSubscription(id, subscriptionKeyList(id));
      });
    },
    /** Those the refresh alarm takes now: not paused, their interval passed since the last attempt, oldest attempt first. */
    async due(now: number, limit: number = REFRESH_PER_TICK): Promise<SubscriptionRecord[]> {
      return (await all()).flatMap((item) => item.record && !item.record.paused
        && (item.record.lastAttemptAt === null || item.record.lastAttemptAt + item.record.refreshIntervalHours * HOUR <= now) ? [item.record] : [])
        .sort((a, b) => (a.lastAttemptAt ?? -1) - (b.lastAttemptAt ?? -1)).slice(0, limit);
    },
  };
}
export type SubscriptionStore = ReturnType<typeof createSubscriptionStore>;

