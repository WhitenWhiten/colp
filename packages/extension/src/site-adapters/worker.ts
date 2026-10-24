import { BILIBILI } from './bilibili/identity.js';
import { initialTransportState, createSiteTransport, SITE_PORT, SITE_STATE_KEY, type SiteSender, type TransportState } from './transport.js';
import { object, literal, str } from './schema.js';
import { validAdapterMessage } from './schemas.js';
const grants = { permissions: ['scripting', 'webNavigation'], origins: [...BILIBILI.matches] };
let storageReady: Promise<void> | undefined;
function trustedStorage(): Promise<void> {
  return storageReady ??= (async () => {
    for (const area of [chrome.storage.local, chrome.storage.session, chrome.storage.managed]) {
      if (!area.setAccessLevel) throw new Error('storageBoundaryUnavailable');
      await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
  })().catch(e => { storageReady = undefined; throw e; });
}
const read = async () => { await trustedStorage(); const raw = (await chrome.storage.local.get(SITE_STATE_KEY))[SITE_STATE_KEY];
  if (raw && (raw as { version?: number }).version !== 1) throw new Error('schemaIncompatible');
  return (raw as TransportState | undefined) ?? initialTransportState(); };
export const siteTransport = createSiteTransport({ extensionId: chrome.runtime.id, now: Date.now, random: () => crypto.randomUUID(), read,
  write: s => chrome.storage.local.set({ [SITE_STATE_KEY]: s }), permitted: () => chrome.permissions.contains(grants),
  current: async s => {
    if (s.tab?.id === undefined) return null;
    const frame = await chrome.webNavigation.getFrame({ tabId: s.tab.id, frameId: 0 }).catch(() => null);
    return frame && frame.documentId === s.documentId && new URL(frame.url).origin === BILIBILI.origin && frame.documentLifecycle === 'active' ? frame.url : null;
  } });
const ports = new Map<string, chrome.runtime.Port>();
function disconnectAll() { for (const p of ports.values()) { try { p.disconnect(); } catch { /* gone */ } } ports.clear(); }
function management(sender: SiteSender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try { const u = new URL(sender.url); return u.protocol === 'chrome-extension:' && u.hostname === chrome.runtime.id
    && ['/site-adapters.html', '/options.html'].includes(u.pathname); } catch { return false; }
}
async function injectOpen() {
  for (const tab of await chrome.tabs.query({ url: [...BILIBILI.matches] })) {
    if (tab.id === undefined || tab.incognito) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['site-probe.js'] }).catch(() => undefined);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['site-adapter.js'] }).catch(() => undefined);
  }
}
async function reconcile() {
  const s = await read(), granted = await chrome.permissions.contains(grants);
  if (!s.enabled || !granted) {
    await chrome.scripting?.unregisterContentScripts({ ids: ['known-site-probe', 'known-site-adapter'] }).catch(() => undefined); return;
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['known-site-probe', 'known-site-adapter'] });
  const definitions: chrome.scripting.RegisteredContentScript[] = [
    { id: 'known-site-probe', js: ['site-probe.js'], matches: [...BILIBILI.matches], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true },
    { id: 'known-site-adapter', js: ['site-adapter.js'], matches: [...BILIBILI.matches], runAt: 'document_start', world: 'ISOLATED', allFrames: false, persistAcrossSessions: true },
  ];
  const missing = definitions.filter(d => !existing.some(e => e.id === d.id));
  if (missing.length) await chrome.scripting.registerContentScripts(missing);
}
const statusSchema = object({ kind: literal('known.siteAdapters.status') });
const enableSchema = object({ kind: literal('known.siteAdapters.enable'), enabled: literal(true, false) });
const confirmSchema = object({ kind: literal('known.siteAdapters.confirm'), accountId: str(128) });
export function installSiteAdapters() {
  // Registered synchronously; initialization is awaited inside each handler.
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const d = raw as { kind?: string; request?: unknown; enabled?: boolean; accountId?: string } | null;
    if (d?.kind === 'known.siteAdapters.bootstrap') {
      if (!object({ kind: literal('known.siteAdapters.bootstrap'), request: () => true })(raw)) return false;
      void siteTransport.bootstrap(d.request, sender).then(respond, () => respond({ status: 'unavailable', reason: 'disabled' })); return true;
    }
    if (!management(sender) || !(statusSchema(raw) || enableSchema(raw) || confirmSchema(raw))) return false;
    void (async () => {
      if (enableSchema(raw)) {
        if (d!.enabled && !await chrome.permissions.contains(grants)) throw new Error('permissionRequired');
        await siteTransport.configure(d!.enabled!); disconnectAll(); await reconcile(); if (d!.enabled) await injectOpen();
      }
      if (confirmSchema(raw)) { await siteTransport.confirm(d!.accountId!); disconnectAll(); await injectOpen(); }
      return siteTransport.status();
    })().then(respond, e => respond({ error: e instanceof Error ? e.message : 'unavailable' })); return true;
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== SITE_PORT || !port.sender) return;
    let leaseId: string | null = null, closed = false, busy = false;
    const close = () => { closed = true; if (leaseId && ports.get(leaseId) === port) { ports.delete(leaseId); void siteTransport.retire(leaseId).catch(() => undefined); } };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(raw => {
      if (closed || busy || !validAdapterMessage(raw)) { port.disconnect(); close(); return; }
      busy = true;
      void (async () => {
        const lease = await siteTransport.authorize(raw, port.sender!);
        if (!lease || (leaseId && leaseId !== lease.id)) { port.disconnect(); close(); return; }
        leaseId = lease.id;
        const old = ports.get(lease.id); if (old && old !== port) old.disconnect(); ports.set(lease.id, port);
        // SA-01 is read-only. No durable acceptance is claimed before the ledger is integrated.
        port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: { status: 'rejected', reason: 'paused' } });
      })().catch(() => { port.disconnect(); close(); }).finally(() => { busy = false; });
    });
  });
  const navigated = (d: chrome.webNavigation.CommitDetails) => {
    if (d.frameId !== 0) return;
    void siteTransport.invalidate(d.tabId).then(async () => {
      for (const [id, p] of ports) if (p.sender?.tab?.id === d.tabId) {
        try { p.postMessage({ operation: 'invalidateLease', leaseId: id }); } catch { /* gone */ }
        p.disconnect(); ports.delete(id);
      }
      if ((await read()).enabled && await chrome.permissions.contains(grants) && new URL(d.url).origin === BILIBILI.origin)
        await chrome.scripting.executeScript({ target: { tabId: d.tabId }, world: 'ISOLATED', files: ['site-adapter.js'] }).catch(() => undefined);
    }).catch(() => undefined);
  };
  let navigationInstalled = false;
  const installNavigation = () => {
    if (navigationInstalled || !chrome.webNavigation?.onCommitted) return;
    chrome.webNavigation.onCommitted.addListener(navigated);
    chrome.webNavigation.onHistoryStateUpdated.addListener(navigated);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(navigated);
    navigationInstalled = true;
  };
  installNavigation();
  chrome.permissions.onAdded.addListener(() => { installNavigation(); void reconcile().catch(() => undefined); });
  chrome.tabs.onRemoved.addListener(id => { void siteTransport.invalidate(id).catch(() => undefined); });
  chrome.permissions.onRemoved.addListener(() => {
    void siteTransport.invalidate().then(async () => { disconnectAll(); await reconcile(); }).catch(() => undefined);
  });
  chrome.runtime.onStartup.addListener(() => { void reconcile().catch(() => undefined); });
  chrome.runtime.onInstalled.addListener(() => {
    void siteTransport.invalidate().then(async () => { disconnectAll(); await reconcile(); await injectOpen(); }).catch(() => undefined);
  });
  void reconcile().catch(() => undefined);
}
