import type { SnapshotStateArea } from '../automation/bundle-store.js';
import { REFRESH_INTERVALS, type RefreshInterval } from '../automation/subscription-messages.js';
import { newSubscription, parseSubscriptionRecord, REFRESH_PER_TICK, type FailureCode, type RefreshOutcome,
  type SubscriptionRecord } from '../automation/subscription-store.js';
import type { RiskSource } from './risk-check.js';
import { buildRiskIndex, parseRiskIndex, type RiskIndex } from './risk-index.js';
import { parseRiskList } from './risklist-format.js';
import { exceptionValue, parseRiskSettings, RISK_EXCEPTION_LIMIT, RISK_SETTINGS_KEY, type RiskMode, type RiskSettings,
  type StoredRiskException } from './risk-settings.js';

/**
 * Risk lists this browser subscribes to (doc 17 §4.4, §9): each a `colp.risklist/v1` address with a
 * record shaped like a rule-set subscription's — its policy always *Automatic*, never pinned — and one
 * content slot holding the index built when its version arrived. There is no previous version to go back
 * to; a failed refresh keeps the index in force, and how long ago the last one succeeded is what the
 * alerts call fresh, stale or out of date (R11). The order the Owner added them in is kept under
 * `known.risk.lists.v1`. Nothing here reaches the network or the bookmarks: fetching is the worker's
 * (sw/risk.ts), and nothing here can change where a page is filed (R17).
 */
export const RISK_LISTS_KEY = 'known.risk.lists.v1';
export const RISK_RECORD_PREFIX = 'known.risk.subscription.v1:';
export const RISK_CONTENT_PREFIX = 'known.risk.content.v1:';
export const RISK_LIST_LIMIT = 20;
export const riskKeys = (id: string) => ({ record: `${RISK_RECORD_PREFIX}${id}`, content: `${RISK_CONTENT_PREFIX}${id}` });
const HOUR = 60 * 60 * 1000, ETAG_LIMIT = 512, ID = /^[\w-]{1,128}$/u;

export interface RiskContent { readonly version: string; readonly digest: string; readonly fetchedAt: number; readonly index: RiskIndex }
export type RiskSubscribeResult = { readonly ok: true; readonly record: SubscriptionRecord } | { readonly ok: false; readonly error: 'limit' | 'duplicate' };
export type RiskSettingsPatch = Partial<Pick<SubscriptionRecord, 'refreshIntervalHours' | 'paused'>>;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** A risk list's record: a subscription record with one slot, applied by itself. */
export function parseRiskRecord(value: unknown): SubscriptionRecord | null {
  const parsed = parseSubscriptionRecord(value);
  return parsed && parsed.updatePolicy === 'auto' && !parsed.pinned && parsed.previousVersion === null && parsed.candidateVersion === null ? parsed : null;
}
export function parseRiskContent(value: unknown): RiskContent | null {
  if (!record(value) || Object.keys(value).length !== 4 || typeof value.version !== 'string' || value.version.length > 64
    || typeof value.digest !== 'string' || value.digest.length > 128 || typeof value.fetchedAt !== 'number' || !parseRiskIndex(value.index)) return null;
  return value as unknown as RiskContent;
}
const parseIds = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string' && ID.test(id)))].slice(0, RISK_LIST_LIMIT) : [];

/** The same list says the same thing: its checked entries, written in one order, hashed. */
async function digestOf(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** The `format` a file says it has, to tell a later format (`unsupported`) from a broken file (`invalid`). */
function formatOf(text: string): unknown {
  try { const value: unknown = JSON.parse(text); return record(value) ? value.format : undefined; } catch { return undefined; }
}

export function createRiskStore(area: SnapshotStateArea, options: { readonly id?: () => string } = {}) {
  const newId = options.id ?? (() => crypto.randomUUID());
  let lane: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = lane.then(work, work); lane = run.catch(() => undefined); return run;
  }
  /** Indexes already read, by list and version: a version names one content, so a check reads each once. */
  const indexes = new Map<string, RiskIndex>();
  const ids = async () => parseIds(await area.get(RISK_LISTS_KEY));
  const read = async (id: string) => parseRiskRecord(await area.get(riskKeys(id).record));
  async function all(): Promise<SubscriptionRecord[]> {
    const order = await ids(), values = await area.getMany(order.map((id) => riskKeys(id).record));
    return order.flatMap((id) => { const found = parseRiskRecord(values[riskKeys(id).record]); return found ? [found] : []; });
  }
  async function failed(attempted: SubscriptionRecord, code: FailureCode, now: number, status?: number): Promise<SubscriptionRecord> {
    const next = { ...attempted, lastFailure: { code, ...(status !== undefined ? { status } : {}), at: now } };
    await area.set(riskKeys(attempted.id).record, next);
    return next;
  }
  /** A fetched file replaces the one slot when it checks and is a new version; the same version with other entries is refused. */
  async function arrived(previous: SubscriptionRecord, text: string, etag: string | null, now: number): Promise<SubscriptionRecord> {
    const attempted = { ...previous, lastAttemptAt: now }, parsed = parseRiskList(text);
    if (!parsed.ok) {
      const code = parsed.problems.some((problem) => problem.code === 'tooLarge') ? 'tooLarge'
        : parsed.problems.some((problem) => problem.code === 'format') && String(formatOf(text)).startsWith('colp.risklist/') ? 'unsupported' : 'invalid';
      return failed(attempted, code, now);
    }
    const list = parsed.list, keys = riskKeys(previous.id), digest = await digestOf(list);
    const current = parseRiskContent(await area.get(keys.content));
    const succeeded: SubscriptionRecord = { ...attempted, lastSuccessAt: now, lastFailure: null, etag: etag !== null && etag.length <= ETAG_LIMIT ? etag : null };
    if (current?.digest === digest) { await area.set(keys.record, succeeded); return succeeded; }
    if (current?.version === list.version) return failed(attempted, 'invalid', now);
    const content: RiskContent = { version: list.version, digest, fetchedAt: now, index: buildRiskIndex(list) };
    const next: SubscriptionRecord = { ...succeeded, state: 'ready', currentVersion: list.version, documentId: list.id, name: list.name,
      publisher: list.publisher ?? null };
    await area.commit({ [keys.record]: next, [keys.content]: content });
    indexes.set(`${previous.id}\u0000${list.version}`, content.index);
    return next;
  }

  return {
    all,
    get: read,
    content: async (id: string) => parseRiskContent(await area.get(riskKeys(id).content)),
    settings: async (): Promise<RiskSettings> => parseRiskSettings(await area.get(RISK_SETTINGS_KEY)),
    setMode(mode: RiskMode): Promise<RiskSettings> {
      return exclusive(async () => {
        const next = { ...parseRiskSettings(await area.get(RISK_SETTINGS_KEY)), mode };
        await area.set(RISK_SETTINGS_KEY, next);
        return next;
      });
    },
    /** An exception kept always; the same host or domain again is the one already kept. */
    addException(scope: StoredRiskException['scope'], raw: string, now: number): Promise<StoredRiskException | 'invalid' | 'limit'> {
      return exclusive(async () => {
        const value = exceptionValue(scope, raw), settings = parseRiskSettings(await area.get(RISK_SETTINGS_KEY));
        if (!value) return 'invalid';
        const known = settings.exceptions.find((item) => item.scope === scope && item.value === value);
        if (known) return known;
        if (settings.exceptions.length >= RISK_EXCEPTION_LIMIT) return 'limit';
        const made: StoredRiskException = { id: newId(), scope, value, createdAt: now };
        await area.set(RISK_SETTINGS_KEY, { ...settings, exceptions: [...settings.exceptions, made] });
        return made;
      });
    },
    removeException(id: string): Promise<boolean> {
      return exclusive(async () => {
        const settings = parseRiskSettings(await area.get(RISK_SETTINGS_KEY));
        if (!settings.exceptions.some((item) => item.id === id)) return false;
        await area.set(RISK_SETTINGS_KEY, { ...settings, exceptions: settings.exceptions.filter((item) => item.id !== id) });
        return true;
      });
    },
    /** What a check reads: each list with a version, in the Owner's order, its index from storage once per version (RS-16.2). */
    async sources(): Promise<RiskSource[]> {
      const sources: RiskSource[] = [];
      for (const item of await all()) {
        if (item.state !== 'ready' || item.currentVersion === null) continue;
        const key = `${item.id}\u0000${item.currentVersion}`;
        let index = indexes.get(key);
        if (!index) {
          const content = parseRiskContent(await area.get(riskKeys(item.id).content));
          if (content?.version !== item.currentVersion) continue;
          index = content.index;
          for (const known of indexes.keys()) if (known.startsWith(`${item.id}\u0000`)) indexes.delete(known);
          indexes.set(key, index);
        }
        sources.push({ id: item.id, name: item.name, index, lastSuccessAt: item.lastSuccessAt });
      }
      return sources;
    },
    /** Subscribe: the record, last in the order, with nothing to check against until a version arrives. */
    create(input: { readonly url: string; readonly origin: string; readonly refreshIntervalHours: RefreshInterval }, now: number): Promise<RiskSubscribeResult> {
      return exclusive(async (): Promise<RiskSubscribeResult> => {
        const order = await ids(), existing = await all();
        if (existing.some((item) => item.url === input.url)) return { ok: false, error: 'duplicate' };
        if (order.length >= RISK_LIST_LIMIT) return { ok: false, error: 'limit' };
        const id = newId(), made = newSubscription(id, { ...input, updatePolicy: 'auto' }, now);
        await area.commit({ [RISK_LISTS_KEY]: [...order, id], [riskKeys(id).record]: made });
        return { ok: true, record: made };
      });
    },
    /** One fetch's result, recorded; null when the list was removed meanwhile. */
    settle(id: string, outcome: RefreshOutcome, now: number): Promise<SubscriptionRecord | null> {
      return exclusive(async () => {
        const previous = await read(id);
        if (!previous) return null;
        if (outcome.kind === 'failed') return failed({ ...previous, lastAttemptAt: now }, outcome.code, now, outcome.status);
        if (outcome.kind === 'fetched') return arrived(previous, outcome.text, outcome.etag, now);
        const unchanged = { ...previous, lastAttemptAt: now, lastSuccessAt: now, lastFailure: null };
        await area.set(riskKeys(id).record, unchanged);
        return unchanged;
      });
    },
    update(id: string, patch: RiskSettingsPatch): Promise<SubscriptionRecord | null> {
      return exclusive(async () => {
        const previous = await read(id);
        if (!previous || patch.refreshIntervalHours !== undefined && !REFRESH_INTERVALS.includes(patch.refreshIntervalHours)) return null;
        const next = { ...previous, ...patch };
        await area.set(riskKeys(id).record, next);
        return next;
      });
    },
    /** Remove: its record, its index and its place in the order, in one write. */
    remove(id: string): Promise<boolean> {
      return exclusive(async () => {
        const order = await ids();
        if (!order.includes(id)) return false;
        const keys = riskKeys(id);
        await area.commit({ [RISK_LISTS_KEY]: order.filter((item) => item !== id) }, [keys.record, keys.content]);
        for (const known of indexes.keys()) if (known.startsWith(`${id}\u0000`)) indexes.delete(known);
        return true;
      });
    },
    /** Those the hourly tick refreshes: not paused, interval passed, oldest attempt first. */
    async due(now: number, limit: number = REFRESH_PER_TICK): Promise<SubscriptionRecord[]> {
      return (await all()).filter((item) => !item.paused && (item.lastAttemptAt === null || item.lastAttemptAt + item.refreshIntervalHours * HOUR <= now))
        .sort((a, b) => (a.lastAttemptAt ?? -1) - (b.lastAttemptAt ?? -1)).slice(0, limit);
    },
  };
}
export type RiskStore = ReturnType<typeof createRiskStore>;
