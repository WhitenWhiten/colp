import { selectReadLease } from './read-source.js';
import { siteFeatures } from './capabilities.js';
import { reconcileBundledScripts } from './browser-registration.js';
import { matchesSiteUrl } from './registry-validation.js';
import { createCloudRuntime } from './cloud-runtime.js';
import { validDestinationRequest, handleDestinationRequest } from './destination-runtime.js';
import { installContentBindings, installContentResolver, validContentRequest, handleContentRequest } from './content-runtime.js';
import { AUTOMATION_CHANGED_KEY } from '../automation/messages.js';
import { createSourceArchiveRuntime } from './archive-runtime.js';
import { createConfirmationQueue } from './confirmation-queue.js';
import { installSourceLayout } from './layout-runtime.js';
import { semanticJobs, enqueueSourceSemantics, installSemanticRuntime } from './semantic-runtime.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { rows } from './source-db.js';
import { flushManagedChanges } from './managed-change-runtime.js';
import { reconciliationRuns, installReconciliationRuntime, validReconcileRequest, handleReconcileRequest } from './reconcile-runtime.js';
import { installSiteAdapterEvidence } from './evidence.js';
import { installPlannedSaveRuntime, wakePlannedSaves, installSourceRecoveryScheduler } from './planned-runtime.js';
import { siteLedger as sharedLedger, synchronizeSourceAuthority, sourceContext, SITE_RECOVERY_ALARM } from './source-runtime.js';
import type { AdapterMessage, HostCommand } from './contracts.js';
import { validMembershipResult, validBootstrap } from './schemas.js';
import { createReadScheduler } from './read-scheduler.js';
import { readLimits } from './read-policy.js';
import { bundledSites, legacySite, type SiteDefinition } from './registry.js';
import { installationKey } from './installation.js';
import { createSourceLedger } from './ledger.js';
import { initialTransportState, createSiteTransport, SITE_PORT as BASE_PORT, SITE_STATE_KEY as BASE_STATE_KEY, type SiteSender, type TransportState, validSiteSender } from './transport.js';
import { object, literal, str } from './schema.js';
import { validAdapterMessage } from './schemas.js';
import { adapterBrowserSupport } from './browser-support.js';
import { handleRepairRequest, validRepairRequest } from './repair-runtime.js';
import { assertSourceRebound } from './portable.js';
import { createCommunityRuntime, validCommunityManagement } from './community-runtime.js';
import { assertCommunityArchive } from './community-authority.js';
function createSiteHost(definition: SiteDefinition) {
  const semanticRetry = object({ kind: literal('known.siteAdapters.semantic.retry'), jobId: str(128), reclassify: v => v === undefined || literal(true, false)(v) });
  const LIMITS = readLimits(definition);
  const siteLedger = createSourceLedger(sharedLedger.db, {}, definition);
  const { validCloudManagement, handleCloudManagement } = createCloudRuntime(definition);
  const SITE_STATE_KEY = installationKey(BASE_STATE_KEY, definition), SITE_PORT = installationKey(BASE_PORT, definition);
  const recoveryAlarm = installationKey(SITE_RECOVERY_ALARM, definition);
  const browserSupport = () => adapterBrowserSupport(navigator.userAgent);
  const grants = { permissions: ['scripting', 'webNavigation'], origins: [...definition.matches] };
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
  const siteTransport = createSiteTransport({ extensionId: chrome.runtime.id, now: Date.now, random: () => crypto.randomUUID(), read,
    write: s => chrome.storage.local.set({ [SITE_STATE_KEY]: s }), permitted: async () => browserSupport().supported && await chrome.permissions.contains(grants),
    current: async s => {
      if (s.tab?.id === undefined) return null;
      const frame = await chrome.webNavigation.getFrame({ tabId: s.tab.id, frameId: 0 }).catch(() => null);
      return frame && frame.documentId === s.documentId && matchesSiteUrl(definition, frame.url) && frame.documentLifecycle === 'active' ? frame.url : null;
    } }, definition);
  const activation = createReadScheduler(chrome.storage.local, installationKey('known.siteAdapters.activation.v1', definition), Date.now, Math.max(LIMITS.spacingMs, LIMITS.requestSpacingMs));
  const reads = createReadScheduler(chrome.storage.local, installationKey('known.siteAdapters.readQueue.v1', definition), Date.now, Math.max(LIMITS.spacingMs, LIMITS.requestSpacingMs));
  const INSPECTION = installationKey('known.siteAdapters.inspection.v1', definition), CATALOG = installationKey('known.siteAdapters.catalog.v1', definition);
  interface CatalogCache { context: string; items: import('./contracts.js').SiteCollection[]; nextCursor: string | null; outstanding: string | null; failed?: string }
  // An account-wide reader's collections belong to the account, not to the tab that read them: browsing on or opening
  // another tab of the site keeps them current. A document-local reader's list is only good for its own page and route.
  const catalogContext = (c: import('./ledger-types.js').SourceContext) => JSON.stringify(definition.readScope === 'account'
    ? [c.connectionId, c.installationGeneration, c.sourceSessionGeneration] : [c.connectionId, c.installationGeneration, c.sourceSessionGeneration, c.documentId, c.routeEpoch]);
  /** The settings page's collection list: what was read for the connected account, and whether Save can use it now. */
  async function catalogStatus() {
    if (!siteFeatures(definition).collections) return null;
    // One read of both keys: a reply landing between two reads would show a list that is neither reading nor current.
    const stored = await chrome.storage.local.get([CATALOG, INSPECTION]), cache = stored[CATALOG] as CatalogCache | undefined, inspection = stored[INSPECTION] as Inspection | undefined;
    if (!cache) return null;
    const authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
    if (!authority?.connectionId || (JSON.parse(cache.context) as unknown[])[0] !== authority.connectionId) return null;
    const source = await currentSiteSource();
    const reading = !!cache.outstanding && inspection?.command.operation === 'readPage' && inspection.command.pageRequestId === cache.outstanding
      && inspection.result === undefined && inspection.command.deadlineAt > Date.now();
    return { items: cache.items, nextCursor: cache.nextCursor, reading, current: !!source && !cache.outstanding && cache.context === catalogContext(source.context), failed: cache.failed ?? null };
  }
  interface Inspection { command: Exclude<HostCommand, { operation: 'cancelRead' | 'invalidateLease' | 'shutdown' | 'renewLease' }>; documentId: string; result?: unknown }
  async function senderCurrent(sender: SiteSender): Promise<boolean> {
    if (!browserSupport().supported || !validSiteSender(sender, chrome.runtime.id, definition) || !await chrome.permissions.contains(grants) || !(await read()).enabled) return false;
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    return !!frame && frame.documentId === sender.documentId && matchesSiteUrl(definition, frame.url) && frame.documentLifecycle === 'active';
  }
  async function inspect(kind: 'collections' | 'items' | 'resolve', collectionId?: string, cursor: string | null = null, tabId?: number) {
    if (!definition.capabilities.includes(kind === 'resolve' ? 'resolveItem' : kind === 'collections' ? 'enumerateCollections' : 'enumerateItems')) throw new Error('unsupported');
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
        for (let offset = 0; offset < message.result.page.items.length; offset += 32) {
          const accepted = await siteLedger.acceptCatalog(context, `inspection-catalog:${message.requestId}:${offset}`, message.result.page.items.slice(offset, offset + 32));
          if (accepted.status === 'rejected') return false;
        }
      } else catalog = { ...cache, outstanding: null, nextCursor: null, failed: message.result.status === 'failed' ? message.result.error.code : 'unavailable' };
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
    chrome.alarms.create(recoveryAlarm, { when: at });
    workTimer = setTimeout(() => { workAt = Infinity; workTimer = undefined; void wakeSourceWork().catch(() => undefined); }, Math.max(50, at - Date.now()));
  }
  async function currentSiteSource(tabId?: number, origin?: import('./ledger-types.js').SourceContext) {
    const s = await read(), lease = selectReadLease(definition, s.leases, id => ports.has(id), Date.now(), origin, tabId);
    return lease ? { context: await sourceContext(lease, siteLedger), expiresAt: lease.expiresAt } : null;
  }
  const sendSiteCommand = (c: import('./ledger-types.js').SourceContext, command: HostCommand) => {
    const port = ports.get(c.leaseId); if (!port) throw new Error('pageUnavailable'); port.postMessage(command);
  };
  let renewingLease: string | undefined;
  async function readableSiteSource(tabId?: number, origin?: import('./ledger-types.js').SourceContext) {
    const source = await currentSiteSource(tabId, origin);
    if (!source) {
      const state = await read();
      const expired = selectReadLease(definition, state.leases.filter(l => l.generation === state.generation && l.sourceGeneration === state.sourceGeneration
        && l.accountId === state.accountId), id => ports.has(id), -Infinity, origin, tabId);
      if (state.enabled && !state.candidateAccount && expired && renewingLease !== expired.id) {
        renewingLease = expired.id; const port = ports.get(expired.id); port?.postMessage({ operation: 'renewLease', leaseId: expired.id });
        scheduleSourceWork(Date.now() + LIMITS.spacingMs);
      }
      return null;
    }
    if (source.expiresAt - Date.now() < LIMITS.commandMs + 1000 && ((await reads.current()).active?.deadlineAt ?? 0) <= Date.now()) {
      if (renewingLease !== source.context.leaseId) { renewingLease = source.context.leaseId; sendSiteCommand(source.context, { operation: 'renewLease', leaseId: source.context.leaseId }); }
      scheduleSourceWork(Date.now() + LIMITS.spacingMs); return null;
    }
    return source;
  }
  async function managementSource() {
    const hadConnection = (await read()).leases.some(l => ports.has(l.id));
    let injected = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const source = await readableSiteSource(); if (source) return source;
      if (!injected && !hadConnection && (await read()).enabled) { injected = true; await injectOpen(); }
      if (!hadConnection && !renewingLease && !injected) return null;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
  }
  const confirmations = createConfirmationQueue(siteLedger, reads, { source: origin => readableSiteSource(undefined, origin), send: sendSiteCommand, alarm: scheduleSourceWork,
    authorizeOrigin: async (context, collectionIds) => { if (context.communityOrigin) await assertCommunityArchive(context.communityOrigin, { connectionId: context.connectionId, collectionIds }); } });
  const archives = createSourceArchiveRuntime(reads, { source: managementSource, readSource: origin => readableSiteSource(undefined, origin), send: sendSiteCommand, alarm: scheduleSourceWork,
    reconciliation: { valid: validReconcileRequest, handle: handleReconcileRequest, status: reconciliationRuns.status, view: reconciliationRuns.view, cancel: reconciliationRuns.cancel },
    scope: currentCaptureScope,
    prioritizeLive: () => confirmations.wake(),
    catalog: async () => {
      const source = await currentSiteSource(), cache = (await chrome.storage.local.get(CATALOG))[CATALOG] as CatalogCache | undefined;
      if (!source || !cache || cache.context !== catalogContext(source.context) || cache.outstanding) throw new Error('refreshCatalogRequired');
      return cache.items;
    },
  }, siteLedger, definition);
  let working: Promise<void> | undefined, workWanted = false;
  function wakeSourceWork(): Promise<void> {
    if (working) { workWanted = true; return working; }
    return working = (async () => {
      await flushManagedChanges().catch(() => undefined);
      if ((await read()).enabled) { await confirmations.wake(); await archives.live.wake(); }
      await archives.importer.wake(); await wakePlannedSaves();
      await reconciliationRuns.wake();
      const importJob = await archives.importer.status();
      if (importJob?.preview?.id && importJob.phase === 'attention' && importJob.reason === 'sourceReviewRequired') {
        const run = await reconciliationRuns.view(importJob.preview.id);
        if (run?.state === 'completed') {
          const reviews = await siteLedger.db.transaction(['importPages'], 'readonly', tx => rows<{ reviewReason?: string }>(tx, 'importPages', 'frozenEdge', importJob.preview!.id));
          if (reviews.every(r => !r.reviewReason || ['sourceReconcileCandidate', 'suppressed', 'policySkipped', 'copyPolicyMigrationRequired'].includes(r.reviewReason))) await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
            const request = tx.objectStore('meta').get(`importJob:${importJob.id}`);
            request.onsuccess = () => { if (request.result?.phase === 'attention') tx.objectStore('meta').put({ ...request.result, phase: 'completed', reason: 'reconciledWithExceptions' }, `importJob:${importJob.id}`); };
          });
        }
      }
      const authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
      if (authority?.connectionId && await enqueueSourceSemantics(authority.connectionId)) scheduleSourceWork(Date.now() + 100);
      void semanticJobs.wake().catch(() => undefined);
    })().finally(() => { working = undefined; if (workWanted) { workWanted = false; scheduleSourceWork(Date.now() + 50); } });
  }
  function disconnectAll() { for (const [id, p] of ports) { try { p.postMessage({ operation: 'shutdown', leaseId: id }); p.disconnect(); } catch { /* gone */ } } ports.clear(); }
  function management(sender: SiteSender) {
    if (sender.id !== chrome.runtime.id || !sender.url) return false;
    try { const u = new URL(sender.url); return u.protocol === 'chrome-extension:' && u.hostname === chrome.runtime.id
      && ['/site-adapters.html', '/options.html'].includes(u.pathname); } catch { return false; }
  }
  async function injectOpen() {
    for (const tab of await chrome.tabs.query({ url: [...definition.matches] })) {
      if (tab.id === undefined || tab.incognito) continue;
      if (definition.scripts.probe) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: [definition.scripts.probe!] }).catch(() => undefined);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: [definition.scripts.adapter] }).catch(() => undefined);
    }
  }
  async function reconcile() {
    const openTabs = (await chrome.tabs.query({})).flatMap(tab => tab.id === undefined ? [] : [tab.id]);
    for (const id of await siteTransport.pruneTabs(openTabs)) await siteLedger.revokeDocuments(id);
    let s = await read(); const granted = browserSupport().supported && await chrome.permissions.contains(grants);
    if (s.enabled && !granted) { await siteTransport.invalidate(); s = await read(); }
    await synchronizeSourceAuthority(s, siteLedger);
    await reconcileBundledScripts(definition, s.enabled && granted);
  }
  const statusSchema = object({ kind: literal('known.siteAdapters.status'), reconcileOffset: v => v === undefined || Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 200000 && Number(v) % 100 === 0 });
  const enableSchema = object({ kind: literal('known.siteAdapters.enable'), enabled: literal(true, false) });
  const inspectSchema = object({ kind: literal('known.siteAdapters.inspect'), operation: literal('collections', 'items', 'resolve'), collectionId: v => v === undefined || definition.validateCollection(v), cursor: v => v === undefined || v === null || str(512)(v) });
  const retrySchema = object({ kind: literal('known.siteAdapters.retryConfirmation') });
  const confirmSchema = object({ kind: literal('known.siteAdapters.confirm'), accountId: str(128) });
  async function resolve(url: string, tabId?: number) {
      if (tabId === undefined) return null;
      const source = await currentSiteSource(tabId);
      if (!source) return null;
      const state = await read(), lease = state.leases.find(l => l.id === source.context.leaseId);
      if (!lease || !definition.sameResolutionTarget(url, lease.url)) return null;
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
  }
  function installHandlers() {
    // Registered synchronously; initialization is awaited inside each handler.
    chrome.runtime.onMessage.addListener((raw, sender, respond) => {
      const addressed = raw as { adapterId?: string; request?: { adapterId?: string } } | null;
      const target = addressed?.request?.adapterId ?? addressed?.adapterId ?? legacySite.adapterId;
      if (target !== definition.adapterId) return false;
      if (addressed?.adapterId) { const { adapterId: _adapter, ...body } = raw as Record<string, unknown>; raw = body; }
      const d = raw as { kind?: string; request?: unknown; enabled?: boolean; accountId?: string } | null;
      if (d?.kind === 'known.siteAdapters.activation') {
        if (!object({ kind: literal('known.siteAdapters.activation'), adapterId: v => v === undefined || v === definition.adapterId })(raw)) return false;
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
          await synchronizeSourceAuthority(await read(), siteLedger);
          if (reply.status === 'ready') {
            const s = await read(), lease = s.leases.find(l => l.id === reply.leaseId);
            if (!lease) return { status: 'unavailable', reason: 'disabled' };
            await siteLedger.bindLease(await sourceContext(lease, siteLedger), lease.expiresAt);
          }
          return reply;
        })().then(respond, () => respond({ status: 'unavailable', reason: 'disabled' })); return true;
      }
      if (validContentRequest(raw) || validDestinationRequest(raw)) {
        const path = sender.url && new URL(sender.url).pathname;
        if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) || !['/popup.html', '/site-adapters.html'].includes(path || '')) return false;
        void (validDestinationRequest(raw) ? handleDestinationRequest(raw) : handleContentRequest(raw, definition)).then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : 'unavailable' })); return true;
      }
      if (management(sender) && validCloudManagement(raw)) {
        void handleCloudManagement(raw).then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : 'sourceCloudUnavailable' })); return true;
      }
      if (management(sender) && validRepairRequest(raw)) {
        void handleRepairRequest(raw, definition).then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : 'unavailable' })); return true;
      }
      if (management(sender) && validCommunityManagement(raw)) {
        void community.management(raw).then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : 'communityUnavailable' })); return true;
      }
      if (!management(sender) || !(statusSchema(raw) || enableSchema(raw) || confirmSchema(raw) || inspectSchema(raw) || retrySchema(raw) || semanticRetry(raw) || archives.valid(raw))) return false;
      void (async () => {
        if (!browserSupport().supported && !statusSchema(raw) && !(enableSchema(raw) && !d!.enabled)) throw new Error('browserUnsupported');
        if (enableSchema(raw)) {
          if (d!.enabled && !await chrome.permissions.contains(grants)) throw new Error('permissionRequired');
          await siteTransport.configure(d!.enabled!); await synchronizeSourceAuthority(await read(), siteLedger); disconnectAll();
          if (!d!.enabled && await chrome.permissions.contains(grants)) for (const tab of await chrome.tabs.query({ url: [...definition.matches] })) {
            if (tab.id !== undefined && !tab.incognito) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN',
              func: () => { window.dispatchEvent(new Event('known-site-probe-stop')); } }).catch(() => undefined);
            if (tab.id !== undefined && !tab.incognito) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED',
              func: (id: string) => { window.dispatchEvent(new Event(`known-site-adapter-stop:${id}`)); }, args: [definition.adapterId] }).catch(() => undefined);
          }
          await reconcile(); if (d!.enabled) await injectOpen();
        }
        if (confirmSchema(raw)) { await siteTransport.confirm(d!.accountId!); await synchronizeSourceAuthority(await read(), siteLedger); disconnectAll(); await injectOpen(); }
        let archiveResult: unknown;
        if (archives.valid(raw)) archiveResult = await archives.handle(raw);
        if (semanticRetry(raw)) {
          const authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
          if (!authority?.connectionId) throw new Error('semanticJobUnavailable');
          const input = raw as { jobId: string; reclassify?: boolean };
          await semanticJobs.retry(input.jobId, authority.connectionId, input.reclassify); scheduleSourceWork(Date.now() + 50);
        }
        let inspectionStatus: unknown;
        if (retrySchema(raw)) await confirmations.retry();
        if (inspectSchema(raw)) {
          const q = raw as { operation: 'collections' | 'items' | 'resolve'; collectionId?: string; cursor?: string | null };
          inspectionStatus = await inspect(q.operation, q.collectionId, q.cursor);
        }
        const archiveStatus = await archives.status(statusSchema(raw) ? (raw as { reconcileOffset?: number }).reconcileOffset : 0);
        const archiveState = { ...archiveStatus, semantic: archiveStatus.config ? await semanticJobs.status(archiveStatus.config.connectionId) : null };
        const siteStatus = await siteTransport.status();
        let archiveHold: string | null = archiveState.hold;
        if (archiveState.config) try { await assertSourceRebound(siteLedger.db, archiveState.config.connectionId); } catch (e) { archiveHold = e instanceof Error ? e.message : 'sourceNeedsReview'; }
        const writes = !archiveHold && browserSupport().supported && siteStatus.enabled && siteStatus.connected && archiveState.config?.state === 'active' && await chrome.permissions.contains({ permissions: ['bookmarks'] });
        return { ...siteStatus, browser: browserSupport(), grants: { site: await chrome.permissions.contains(grants), bookmarks: await chrome.permissions.contains({ permissions: ['bookmarks'] }) },
          mode: writes ? 'localArchive' : 'inspector', writes, archiveHold, archive: archiveState, catalog: await catalogStatus(), ...(archiveResult ? { archiveResult } : {}), adapterId: definition.adapterId, features: siteFeatures(definition), capabilities: { itemIdentity: `${definition.siteKey}:${definition.identityVersion}`, observation: siteFeatures(definition).observe ? 'sourceObservations' : 'unavailable', humanActionProof: 'unavailable',
          negativeMembership: definition.negativeReadback ? 'available' : 'unavailable', shortLinks: 'unavailable', collectionChanges: siteFeatures(definition).collections ? 'explicitCatalogRead' : siteFeatures(definition).observe ? 'observedCatalog' : 'unavailable', nativeWrites: archiveState.config?.state === 'active' ? 'previewApprovalOrEnabledLivePolicy' : 'unavailable' },
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
            const context = await sourceContext(lease, siteLedger);
            const confirmed = await confirmations.accept(context, raw);
            const imported = !confirmed ? await archives.importer.accept(context, raw) : null;
            if (imported) { port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: imported }); return; }
            const inspected = confirmed || await acceptInspection(raw, context);
            port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: inspected ? { status: 'readResult', value: 'inspected' } : { status: 'rejected', reason: 'staleContext' } }); return;
          }
          if (raw.operation === 'membership.hint') {
            const receipt = await confirmations.enqueue(await sourceContext(lease, siteLedger), raw.requestId, raw.hint);
            port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: receipt });
            scheduleSourceWork(Date.now() + 50); return;
          }
          if (raw.operation === 'connect') { scheduleSourceWork(Date.now() + 50); port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: { status: 'readResult', value: 'connected' } }); return; }
          if (raw.operation === 'emit') {
            chrome.alarms.create(recoveryAlarm, { when: Date.now() + 30000 });
            const receipt = await siteLedger.acceptObservation(await sourceContext(lease, siteLedger), raw.requestId, raw.data);
            port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: receipt }); return;
          }
          // Optional capture/recipe operations require a separately implemented host capability.
          port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: { status: 'rejected', reason: 'paused' } });
        }).catch(() => { port.disconnect(); close(); }).finally(() => { pending--; });
      });
    });
    const navigated = (d: chrome.webNavigation.CommitDetails) => {
      if (d.frameId !== 0) return;
      if (definition.adapterId === legacySite.adapterId) void community.navigated(d.tabId).catch(() => undefined);
      void siteTransport.navigate(d.tabId, d.url).then(async relevant => {
        if (!relevant) return;
        await siteLedger.revokeDocuments(d.tabId);
        for (const [id, p] of ports) if (p.sender?.tab?.id === d.tabId) {
          p.disconnect(); ports.delete(id);
        }
        if ((await read()).enabled && await chrome.permissions.contains(grants) && matchesSiteUrl(definition, d.url))
          await chrome.scripting.executeScript({ target: { tabId: d.tabId }, world: 'ISOLATED', files: [definition.scripts.adapter] }).catch(() => undefined);
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
    chrome.tabs.onRemoved.addListener(id => { void siteTransport.removeTab(id).then(relevant => relevant ? siteLedger.revokeDocuments(id) : undefined).catch(() => undefined); });
    chrome.permissions.onRemoved.addListener(removed => {
      if (!removed.permissions?.some(p => grants.permissions.includes(p)) && !removed.origins?.some(o => grants.origins.includes(o) || o === '<all_urls>')) return;
      void siteTransport.invalidate().then(async () => { await synchronizeSourceAuthority(await read(), siteLedger); disconnectAll(); await reconcile(); }).catch(() => undefined);
    });
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === recoveryAlarm) void synchronizeSourceAuthorityFromCurrent().then(async () => { await wakeSourceWork(); }).catch(() => undefined); });
    chrome.runtime.onStartup.addListener(() => { void reconcile().then(async () => { await wakeSourceWork(); }).catch(() => undefined); });
    chrome.runtime.onInstalled.addListener(() => {
      void siteTransport.invalidate().then(async () => { disconnectAll(); await reconcile(); await injectOpen(); }).catch(() => undefined);
    });
    void reconcile().then(async () => { await wakeSourceWork(); }).catch(() => undefined);
  }

  async function synchronizeSourceAuthorityFromCurrent() { await synchronizeSourceAuthority(await read(), siteLedger); }

  return { definition, install: installHandlers, ready: trustedStorage, resolve, source: currentSiteSource,
    enqueue: (c: import('./ledger-types.js').SourceContext, id: string, hint: import('./contracts.js').MembershipHint) => confirmations.enqueue(c, id, hint),
    wake: () => scheduleSourceWork(Date.now() + 50) };
}
const hosts = bundledSites.map(createSiteHost);
const community = createCommunityRuntime({ ready: () => hosts[0]!.ready(),
  source: (tabId, adapterId = legacySite.adapterId) => hosts.find(h => h.definition.adapterId === adapterId)?.source(tabId) ?? Promise.resolve(null),
  enqueue: (c, id, hint) => { const host = hosts.find(h => h.definition.adapterId === (c.installationId ?? legacySite.adapterId));
    if (!host) throw new Error('adapterUnavailable'); return host.enqueue(c, id, hint); },
  wake: () => { for (const host of hosts) host.wake(); },
});
export function installSiteAdapters() {
  community.install(); installContentBindings(); installPlannedSaveRuntime(); installSourceLayout();
  installSemanticRuntime();
  installReconciliationRuntime();
  installSourceRecoveryScheduler(at => chrome.alarms.create(SITE_RECOVERY_ALARM, { when: at }));
  installContentResolver(async (url, tabId) => {
    for (const host of hosts) { const id = await host.resolve(url, tabId); if (id) return { siteKey: host.definition.siteKey, identityVersion: host.definition.identityVersion, itemId: id }; }
    return null;
  });
  if (__KNOWN_EXTENSION_EVIDENCE__) installSiteAdapterEvidence();
  for (const host of hosts) host.install();
}
