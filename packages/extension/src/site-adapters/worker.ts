import { validDestinationRequest, handleDestinationRequest } from './destination-runtime.js';
import { installContentBindings, installContentResolver, validContentRequest, handleContentRequest } from './content-runtime.js';
import { AUTOMATION_CHANGED_KEY } from '../automation/messages.js';
import { createSourceArchiveRuntime } from './archive-runtime.js';
import { createConfirmationQueue } from './confirmation-queue.js';
import { installSourceLayout } from './layout-runtime.js';
import { installSiteAdapterEvidence } from './evidence.js';
import { installPlannedSaveRuntime, wakePlannedSaves, installSourceRecoveryScheduler } from './planned-runtime.js';
import { siteLedger, synchronizeSourceAuthority, sourceContext, SITE_RECOVERY_ALARM } from './source-runtime.js';
import type { AdapterMessage, HostCommand } from './contracts.js';
import { validMembershipResult, validBootstrap } from './schemas.js';
import { createReadScheduler } from './read-scheduler.js';
import { LIMITS } from './limits.js';
import { BILIBILI } from './bilibili/identity.js';
import { initialTransportState, createSiteTransport, SITE_PORT, SITE_STATE_KEY, type SiteSender, type TransportState, validSiteSender } from './transport.js';
import { object, literal, str } from './schema.js';
import { validAdapterMessage } from './schemas.js';
import { adapterBrowserSupport } from './browser-support.js';
import { handleRepairRequest, validRepairRequest } from './repair-runtime.js';
import { assertSourceRebound } from './portable.js';
const browserSupport = () => adapterBrowserSupport(navigator.userAgent);
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
  write: s => chrome.storage.local.set({ [SITE_STATE_KEY]: s }), permitted: async () => browserSupport().supported && await chrome.permissions.contains(grants),
  current: async s => {
    if (s.tab?.id === undefined) return null;
    const frame = await chrome.webNavigation.getFrame({ tabId: s.tab.id, frameId: 0 }).catch(() => null);
    return frame && frame.documentId === s.documentId && new URL(frame.url).origin === BILIBILI.origin && frame.documentLifecycle === 'active' ? frame.url : null;
  } });
const activation = createReadScheduler(chrome.storage.local, 'known.siteAdapters.activation.v1');
const reads = createReadScheduler(chrome.storage.local, 'known.siteAdapters.readQueue.v1');
const INSPECTION = 'known.siteAdapters.inspection.v1', CATALOG = 'known.siteAdapters.catalog.v1';
interface CatalogCache { context: string; items: import('./contracts.js').SiteCollection[]; nextCursor: string | null; outstanding: string | null }
const catalogContext = (c: import('./ledger-types.js').SourceContext) => JSON.stringify([c.connectionId, c.installationGeneration, c.sourceSessionGeneration, c.documentId, c.routeEpoch]);
interface Inspection { command: Exclude<HostCommand, { operation: 'cancelRead' | 'invalidateLease' | 'shutdown' | 'renewLease' }>; documentId: string; result?: unknown }
async function senderCurrent(sender: SiteSender): Promise<boolean> {
  if (!browserSupport().supported || !validSiteSender(sender, chrome.runtime.id) || !await chrome.permissions.contains(grants) || !(await read()).enabled) return false;
  const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
  return !!frame && frame.documentId === sender.documentId && new URL(frame.url).origin === BILIBILI.origin && frame.documentLifecycle === 'active';
}
async function inspect(kind: 'collections' | 'items' | 'resolve', collectionId?: string, cursor: string | null = null, tabId?: number) {
  await confirmations.wake();
  const source = await readableSiteSource(tabId);
  if (!source) return { status: 'paused', retryAfterMs: LIMITS.spacingMs };
  const s = await read(), lease = s.leases.find(l => l.id === source.context.leaseId);
  if (!lease) throw new Error('pageUnavailable');
  const context = source.context;
  const previous = (await chrome.storage.local.get(CATALOG))[CATALOG] as CatalogCache | undefined;
  if (kind === 'collections' && cursor && (previous?.context !== catalogContext(context) || previous.nextCursor !== cursor || previous.outstanding)) throw new Error('staleCursor');
  const id = crypto.randomUUID(), deadlineAt = Math.min(Date.now() + LIMITS.commandMs, lease.expiresAt - 1000);
  const acquired = await reads.acquire({ id, documentId: lease.documentId, deadlineAt });
  if (acquired.status !== 'ready') return acquired;
  const command: Inspection['command'] = kind === 'resolve' ? { operation: 'resolveItem', leaseId: lease.id, resolutionId: id, url: lease.url, deadlineAt }
    : { operation: 'readPage', leaseId: lease.id, readSessionId: id, pageRequestId: id, deadlineAt,
      query: kind === 'collections' ? { kind, cursor } : { kind, collectionId: collectionId!, cursor } };
  await chrome.storage.local.set({ [INSPECTION]: { command, documentId: lease.documentId }, ...(kind === 'collections' ? { [CATALOG]:
    { context: catalogContext(context), items: cursor ? previous!.items : [], nextCursor: cursor, outstanding: id } satisfies CatalogCache } : {}) });
  ports.get(lease.id)!.postMessage(command);
  return { status: 'reading' };
}
async function acceptInspection(message: AdapterMessage, context: import('./ledger-types.js').SourceContext) {
  const stored = (await chrome.storage.local.get(INSPECTION))[INSPECTION] as Inspection | undefined;
  if (!stored || stored.documentId !== context.documentId || stored.command.leaseId !== message.leaseId || stored.command.deadlineAt <= Date.now()) return false;
  const c = stored.command;
  const matches = c.operation === 'readPage' && message.operation === 'page.result' && c.pageRequestId === message.pageRequestId && c.readSessionId === message.readSessionId
    && (message.result.status === 'failed' || (message.result.kind === c.query.kind && (message.result.kind !== 'items' || (c.query.kind === 'items' && message.result.collectionId === c.query.collectionId))))
    || c.operation === 'resolveItem' && message.operation === 'item.result' && c.resolutionId === message.resolutionId
    || c.operation === 'readMemberships' && message.operation === 'membership.result' && c.readRequestId === message.readRequestId
      && c.readSessionId === message.readSessionId && validMembershipResult(message.result, c.query);
  if (!matches || !('result' in message)) return false;
  if (stored.result !== undefined) return JSON.stringify(stored.result) === JSON.stringify(message.result);
  let catalog: CatalogCache | undefined;
  if (c.operation === 'readPage' && c.query.kind === 'collections' && message.operation === 'page.result') {
    const cache = (await chrome.storage.local.get(CATALOG))[CATALOG] as CatalogCache | undefined;
    if (!cache || cache.context !== catalogContext(context) || cache.outstanding !== c.pageRequestId) return false;
    if (message.result.status === 'ok' && message.result.kind === 'collections') {
      const combined = [...cache.items, ...message.result.page.items];
      if (combined.length > 2000 || new Set(combined.map(c => c.id)).size !== combined.length) return false;
      catalog = { ...cache, items: combined, outstanding: null, nextCursor: message.result.page.nextCursor };
    } else catalog = { ...cache, outstanding: null, nextCursor: null };
  }
  await chrome.storage.local.set({ [INSPECTION]: { ...stored, result: message.result }, ...(catalog ? { [CATALOG]: catalog } : {}) });
  const error = message.result.status === 'failed' ? message.result.error : null;
  await reads.finish(message.requestId, error?.retryAfterMs);
  return true;
}
const ports = new Map<string, chrome.runtime.Port>();
let workTimer: ReturnType<typeof setTimeout> | undefined, workAt = Infinity;
function scheduleSourceWork(at: number) {
  if (workTimer && at >= workAt) return;
  workAt = at; clearTimeout(workTimer);
  chrome.alarms.create(SITE_RECOVERY_ALARM, { when: at });
  workTimer = setTimeout(() => { workAt = Infinity; workTimer = undefined; void wakeSourceWork().catch(() => undefined); }, Math.max(50, at - Date.now()));
}
async function currentSiteSource(tabId?: number) {
  const s = await read(), lease = s.leases.find(l => l.expiresAt > Date.now() && ports.has(l.id) && (tabId === undefined || l.tabId === tabId));
  return lease ? { context: await sourceContext(lease), expiresAt: lease.expiresAt } : null;
}
const sendSiteCommand = (c: import('./ledger-types.js').SourceContext, command: HostCommand) => {
  const port = ports.get(c.leaseId); if (!port) throw new Error('pageUnavailable'); port.postMessage(command);
};
let renewingLease: string | undefined;
async function readableSiteSource(tabId?: number) {
  const source = await currentSiteSource(tabId); if (!source) return null;
  if (source.expiresAt - Date.now() < LIMITS.commandMs + 1000 && ((await reads.current()).active?.deadlineAt ?? 0) <= Date.now()) {
    if (renewingLease !== source.context.leaseId) { renewingLease = source.context.leaseId; sendSiteCommand(source.context, { operation: 'renewLease', leaseId: source.context.leaseId }); }
    scheduleSourceWork(Date.now() + LIMITS.spacingMs); return null;
  }
  return source;
}
const confirmations = createConfirmationQueue(siteLedger, reads, { source: readableSiteSource, send: sendSiteCommand, alarm: scheduleSourceWork });
const archives = createSourceArchiveRuntime(reads, { source: currentSiteSource, readSource: readableSiteSource, send: sendSiteCommand, alarm: scheduleSourceWork,
  prioritizeLive: () => confirmations.wake(),
  catalog: async () => {
    const source = await currentSiteSource(), cache = (await chrome.storage.local.get(CATALOG))[CATALOG] as CatalogCache | undefined;
    if (!source || !cache || cache.context !== catalogContext(source.context) || cache.outstanding) throw new Error('refreshCatalogRequired');
    return cache.items;
  },
});
let working: Promise<void> | undefined, workWanted = false;
function wakeSourceWork(): Promise<void> {
  if (working) { workWanted = true; return working; }
  return working = (async () => {
    if ((await read()).enabled) { await confirmations.wake(); await archives.live.wake(); }
    await archives.importer.wake(); await wakePlannedSaves();
  })().finally(() => { working = undefined; if (workWanted) { workWanted = false; scheduleSourceWork(Date.now() + 50); } });
}
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
  let s = await read(); const granted = browserSupport().supported && await chrome.permissions.contains(grants);
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
const retrySchema = object({ kind: literal('known.siteAdapters.retryConfirmation') });
const confirmSchema = object({ kind: literal('known.siteAdapters.confirm'), accountId: str(128) });
export function installSiteAdapters() {
  installContentBindings();
  installContentResolver(async (url, tabId) => {
    if (tabId === undefined) return null;
    const source = await currentSiteSource(tabId);
    if (!source) return null;
    const state = await read(), lease = state.leases.find(l => l.id === source.context.leaseId);
    const { resolveBvUrl } = await import('./bilibili/identity.js');
    if (!lease || !resolveBvUrl(url) || resolveBvUrl(url) !== resolveBvUrl(lease.url)) return null;
    const deadline = Date.now() + LIMITS.commandMs;
    let requested = await inspect('resolve', undefined, null, tabId);
    while (requested.status === 'paused' && Date.now() + (requested.retryAfterMs ?? LIMITS.spacingMs) < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.max(LIMITS.spacingMs, requested.retryAfterMs ?? LIMITS.spacingMs)));
      const current = await currentSiteSource(tabId);
      if (!current || current.context.documentId !== source.context.documentId || current.context.routeEpoch !== source.context.routeEpoch || current.context.sourceSessionGeneration !== source.context.sourceSessionGeneration) return null;
      requested = await inspect('resolve', undefined, null, tabId);
    }
    if (requested.status !== 'reading') return null;
    const outstanding = (await chrome.storage.local.get(INSPECTION))[INSPECTION] as Inspection;
    while (Date.now() < outstanding.command.deadlineAt) {
      const current = (await chrome.storage.local.get(INSPECTION))[INSPECTION] as Inspection;
      if (current.command !== undefined && JSON.stringify(current.command) !== JSON.stringify(outstanding.command)) return null;
      if (current.result) { const result = current.result as { status: string; item?: { id: string } }; return result.status === 'resolved' ? result.item?.id ?? null : null; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  });
  installPlannedSaveRuntime();
  installSourceLayout();
  installSourceRecoveryScheduler(scheduleSourceWork);
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
    if (validContentRequest(raw) || validDestinationRequest(raw)) {
      const path = sender.url && new URL(sender.url).pathname;
      if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) || !['/popup.html', '/site-adapters.html'].includes(path || '')) return false;
      void (validDestinationRequest(raw) ? handleDestinationRequest(raw) : handleContentRequest(raw)).then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : 'unavailable' })); return true;
    }
    if (management(sender) && validRepairRequest(raw)) {
      void handleRepairRequest(raw).then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : 'unavailable' })); return true;
    }
    if (!management(sender) || !(statusSchema(raw) || enableSchema(raw) || confirmSchema(raw) || inspectSchema(raw) || retrySchema(raw) || archives.valid(raw))) return false;
    void (async () => {
      if (!browserSupport().supported && !statusSchema(raw) && !(enableSchema(raw) && !d!.enabled)) throw new Error('browserUnsupported');
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
      let archiveResult: unknown;
      if (archives.valid(raw)) archiveResult = await archives.handle(raw);
      let inspectionStatus: unknown;
      if (retrySchema(raw)) await confirmations.retry();
      if (inspectSchema(raw)) {
        const q = raw as { operation: 'collections' | 'items' | 'resolve'; collectionId?: string; cursor?: string | null };
        inspectionStatus = await inspect(q.operation, q.collectionId, q.cursor);
      }
      const archiveState = await archives.status();
      const siteStatus = await siteTransport.status();
      let archiveHold: string | null = null;
      if (archiveState.config) try { await assertSourceRebound(siteLedger.db, archiveState.config.connectionId); } catch (e) { archiveHold = e instanceof Error ? e.message : 'sourceNeedsReview'; }
      const writes = !archiveHold && browserSupport().supported && siteStatus.enabled && siteStatus.connected && archiveState.config?.state === 'active' && await chrome.permissions.contains({ permissions: ['bookmarks'] });
      return { ...siteStatus, browser: browserSupport(), grants: { site: await chrome.permissions.contains(grants), bookmarks: await chrome.permissions.contains({ permissions: ['bookmarks'] }) },
        mode: writes ? 'localArchive' : 'inspector', writes, archiveHold, archive: archiveState, ...(archiveResult ? { archiveResult } : {}), capabilities: { itemIdentity: 'avAndBv', observation: 'freshPositiveMembership', humanActionProof: 'unavailable',
        negativeMembership: 'unavailable', shortLinks: 'unavailable', collectionChanges: 'explicitCatalogRead', nativeWrites: archiveState.config?.state === 'active' ? 'previewApprovalOrEnabledLivePolicy' : 'unavailable' },
      confirmations: await confirmations.status(), ...(inspectionStatus ? { inspectionStatus } : {}), inspection: (await chrome.storage.local.get(INSPECTION))[INSPECTION] ?? null };
    })().then(respond, e => respond({ error: e instanceof Error ? e.message : 'unavailable' })); return true;
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== SITE_PORT || !port.sender) return;
    let leaseId: string | null = null, closed = false, pending = 0, tail = Promise.resolve();
    const close = () => { closed = true; if (leaseId && ports.get(leaseId) === port) { ports.delete(leaseId); void siteTransport.retire(leaseId).catch(() => undefined); void siteLedger.revokeLease(leaseId).catch(() => undefined); } };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(raw => {
      if (closed || pending >= LIMITS.queue || !validAdapterMessage(raw)) { port.disconnect(); close(); return; }
      pending++;
      tail = tail.then(async () => {
        if (closed) return;
        const lease = await siteTransport.authorize(raw, port.sender!);
        if (!lease || (leaseId && leaseId !== lease.id)) { port.disconnect(); close(); return; }
        leaseId = lease.id;
        const old = ports.get(lease.id); ports.set(lease.id, port); if (old && old !== port) old.disconnect();
        if (raw.operation.endsWith('.result')) {
          const context = await sourceContext(lease);
          const confirmed = await confirmations.accept(context, raw);
          const imported = !confirmed ? await archives.importer.accept(context, raw) : null;
          if (imported) { port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: imported }); return; }
          const inspected = confirmed || await acceptInspection(raw, context);
          port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: inspected ? { status: 'readResult', value: 'inspected' } : { status: 'rejected', reason: 'staleContext' } }); return;
        }
        if (raw.operation === 'membership.hint') {
          const receipt = await confirmations.enqueue(await sourceContext(lease), raw.requestId, raw.hint);
          port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: receipt });
          scheduleSourceWork(Date.now() + 50); return;
        }
        if (raw.operation === 'connect') { scheduleSourceWork(Date.now() + 50); }
        if (raw.operation === 'emit') {
          chrome.alarms.create(SITE_RECOVERY_ALARM, { when: Date.now() + 30000 });
          const receipt = await siteLedger.acceptObservation(await sourceContext(lease), raw.requestId, raw.data);
          port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: receipt }); return;
        }
        // Native/model effects remain disabled. No durable acceptance is claimed before the ledger is integrated.
        port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: { status: 'rejected', reason: 'paused' } });
      }).catch(() => { port.disconnect(); close(); }).finally(() => { pending--; });
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
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[AUTOMATION_CHANGED_KEY]) scheduleSourceWork(Date.now() + 50); });
  chrome.permissions.onAdded.addListener(() => { installNavigation(); void reconcile().catch(() => undefined); });
  chrome.tabs.onRemoved.addListener(id => { void siteTransport.invalidate(id).then(() => siteLedger.revokeDocuments(id)).catch(() => undefined); });
  chrome.permissions.onRemoved.addListener(() => {
    void siteTransport.invalidate().then(async () => { await synchronizeSourceAuthority(await read()); disconnectAll(); await reconcile(); }).catch(() => undefined);
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === SITE_RECOVERY_ALARM) void synchronizeSourceAuthorityFromCurrent().then(async () => { await wakeSourceWork(); }).catch(() => undefined); });
  chrome.runtime.onStartup.addListener(() => { void reconcile().then(async () => { await wakeSourceWork(); }).catch(() => undefined); });
  chrome.runtime.onInstalled.addListener(() => {
    void siteTransport.invalidate().then(async () => { disconnectAll(); await reconcile(); await injectOpen(); }).catch(() => undefined);
  });
  void reconcile().then(async () => { await wakeSourceWork(); }).catch(() => undefined);
}

async function synchronizeSourceAuthorityFromCurrent() { await synchronizeSourceAuthority(await read()); }
