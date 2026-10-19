import { automationDatabase, type AutomationDatabase } from '../automation/indexeddb-store.js';
import { fetchSubscription, subscriptionAddress, subscriptionOriginPattern, type FetchPorts } from '../automation/subscription-fetch.js';
import type { SubscriptionRecord } from '../automation/subscription-store.js';
import { checkRisk, freshness } from '../risk/risk-check.js';
import type { RiskCommand, RiskListView, RiskResponse } from '../risk/risk-messages.js';
import { parseSessionExceptions, RISK_SESSION_EXCEPTIONS_KEY } from '../risk/risk-settings.js';
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

export const riskListView = (record: SubscriptionRecord, now = Date.now()): RiskListView => ({ id: record.id, url: record.url, origin: record.origin,
  name: record.name, publisher: record.publisher, state: record.state, refreshIntervalHours: record.refreshIntervalHours, paused: record.paused,
  currentVersion: record.currentVersion, lastAttemptAt: record.lastAttemptAt, lastSuccessAt: record.lastSuccessAt, lastFailure: record.lastFailure,
  freshness: record.state === 'ready' ? freshness(record.lastSuccessAt, now) : null });

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

/** The hourly tick: those due, one after another. */
export async function refreshDueRiskLists(now = Date.now()): Promise<readonly string[]> {
  const due = await riskStore().due(now);
  for (const record of due) await refreshRiskList(record.id).catch(() => null);
  return due.map((record) => record.id);
}

async function sessionExceptions() {
  try { return parseSessionExceptions((await chrome.storage.session.get(RISK_SESSION_EXCEPTIONS_KEY))[RISK_SESSION_EXCEPTIONS_KEY]); } catch { return []; }
}

export async function handleRiskCommand(command: RiskCommand): Promise<RiskResponse> {
  const store = riskStore();
  if (command.kind === 'known.risk.check') {
    const settings = await store.settings();
    if (settings.mode === 'off') return { ok: true, check: { mode: 'off', matches: [] } };
    const exceptions = [...settings.exceptions, ...await sessionExceptions()];
    return { ok: true, check: { mode: settings.mode, matches: checkRisk(command.url, await store.sources(), { now: Date.now(), exceptions }) } };
  }
  if (command.kind === 'known.risk.remove') return await store.remove(command.id) ? { ok: true } : { ok: false, error: 'notFound' };
  if (command.kind === 'known.risk.refresh') {
    const record = await refreshRiskList(command.id);
    return record ? { ok: true, list: riskListView(record) } : { ok: false, error: 'notFound' };
  }
  const address = subscriptionAddress(command.url);
  if (!address.ok) return { ok: false, error: 'unsupported' };
  const made = await store.create({ url: address.url, origin: address.origin, refreshIntervalHours: command.refreshIntervalHours }, Date.now());
  if (!made.ok) return made;
  // The first fetch: when it fails the list stays, not ready, with the failure and Retry (RS-13.2).
  return { ok: true, list: riskListView(await refreshRiskList(made.record.id).catch(() => null) ?? made.record) };
}
