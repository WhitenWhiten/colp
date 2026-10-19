import { normalizeHost } from '@know-n/colp/automation';
import { automationDatabase, type AutomationDatabase } from '../automation/indexeddb-store.js';
import { registrableDomain } from '../automation/public-suffix.js';
import { fetchSubscription, subscriptionAddress, subscriptionOriginPattern, type FetchPorts } from '../automation/subscription-fetch.js';
import type { ConfigRisk } from '../automation/rules-config-format.js';
import type { SubscriptionRecord } from '../automation/subscription-store.js';
import { checkRisk, freshness } from '../risk/risk-check.js';
import type { RiskIndex } from '../risk/risk-index.js';
import type { RiskCheckView, RiskCommand, RiskExceptionView, RiskListView, RiskResponse } from '../risk/risk-messages.js';
import { BROWSE_PERMISSIONS, exceptionValue, parseSessionExceptions, RISK_EXCEPTION_LIMIT, RISK_SESSION_EXCEPTIONS_KEY, type RiskMode,
  type StoredRiskException } from '../risk/risk-settings.js';
import { createRiskStore, type RiskStore } from '../risk/risk-store.js';
import { RISKLIST_MAX_BYTES } from '../risk/risklist-format.js';

/**
 * Risk lists in the worker (doc 17 §9, RS-16 – RS-18): Options' commands, the popup's check, and the
 * refresh of lists whose interval has passed on the rule subscriptions' hourly alarm. A list is fetched
 * the way a rule set is (subscription-fetch.ts, R14) — a plain GET of its address and nothing about the
 * Owner — through a 4 MB cap. A check reads only the stored indexes; it touches no bookmark, no rule and
 * no folder (RS-17.5, R17).
 */
let shared: { readonly database: AutomationDatabase; readonly store: RiskStore } | undefined;
/** One store per database, so a check reads each list's index once per version. */
export function riskStore(): RiskStore {
  const database = automationDatabase();
  if (shared?.database !== database) shared = { database, store: createRiskStore(database.area()) };
  return shared.store;
}
const ports: FetchPorts = {
  fetch: (input, init) => fetch(input, init),
  granted: (origin) => chrome.permissions.contains({ origins: [subscriptionOriginPattern(origin)] }),
  maxBytes: RISKLIST_MAX_BYTES,
};

const size = (index: RiskIndex) => Object.keys(index.hosts).length + Object.keys(index.domains).length
  + Object.values(index.prefixes).reduce((sum, filed) => sum + filed.length, 0);
export const riskListView = (record: SubscriptionRecord, index: RiskIndex | null = null, now = Date.now()): RiskListView => ({ id: record.id, url: record.url,
  origin: record.origin, name: record.name, publisher: record.publisher, state: record.state, refreshIntervalHours: record.refreshIntervalHours,
  paused: record.paused, currentVersion: record.currentVersion, lastAttemptAt: record.lastAttemptAt, lastSuccessAt: record.lastSuccessAt,
  lastFailure: record.lastFailure, freshness: record.state === 'ready' ? freshness(record.lastSuccessAt, now) : null, entries: index ? size(index) : null });
/** A list's view with its entry count, read from its index. */
async function listView(record: SubscriptionRecord): Promise<RiskListView> {
  const source = (await riskStore().sources()).find((item) => item.id === record.id);
  return riskListView(record, source?.index ?? null);
}

const inFlight = new Map<string, Promise<SubscriptionRecord | null>>();
/** One fetch per list at a time; a second ask while one runs gets its answer. */
export function refreshRiskList(id: string): Promise<SubscriptionRecord | null> {
  const running = inFlight.get(id);
  if (running) return running;
  const work = (async () => {
    const store = riskStore(), record = await store.get(id);
    if (!record) return null;
    const outcome = await fetchSubscription({ url: record.url, origin: record.origin, etag: record.etag }, ports);
    return store.settle(id, outcome, Date.now());
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, work);
  return work;
}

/** The hourly tick: those due, one after another, while alerts are on. */
export async function refreshDueRiskLists(now = Date.now()): Promise<readonly string[]> {
  // Off, no list is fetched by itself (RS-16.1); Refresh now still is.
  if ((await riskStore().settings()).mode === 'off') return [];
  const due = await riskStore().due(now);
  for (const record of due) await refreshRiskList(record.id).catch(() => null);
  return due.map((record) => record.id);
}

/** This session's exceptions (R12). */
export const riskExceptions = (): Promise<StoredRiskException[]> => sessionExceptions();
async function sessionExceptions(): Promise<StoredRiskException[]> {
  try { return parseSessionExceptions((await chrome.storage.session.get(RISK_SESSION_EXCEPTIONS_KEY))[RISK_SESSION_EXCEPTIONS_KEY]); } catch { return []; }
}
function siteOf(url: string): RiskCheckView['site'] {
  try { const host = normalizeHost(new URL(url).hostname); return host ? { host, domain: registrableDomain(host) } : null; } catch { return null; }
}
let modeListener: ((mode: RiskMode) => Promise<void>) | null = null;
/** Browsing alerts (risk-browse.ts) follow the mode as it changes. */
export function onRiskMode(listener: (mode: RiskMode) => Promise<void>): void { modeListener = listener; }
const exceptionView = (item: StoredRiskException, duration: RiskExceptionView['duration']): RiskExceptionView =>
  ({ id: item.id, scope: item.scope, value: item.value, duration, createdAt: item.createdAt });

/** This session's exception list, changed one at a time; it ends with the browser (R12). */
let sessionLane: Promise<unknown> = Promise.resolve();
function changeSession<T>(change: (items: StoredRiskException[]) => { readonly items: StoredRiskException[] | null; readonly result: T }): Promise<T> {
  const run = sessionLane.then(async () => {
    const { items, result } = change(await sessionExceptions());
    if (items) await chrome.storage.session.set({ [RISK_SESSION_EXCEPTIONS_KEY]: items });
    return result;
  });
  sessionLane = run.catch(() => undefined);
  return run;
}

async function exceptionCommand(command: Extract<RiskCommand, { kind: 'known.risk.exception.add' | 'known.risk.exception.remove' }>): Promise<RiskResponse> {
  const store = riskStore();
  if (command.kind === 'known.risk.exception.remove') {
    if (await store.removeException(command.id)) return { ok: true };
    const removed = await changeSession((items) => items.some((item) => item.id === command.id)
      ? { items: items.filter((item) => item.id !== command.id), result: true } : { items: null, result: false });
    return removed ? { ok: true } : { ok: false, error: 'notFound' };
  }
  if (command.duration === 'always') {
    const made = await store.addException(command.scope, command.value, Date.now());
    return typeof made === 'string' ? { ok: false, error: made } : { ok: true, exception: exceptionView(made, 'always') };
  }
  const value = exceptionValue(command.scope, command.value);
  if (!value) return { ok: false, error: 'invalid' };
  return changeSession((items): { items: StoredRiskException[] | null; result: RiskResponse } => {
    const known = items.find((item) => item.scope === command.scope && item.value === value);
    if (known) return { items: null, result: { ok: true, exception: exceptionView(known, 'session') } };
    if (items.length >= RISK_EXCEPTION_LIMIT) return { items: null, result: { ok: false, error: 'limit' } };
    const made: StoredRiskException = { id: crypto.randomUUID(), scope: command.scope, value, createdAt: Date.now() };
    return { items: [...items, made], result: { ok: true, exception: exceptionView(made, 'session') } };
  });
}

export async function handleRiskCommand(command: RiskCommand): Promise<RiskResponse> {
  const store = riskStore();
  if (command.kind === 'known.risk.check') {
    const settings = await store.settings();
    if (settings.mode === 'off') return { ok: true, check: { mode: 'off', matches: [], site: null } };
    const exceptions = [...settings.exceptions, ...await sessionExceptions()];
    const matches = checkRisk(command.url, await store.sources(), { now: Date.now(), exceptions });
    return { ok: true, check: { mode: settings.mode, matches, site: matches.length ? siteOf(command.url) : null } };
  }
  if (command.kind === 'known.risk.state') {
    const [settings, records, sources, session] = await Promise.all([store.settings(), store.all(), store.sources(), sessionExceptions()]);
    const indexes = new Map(sources.map((source) => [source.id, source.index]));
    return { ok: true, state: { mode: settings.mode, lists: records.map((record) => riskListView(record, indexes.get(record.id) ?? null)),
      exceptions: [...settings.exceptions.map((item) => exceptionView(item, 'always')), ...session.map((item) => exceptionView(item, 'session'))] } };
  }
  if (command.kind === 'known.risk.mode') {
    // While browsing needs both permissions, asked for in Options' click (RS-16.3).
    if (command.mode === 'onSaveAndBrowse' && !await chrome.permissions.contains({ permissions: BROWSE_PERMISSIONS }).catch(() => false)) {
      return { ok: false, error: 'permission' };
    }
    await store.setMode(command.mode);
    await modeListener?.(command.mode);
    return { ok: true };
  }
  if (command.kind === 'known.risk.exception.add' || command.kind === 'known.risk.exception.remove') return exceptionCommand(command);
  if (command.kind === 'known.risk.remove') return await store.remove(command.id) ? { ok: true } : { ok: false, error: 'notFound' };
  if (command.kind === 'known.risk.refresh') {
    const record = await refreshRiskList(command.id);
    return record ? { ok: true, list: await listView(record) } : { ok: false, error: 'notFound' };
  }
  const address = subscriptionAddress(command.url);
  if (!address.ok) return { ok: false, error: 'unsupported' };
  const made = await store.create({ url: address.url, origin: address.origin, refreshIntervalHours: command.refreshIntervalHours }, Date.now());
  if (!made.ok) return made;
  // The first fetch: when it fails the list stays, not ready, with the failure and Retry (RS-13.2).
  return { ok: true, list: await listView(await refreshRiskList(made.record.id).catch(() => null) ?? made.record) };
}

/**
 * A rules file's risk alerts (doc 17 §5.3): its lists added, not ready until fetched once their sites are
 * allowed here; its exceptions added beside these; its mode taken, but *while browsing* only with the
 * permissions already granted here (otherwise on for saves). Returns how many lists it added.
 */
export async function importRiskConfig(risk: ConfigRisk, now = Date.now()): Promise<number> {
  const store = riskStore();
  let added = 0;
  for (const item of risk.lists) {
    const address = subscriptionAddress(item.url);
    if (!address.ok) continue;
    const made = await store.create({ url: address.url, origin: address.origin, refreshIntervalHours: item.refreshIntervalHours }, now);
    if (!made.ok) continue;
    added += 1;
    if (item.paused) await store.update(made.record.id, { paused: true });
  }
  for (const exception of risk.exceptions) await store.addException(exception.scope, exception.value, now);
  const browse = risk.mode === 'onSaveAndBrowse' && await chrome.permissions.contains({ permissions: BROWSE_PERMISSIONS }).catch(() => false);
  const mode: RiskMode = risk.mode === 'onSaveAndBrowse' && !browse ? 'onSave' : risk.mode;
  await store.setMode(mode);
  await modeListener?.(mode);
  return added;
}

/** What a rules file keeps of risk alerts: no session exceptions, no list content. */
export async function exportRiskConfig(): Promise<ConfigRisk> {
  const store = riskStore(), [settings, records] = await Promise.all([store.settings(), store.all()]);
  return { mode: settings.mode, exceptions: settings.exceptions.map(({ scope, value }) => ({ scope, value })),
    lists: records.map((record) => ({ url: record.url, refreshIntervalHours: record.refreshIntervalHours, paused: record.paused })) };
}
