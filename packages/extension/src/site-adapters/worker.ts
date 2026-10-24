import { installSourceLayout } from './layout-runtime.js';
import { installSiteAdapterEvidence } from './evidence.js';
import { installPlannedSaveRuntime, wakePlannedSaves } from './planned-runtime.js';
import { siteLedger, synchronizeSourceAuthority, sourceContext, SITE_RECOVERY_ALARM } from './source-runtime.js';
import type { AdapterMessage, HostCommand } from './contracts.js';
import { validMembershipResult, validBootstrap } from './schemas.js';
import { createReadScheduler } from './read-scheduler.js';
import { LIMITS } from './limits.js';
import { BILIBILI } from './bilibili/identity.js';
import { initialTransportState, createSiteTransport, SITE_PORT, SITE_STATE_KEY, type SiteSender, type TransportState, validSiteSender } from './transport.js';
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
const activation = createReadScheduler(chrome.storage.local, 'known.siteAdapters.activation.v1');
const reads = createReadScheduler(chrome.storage.local, 'known.siteAdapters.readQueue.v1');
const INSPECTION = 'known.siteAdapters.inspection.v1';
interface Inspection { command: Exclude<HostCommand, { operation: 'cancelRead' | 'invalidateLease' | 'shutdown' }>; documentId: string; result?: unknown }
async function senderCurrent(sender: SiteSender): Promise<boolean> {
  if (!validSiteSender(sender, chrome.runtime.id) || !await chrome.permissions.contains(grants) || !(await read()).enabled) return false;
  const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
  return !!frame && frame.documentId === sender.documentId && new URL(frame.url).origin === BILIBILI.origin && frame.documentLifecycle === 'active';
}
async function inspect(kind: 'collections' | 'items' | 'resolve', collectionId?: string, cursor: string | null = null) {
  const s = await read(), lease = s.leases.find(l => l.expiresAt > Date.now() && ports.has(l.id));
  if (!lease) throw new Error('pageUnavailable');
  const id = crypto.randomUUID(), deadlineAt = Math.min(Date.now() + LIMITS.commandMs, lease.expiresAt - 1000);
  const acquired = await reads.acquire({ id, documentId: lease.documentId, deadlineAt });
  if (acquired.status !== 'ready') return acquired;
  const command: Inspection['command'] = kind === 'resolve' ? { operation: 'resolveItem', leaseId: lease.id, resolutionId: id, url: lease.url, deadlineAt }
    : { operation: 'readPage', leaseId: lease.id, readSessionId: id, pageRequestId: id, deadlineAt,
      query: kind === 'collections' ? { kind, cursor } : { kind, collectionId: collectionId!, cursor } };
  await chrome.storage.local.set({ [INSPECTION]: { command, documentId: lease.documentId } });
  ports.get(lease.id)!.postMessage(command);
  return { status: 'reading' };
}
async function acceptInspection(message: AdapterMessage, documentId: string) {
  const stored = (await chrome.storage.local.get(INSPECTION))[INSPECTION] as Inspection | undefined;
  if (!stored || stored.documentId !== documentId || stored.command.leaseId !== message.leaseId || stored.command.deadlineAt <= Date.now()) return false;
  const c = stored.command;
  const matches = c.operation === 'readPage' && message.operation === 'page.result' && c.pageRequestId === message.pageRequestId && c.readSessionId === message.readSessionId
    && (message.result.status === 'failed' || (message.result.kind === c.query.kind && (message.result.kind !== 'items' || (c.query.kind === 'items' && message.result.collectionId === c.query.collectionId))))
    || c.operation === 'resolveItem' && message.operation === 'item.result' && c.resolutionId === message.resolutionId
    || c.operation === 'readMemberships' && message.operation === 'membership.result' && c.readRequestId === message.readRequestId
      && c.readSessionId === message.readSessionId && validMembershipResult(message.result, c.query);
  if (!matches || !('result' in message)) return false;
  if (stored.result !== undefined && JSON.stringify(stored.result) !== JSON.stringify(message.result)) return false;
  await chrome.storage.local.set({ [INSPECTION]: { ...stored, result: message.result } });
  const error = message.result.status === 'failed' ? message.result.error : null;
  await reads.finish(message.requestId, error?.retryAfterMs);
  return true;
}
const ports = new Map<string, chrome.runtime.Port>();
function disconnectAll() { for (const [id, p] of ports) { try { p.postMessage({ operation: 'shutdown', leaseId: id }); p.disconnect(); } catch { /* gone */ } } ports.clear(); }
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
  let s = await read(); const granted = await chrome.permissions.contains(grants);
  if (s.enabled && !granted) { await siteTransport.invalidate(); s = await read(); }
  await synchronizeSourceAuthority(s);
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
const inspectSchema = object({ kind: literal('known.siteAdapters.inspect'), operation: literal('collections', 'items', 'resolve'), collectionId: v => v === undefined || /^\d{1,20}$/u.test(String(v)), cursor: v => v === undefined || v === null || str(512)(v) });
const confirmSchema = object({ kind: literal('known.siteAdapters.confirm'), accountId: str(128) });
export function installSiteAdapters() {
  installPlannedSaveRuntime();
  installSourceLayout();
  if (__KNOWN_EXTENSION_EVIDENCE__) installSiteAdapterEvidence();
  // Registered synchronously; initialization is awaited inside each handler.
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const d = raw as { kind?: string; request?: unknown; enabled?: boolean; accountId?: string } | null;
    if (d?.kind === 'known.siteAdapters.activation') {
      if (!object({ kind: literal('known.siteAdapters.activation') })(raw)) return false;
      void (async () => {
        await trustedStorage(); if (!await senderCurrent(sender)) return { status: 'unavailable', retryAfterMs: 500 };
        const id = crypto.randomUUID();
        const slot = await activation.acquire({ id, documentId: sender.documentId!, deadlineAt: Date.now() + LIMITS.activationMs }, true);
        return slot.status === 'ready' ? { status: 'ready', activationId: slot.id, deadlineAt: slot.deadlineAt } : slot;
      })().then(respond, () => respond({ status: 'unavailable' })); return true;
    }
    if (d?.kind === 'known.siteAdapters.bootstrap') {
      if (!object({ kind: literal('known.siteAdapters.bootstrap'), request: () => true })(raw)) return false;
      void (async () => {
        if (!validBootstrap(d.request) || d.request.runtime !== 'bundled') return { status: 'unavailable', reason: 'version' };
        const slot = (await activation.current()).active;
        if (!slot || slot.id !== d.request.activationId || slot.documentId !== sender.documentId || slot.deadlineAt <= Date.now() || !await senderCurrent(sender))
          return { status: 'unavailable', reason: 'disabled' };
        await activation.finish(slot.id);
        const reply = await siteTransport.bootstrap(d.request, sender);
        await synchronizeSourceAuthority(await read());
        if (reply.status === 'ready') {
          const s = await read(), lease = s.leases.find(l => l.id === reply.leaseId);
          if (!lease) return { status: 'unavailable', reason: 'disabled' };
          await siteLedger.bindLease(await sourceContext(lease), lease.expiresAt);
        }
        return reply;
      })().then(respond, () => respond({ status: 'unavailable', reason: 'disabled' })); return true;
    }
    if (!management(sender) || !(statusSchema(raw) || enableSchema(raw) || confirmSchema(raw) || inspectSchema(raw))) return false;
    void (async () => {
      if (enableSchema(raw)) {
        if (d!.enabled && !await chrome.permissions.contains(grants)) throw new Error('permissionRequired');
        await siteTransport.configure(d!.enabled!); await synchronizeSourceAuthority(await read()); disconnectAll();
        if (!d!.enabled && await chrome.permissions.contains(grants)) for (const tab of await chrome.tabs.query({ url: [...BILIBILI.matches] })) {
          if (tab.id !== undefined && !tab.incognito) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN',
            func: () => { window.dispatchEvent(new Event('known-site-probe-stop')); } }).catch(() => undefined);
          if (tab.id !== undefined && !tab.incognito) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED',
            func: () => { window.dispatchEvent(new Event('known-site-adapter-stop')); } }).catch(() => undefined);
        }
        await reconcile(); if (d!.enabled) await injectOpen();
      }
      if (confirmSchema(raw)) { await siteTransport.confirm(d!.accountId!); await synchronizeSourceAuthority(await read()); disconnectAll(); await injectOpen(); }
      if (inspectSchema(raw)) {
        const q = raw as { operation: 'collections' | 'items' | 'resolve'; collectionId?: string; cursor?: string | null };
        await inspect(q.operation, q.collectionId, q.cursor);
      }
      return { ...await siteTransport.status(), inspection: (await chrome.storage.local.get(INSPECTION))[INSPECTION] ?? null };
    })().then(respond, e => respond({ error: e instanceof Error ? e.message : 'unavailable' })); return true;
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== SITE_PORT || !port.sender) return;
    let leaseId: string | null = null, closed = false, busy = false;
    const close = () => { closed = true; if (leaseId && ports.get(leaseId) === port) { ports.delete(leaseId); void siteTransport.retire(leaseId).catch(() => undefined); void siteLedger.revokeLease(leaseId).catch(() => undefined); } };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(raw => {
      if (closed || busy || !validAdapterMessage(raw)) { port.disconnect(); close(); return; }
      busy = true;
      void (async () => {
        const lease = await siteTransport.authorize(raw, port.sender!);
        if (!lease || (leaseId && leaseId !== lease.id)) { port.disconnect(); close(); return; }
        leaseId = lease.id;
        const old = ports.get(lease.id); ports.set(lease.id, port); if (old && old !== port) old.disconnect();
        if (raw.operation.endsWith('.result')) {
          const inspected = await acceptInspection(raw, lease.documentId);
          port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: inspected ? { status: 'readResult', value: 'inspected' } : { status: 'rejected', reason: 'staleContext' } }); return;
        }
        if (raw.operation === 'emit') {
          chrome.alarms.create(SITE_RECOVERY_ALARM, { when: Date.now() + 30000 });
          const receipt = await siteLedger.acceptObservation(await sourceContext(lease), raw.requestId, raw.data);
          port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: receipt }); return;
        }
        // Native/model effects remain disabled. No durable acceptance is claimed before the ledger is integrated.
        port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: { status: 'rejected', reason: 'paused' } });
      })().catch(() => { port.disconnect(); close(); }).finally(() => { busy = false; });
    });
  });
  const navigated = (d: chrome.webNavigation.CommitDetails) => {
    if (d.frameId !== 0) return;
    void siteTransport.invalidate(d.tabId).then(async () => {
      await siteLedger.revokeDocuments(d.tabId);
      for (const [id, p] of ports) if (p.sender?.tab?.id === d.tabId) {
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
  chrome.tabs.onRemoved.addListener(id => { void siteTransport.invalidate(id).then(() => siteLedger.revokeDocuments(id)).catch(() => undefined); });
  chrome.permissions.onRemoved.addListener(() => {
    void siteTransport.invalidate().then(async () => { await synchronizeSourceAuthority(await read()); disconnectAll(); await reconcile(); }).catch(() => undefined);
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === SITE_RECOVERY_ALARM) void synchronizeSourceAuthorityFromCurrent().then(wakePlannedSaves).catch(() => undefined); });
  chrome.runtime.onStartup.addListener(() => { void reconcile().then(wakePlannedSaves).catch(() => undefined); });
  chrome.runtime.onInstalled.addListener(() => {
    void siteTransport.invalidate().then(async () => { disconnectAll(); await reconcile(); await injectOpen(); }).catch(() => undefined);
  });
  void reconcile().then(wakePlannedSaves).catch(() => undefined);
}

async function synchronizeSourceAuthorityFromCurrent() { await synchronizeSourceAuthority(await read()); }
