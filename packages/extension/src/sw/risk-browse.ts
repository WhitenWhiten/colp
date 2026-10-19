import { normalizeHost } from '@know-n/colp/automation';
import { registrableDomain } from '../automation/public-suffix.js';
import { BADGE_WARNING } from '../badge-colors.js';
import { checkRisk } from '../risk/risk-check.js';
import { BROWSE_PERMISSIONS, type RiskMode } from '../risk/risk-settings.js';
import { onRiskMode, riskExceptions, riskStore } from './risk.js';

/**
 * Risk alerts while browsing (doc 17 §9, RS-16.3, RS-17.4, R12): with the mode *When I save and while I
 * browse*, each main-frame commit of a web page is checked against the stored indexes, and a match puts
 * "!" on the toolbar button for that tab; the popup there shows the notice. One alert per tab per
 * registrable domain, not again within 10 minutes in that tab unless what the lists call it changes;
 * the last alert of each tab is kept in `chrome.storage.session`. An expired entry or a list out of date
 * sets no badge (R11). Switching the mode away removes the listener and clears the badges. Nothing here
 * reads or writes bookmarks, rules or folders, and nothing is sent anywhere (RS-16.4, RS-17.5).
 */
export const RISK_RECENT_ALERTS_KEY = 'known.risk.recentAlerts';
export const ALERT_WINDOW_MS = 10 * 60_000;
export interface RecentAlert { readonly domain: string; readonly kind: string; readonly at: number }
type Recent = Readonly<Record<string, RecentAlert>>;

/** R12: alert unless this tab alerted for the same domain and the same kind less than 10 minutes ago. */
export const shouldAlert = (previous: RecentAlert | undefined, next: Pick<RecentAlert, 'domain' | 'kind'>, now: number): boolean =>
  !previous || previous.domain !== next.domain || previous.kind !== next.kind || now - previous.at >= ALERT_WINDOW_MS;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function parseRecent(value: unknown): Recent {
  if (!record(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([tab, item]) => /^\d{1,10}$/u.test(tab) && record(item) && typeof item.domain === 'string'
    && typeof item.kind === 'string' && typeof item.at === 'number')) as Recent;
}
async function readRecent(): Promise<Recent> {
  try { return parseRecent((await chrome.storage.session.get(RISK_RECENT_ALERTS_KEY))[RISK_RECENT_ALERTS_KEY]); } catch { return {}; }
}
/** One change to the recent alerts at a time, so two commits in a row read each other's write. */
let lane: Promise<unknown> = Promise.resolve();
function changeRecent<T>(change: (recent: Recent) => { readonly next: Recent | null; readonly result: T }): Promise<T> {
  const run = lane.then(async () => {
    const { next, result } = change(await readRecent());
    if (next) await chrome.storage.session.set({ [RISK_RECENT_ALERTS_KEY]: next });
    return result;
  });
  lane = run.catch(() => undefined);
  return run;
}

async function badge(tabId: number, on: boolean): Promise<void> {
  try {
    if (!on) { await chrome.action.setBadgeText({ tabId, text: null }); return; }
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_WARNING });
  } catch { /* The tab closed meanwhile; the popup says the same when opened. */ }
}

/** One main-frame commit: true when it put the badge on. */
export async function handleCommitted(details: chrome.webNavigation.CommitDetails, now = Date.now()): Promise<boolean> {
  if (details.frameId !== 0 || details.tabId < 0 || !/^https?:/u.test(details.url)) return false;
  const store = riskStore(), settings = await store.settings();
  if (settings.mode !== 'onSaveAndBrowse') return false;
  const matches = checkRisk(details.url, await store.sources(), { now, exceptions: [...settings.exceptions, ...await riskExceptions()] })
    .filter((match) => !match.expired && match.freshness !== 'outOfDate');
  let host: string | null = null;
  try { host = normalizeHost(new URL(details.url).hostname) ?? null; } catch { /* not checked above */ }
  if (!matches.length || !host) { await badge(details.tabId, false); return false; }
  const next = { domain: registrableDomain(host) ?? host, kind: [...new Set(matches.map((match) => match.kind))].sort().join(','), at: now };
  const alert = await changeRecent((recent) => shouldAlert(recent[details.tabId], next, now)
    ? { next: { ...recent, [details.tabId]: next }, result: true } : { next: null, result: false });
  await badge(details.tabId, alert);
  return alert;
}

const onCommitted = (details: chrome.webNavigation.CommitDetails) => { void handleCommitted(details).catch(() => false); };
const navigation = () => (chrome as { webNavigation?: typeof chrome.webNavigation }).webNavigation;

/** Listening follows the mode: on with *while I browse* and the permissions granted, otherwise off with every badge cleared. */
export async function applyBrowsing(mode: RiskMode): Promise<void> {
  const events = navigation()?.onCommitted;
  const browse = mode === 'onSaveAndBrowse' && Boolean(events) && await chrome.permissions.contains({ permissions: BROWSE_PERMISSIONS }).catch(() => false);
  if (browse) { if (!events!.hasListener(onCommitted)) events!.addListener(onCommitted); return; }
  events?.removeListener(onCommitted);
  const tabs = await changeRecent((recent) => ({ next: {}, result: Object.keys(recent) }));
  await Promise.all(tabs.map((tab) => badge(Number(tab), false)));
}

/**
 * At worker start, in the first turn: the listener goes on at once when the API is there, so a commit can
 * wake the worker, and comes off again when the mode says so. Taking the permission back turns browsing off.
 */
export function installRiskBrowsing(): void {
  navigation()?.onCommitted.addListener(onCommitted);
  onRiskMode(applyBrowsing);
  void riskStore().settings().then((settings) => applyBrowsing(settings.mode)).catch(() => undefined);
  chrome.tabs.onRemoved.addListener((tabId) => {
    void changeRecent((recent) => {
      if (!(tabId in recent)) return { next: null, result: undefined };
      const { [tabId]: _gone, ...rest } = recent;
      return { next: rest, result: undefined };
    }).catch(() => undefined);
  });
  chrome.permissions.onRemoved.addListener((removed) => {
    if (!removed.permissions?.some((permission) => BROWSE_PERMISSIONS.includes(permission))) return;
    void riskStore().settings().then(async (settings) => {
      if (settings.mode !== 'onSaveAndBrowse') return;
      await riskStore().setMode('onSave');
      await applyBrowsing('onSave');
    }).catch(() => undefined);
  });
}
