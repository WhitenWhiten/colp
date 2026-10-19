import { normalizeHost } from '@know-n/colp/automation';
import { record } from '../automation/closed-value.js';
import { createLane } from '../automation/lane.js';
import { registrableDomain } from '../automation/public-suffix.js';
import { BADGE_WARNING } from '../badge-colors.js';
import { checkRisk } from '../risk/risk-check.js';
import { BROWSE_PERMISSIONS, type RiskMode } from '../risk/risk-settings.js';
import { onRiskMode, riskExceptions, riskStore } from './risk.js';

/**
 * Risk alerts while browsing (doc 17 §9, RS-16.3, RS-17.4, R12): with the mode *When I save and while I
 * browse*, each main-frame commit of a web page is checked against the stored indexes. The badge follows
 * the tab: "!" on the toolbar button while the page it shows is listed, gone when the tab moves to a page
 * that is not, back when it returns to one that is; the popup there shows the notice. A badge is held,
 * not repeated, so R12's rate limit has nothing to limit here; what each tab's badge says (its domain and
 * what the lists call it) is kept in `chrome.storage.session` so a closed tab or a mode change can clear
 * it. An expired entry or a list out of date sets no badge (R11). Switching the mode away removes the
 * listener and clears the badges. Nothing here reads or writes bookmarks, rules or folders, and nothing
 * is sent anywhere (RS-16.4, RS-17.5).
 */
export const RISK_RECENT_ALERTS_KEY = 'known.risk.recentAlerts';
export interface RecentAlert { readonly domain: string; readonly kind: string; readonly at: number }
type Recent = Readonly<Record<string, RecentAlert>>;

function parseRecent(value: unknown): Recent {
  if (!record(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([tab, item]) => /^\d{1,10}$/u.test(tab) && record(item) && typeof item.domain === 'string'
    && typeof item.kind === 'string' && typeof item.at === 'number')) as Recent;
}
async function readRecent(): Promise<Recent> {
  try { return parseRecent((await chrome.storage.session.get(RISK_RECENT_ALERTS_KEY))[RISK_RECENT_ALERTS_KEY]); } catch { return {}; }
}
/** One change to the tabs' badges at a time, so two commits in a row read each other's write. */
const exclusive = createLane();
const navigations = new Map<number, symbol>();
function changeRecent<T>(change: (recent: Recent) => { readonly next: Recent | null; readonly result: T }): Promise<T> {
  return exclusive(async () => {
    const { next, result } = change(await readRecent());
    if (next) await chrome.storage.session.set({ [RISK_RECENT_ALERTS_KEY]: next });
    return result;
  });
}
/** A tab's badge no longer says anything. */
const forget = (recent: Recent, tabId: number): Recent | null => {
  if (!(String(tabId) in recent)) return null;
  const { [tabId]: _gone, ...rest } = recent;
  return rest;
};

async function badge(tabId: number, on: boolean): Promise<void> {
  try {
    if (!on) { await chrome.action.setBadgeText({ tabId, text: null }); return; }
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_WARNING });
  } catch { /* The tab closed meanwhile; the popup says the same when opened. */ }
}

/** One main-frame commit: true when the tab now shows the badge. */
export async function handleCommitted(details: chrome.webNavigation.CommitDetails, now = Date.now()): Promise<boolean> {
  if (details.frameId !== 0 || details.tabId < 0) return false;
  const token = Symbol();
  navigations.set(details.tabId, token);
  const current = () => navigations.get(details.tabId) === token;
  const store = riskStore(), settings = await store.settings();
  if (settings.mode !== 'onSaveAndBrowse' || !current()) return false;
  const matches = /^https?:/u.test(details.url)
    ? checkRisk(details.url, await store.sources(), { now, exceptions: [...settings.exceptions, ...await riskExceptions()] })
      .filter((match) => !match.expired && match.freshness !== 'outOfDate') : [];
  let host: string | null = null;
  try { host = normalizeHost(new URL(details.url).hostname) ?? null; } catch { /* non-web page */ }
  const next: RecentAlert | null = matches.length && host ? { domain: registrableDomain(host) ?? host,
    kind: [...new Set(matches.map((match) => match.kind))].sort().join(','), at: now } : null;
  // Serialize publication, including the badge call, and discard superseded reads.
  return exclusive(async () => {
    const recent = await readRecent();
    if (!current()) return false;
    const changed = next ? { ...recent, [details.tabId]: next } : forget(recent, details.tabId);
    if (changed) await chrome.storage.session.set({ [RISK_RECENT_ALERTS_KEY]: changed });
    if (!current()) return false;
    if (next || changed) await badge(details.tabId, next !== null);
    return next !== null;
  });
}

const onCommitted = (details: chrome.webNavigation.CommitDetails) => { void handleCommitted(details).catch(() => false); };
const navigation = () => (chrome as { webNavigation?: typeof chrome.webNavigation }).webNavigation;

/** Listening follows the mode: on with *while I browse* and the permissions granted, otherwise off with every badge cleared. */
export async function applyBrowsing(mode: RiskMode): Promise<void> {
  if (mode !== 'onSaveAndBrowse') navigations.clear();
  const events = navigation()?.onCommitted;
  const browse = mode === 'onSaveAndBrowse' && Boolean(events) && await chrome.permissions.contains({ permissions: BROWSE_PERMISSIONS }).catch(() => false);
  if (browse) { if (!events!.hasListener(onCommitted)) events!.addListener(onCommitted); return; }
  navigations.clear();
  events?.removeListener(onCommitted);
  await exclusive(async () => {
    const tabs = Object.keys(await readRecent());
    await chrome.storage.session.set({ [RISK_RECENT_ALERTS_KEY]: {} });
    await Promise.all(tabs.map((tab) => badge(Number(tab), false)));
  });
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
    navigations.delete(tabId);
    void changeRecent((recent) => ({ next: forget(recent, tabId), result: undefined })).catch(() => undefined);
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
