import type { BrowserRuleResponse } from '../automation/messages.js';
import { parseRuleset } from '../automation/ruleset-format.js';
import { fetchSubscription, subscriptionAddress, subscriptionOriginPattern, type FetchPorts } from '../automation/subscription-fetch.js';
import type { BrowserSubscriptionView, SubscriptionCommand } from '../automation/subscription-messages.js';
import { subscriptionRecordView } from '../automation/subscription-list.js';
import type { SubscriptionRecord, SubscriptionStore } from '../automation/subscription-store.js';
import { browserSubscriptionStore } from './automation-browser.js';
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

/** One store per database, writing the list through the list's own queue (automation-browser.ts). */
export const ruleSubscriptionStore = (): SubscriptionStore => browserSubscriptionStore();
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
  const source = await ruleSubscriptionStore().source(record.id);
  return subscriptionRecordView(source ?? { record, current: null, fetchedAt: null, local: { disabledEntryIds: [], exceptions: [], bindings: {} } });
}
const viewed = async (record: SubscriptionRecord | null): Promise<BrowserRuleResponse> =>
  record ? { ok: true, subscription: await subscriptionView(record) } : { ok: false, error: 'notFound' };

/** Folders the Owner chose for roles: each must be a folder of theirs here. */
async function chosenFolders(bindings: Readonly<Record<string, string | null>>): Promise<Record<string, string> | 'noAccess' | 'folderGone'> {
  const chosen: Record<string, string> = {};
  for (const [role, folder] of Object.entries(bindings)) {
    if (folder === null) continue;
    if (!await hasBookmarkPermission()) return 'noAccess';
    if (!await ownFolder(folder)) return 'folderGone';
    chosen[role] = folder;
  }
  return chosen;
}

export async function handleSubscriptionCommand(command: SubscriptionCommand): Promise<BrowserRuleResponse> {
  const store = ruleSubscriptionStore();
  if (command.kind === 'known.automation.browser.subscription.update') {
    const { kind: _kind, id, ...patch } = command;
    return viewed(await store.update(id, patch));
  }
  if (command.kind === 'known.automation.browser.subscription.refresh') return viewed(await refreshSubscription(command.id));
  if (command.kind === 'known.automation.browser.subscription.remove') return store.remove(command.id);
  if (command.kind === 'known.automation.browser.subscription.adjust') {
    if (command.change.kind === 'bindings') {
      const chosen = await chosenFolders(command.change.bindings);
      if (typeof chosen === 'string') return { ok: false, error: chosen };
    }
    return store.adjust(command.id, command.change, Date.now());
  }
  if (command.kind === 'known.automation.browser.subscription.copy') {
    const result = await store.copyEntry(command.id, command.entryId, command.disableOriginal, Date.now());
    return result.ok ? { ok: true, rule: result.rule } : { ok: false, error: result.error };
  }
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
  const bindings = await chosenFolders(command.bindings);
  if (typeof bindings === 'string') return { ok: false, error: bindings };
  const made = await store.create({ url: address.url, origin: address.origin, updatePolicy: command.updatePolicy,
    refreshIntervalHours: command.refreshIntervalHours, bindings }, Date.now());
  if (!made.ok) return made;
  // The first fetch: when it fails the subscription stays, not ready, with the failure and Retry (RS-13.2).
  return viewed(await refreshSubscription(made.record.id).catch(() => null) ?? made.record);
}
