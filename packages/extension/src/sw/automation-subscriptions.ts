import type { BrowserRuleResponse } from '../automation/messages.js';
import { parseRuleset } from '../automation/ruleset-format.js';
import { fetchSubscription, subscriptionAddress, subscriptionOriginPattern, type FetchPorts } from '../automation/subscription-fetch.js';
import type { BrowserSubscriptionView, SubscriptionCommand } from '../automation/subscription-messages.js';
import { automationDatabase, type AutomationDatabase } from '../automation/indexeddb-store.js';
import { contentRuleset, createSubscriptionStore, type SubscriptionRecord, type SubscriptionStore } from '../automation/subscription-store.js';
import { browserRuleStore } from './automation-browser.js';
import { ownFolder } from './automation-config.js';
import { rulesetView, rulesetSample } from './automation-ruleset.js';
import { ensurePeriodicAlarm } from './reconcile-alarm.js';
import { hasBookmarkPermission } from './runtime.js';

/**
 * Rule-set subscriptions in the worker (doc 17 §8, RS-04, RS-13): Options' commands, and the hourly
 * alarm that refreshes up to three whose interval has passed. It runs only while the browser does;
 * a save never waits for it (RS-19.2), and a failure keeps the version in force.
 */
export const RULE_SUBSCRIPTION_ALARM = 'known.automation.subscriptionRefresh';
export const RULE_SUBSCRIPTION_MINUTES = 60;

let shared: { readonly database: AutomationDatabase; readonly store: SubscriptionStore } | undefined;
/** One store per database, writing the list through the list's own queue. */
export function ruleSubscriptionStore(): SubscriptionStore {
  const database = automationDatabase();
  if (shared?.database !== database) shared = { database, store: createSubscriptionStore(database.area(), browserRuleStore()) };
  return shared.store;
}
const ports: FetchPorts = {
  fetch: (input, init) => fetch(input, init),
  granted: (origin) => chrome.permissions.contains({ origins: [subscriptionOriginPattern(origin)] }),
};

export function installRuleSubscriptions(): void {
  void ensurePeriodicAlarm(chrome, RULE_SUBSCRIPTION_ALARM, RULE_SUBSCRIPTION_MINUTES);
}

const inFlight = new Map<string, Promise<SubscriptionRecord | null>>();
/** One fetch per subscription at a time; a second ask while one runs gets its answer. */
export function refreshSubscription(id: string): Promise<SubscriptionRecord | null> {
  const running = inFlight.get(id);
  if (running) return running;
  const work = (async () => {
    const store = ruleSubscriptionStore(), record = await store.get(id);
    if (!record) return null;
    const outcome = await fetchSubscription({ url: record.url, origin: record.origin, etag: record.etag }, ports);
    return store.settle(id, outcome, Date.now());
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, work);
  return work;
}

/** The alarm's tick: those due, one after another. */
export async function refreshDueSubscriptions(now = Date.now()): Promise<readonly string[]> {
  const due = await ruleSubscriptionStore().due(now);
  for (const record of due) await refreshSubscription(record.id).catch(() => null);
  return due.map((record) => record.id);
}

export async function subscriptionView(record: SubscriptionRecord): Promise<BrowserSubscriptionView> {
  const current = record.state === 'ready' ? await ruleSubscriptionStore().content(record.id, 'current') : null;
  const ruleset = current ? contentRuleset(current)?.ruleset ?? null : null;
  return { id: record.id, url: record.url, origin: record.origin, name: record.name, publisher: record.publisher, license: ruleset?.license ?? null,
    state: record.state, updatePolicy: record.updatePolicy, refreshIntervalHours: record.refreshIntervalHours, paused: record.paused, pinned: record.pinned,
    currentVersion: record.currentVersion, previousVersion: record.previousVersion, candidateVersion: record.candidateVersion,
    fetchedAt: current?.fetchedAt ?? null, lastAttemptAt: record.lastAttemptAt, lastSuccessAt: record.lastSuccessAt, lastFailure: record.lastFailure };
}
const viewed = async (record: SubscriptionRecord | null): Promise<BrowserRuleResponse> =>
  record ? { ok: true, subscription: await subscriptionView(record) } : { ok: false, error: 'notFound' };

export async function handleSubscriptionCommand(command: SubscriptionCommand): Promise<BrowserRuleResponse> {
  const store = ruleSubscriptionStore();
  if (command.kind === 'known.automation.browser.subscription.update') {
    const { kind: _kind, id, ...patch } = command;
    return viewed(await store.update(id, patch));
  }
  if (command.kind === 'known.automation.browser.subscription.refresh') return viewed(await refreshSubscription(command.id));
  if (command.kind === 'known.automation.browser.subscription.remove') return store.remove(command.id);
  const address = subscriptionAddress(command.url);
  if (!address.ok) return { ok: false, error: 'unsupported' };
  if (command.kind === 'known.automation.browser.subscription.check') {
    const outcome = await fetchSubscription({ ...address, etag: null }, ports);
    if (outcome.kind === 'failed') return { ok: false, error: outcome.code, ...(outcome.status !== undefined ? { status: outcome.status } : {}) };
    if (outcome.kind === 'notModified') return { ok: false, error: 'http', status: 304 };
    const parsed = parseRuleset(outcome.text);
    if (!parsed.ok) return { ok: false, error: 'invalid', rulesetProblems: parsed.problems };
    return { ok: true, ruleset: rulesetView(parsed, await hasBookmarkPermission() ? await rulesetSample(parsed.compiled) : null) };
  }
  const bindings: Record<string, string> = {};
  for (const [role, folder] of Object.entries(command.bindings)) {
    if (folder === null) continue;
    if (!await hasBookmarkPermission()) return { ok: false, error: 'noAccess' };
    if (!await ownFolder(folder)) return { ok: false, error: 'folderGone' };
    bindings[role] = folder;
  }
  const made = await store.create({ url: address.url, origin: address.origin, updatePolicy: command.updatePolicy,
    refreshIntervalHours: command.refreshIntervalHours, bindings }, Date.now());
  if (!made.ok) return made;
  // The first fetch: when it fails the subscription stays, not ready, with the failure and Retry (RS-13.2).
  return viewed(await refreshSubscription(made.record.id).catch(() => null) ?? made.record);
}
