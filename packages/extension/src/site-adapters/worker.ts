import { retrySourceObservations } from './local-source-problems.js';
import { retryLocalTransfers } from './local-transfer-queue.js';
import { localSourceProgress } from './local-progress.js';
import { migrateLocalFirstBatch } from './local-first-migration.js';
import { refreshSharedCatalog } from './shared-catalog-runtime.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { flushLocalTransfers } from './local-transfer-runtime.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
import { selectReadLease } from './read-source.js';
import { siteFeatures, reconciliationCapability } from './capabilities.js';
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
import { get, put, rows } from './source-db.js';
import { flushManagedChanges } from './managed-change-runtime.js';
import { reconciliationRuns, installReconciliationRuntime, validReconcileRequest, handleReconcileRequest } from './reconcile-runtime.js';
import { installSiteAdapterEvidence } from './evidence.js';
import { installPlannedSaveRuntime, wakePlannedSaves, installSourceRecoveryScheduler } from './planned-runtime.js';
import { siteLedger as sharedLedger, synchronizeSourceAuthority, sourceContext, SITE_RECOVERY_ALARM } from './source-runtime.js';
import type { AdapterMessage, HostCommand } from './contracts.js';
import { validMembershipResult, validBootstrap } from './schemas.js';
import { createReadScheduler } from './read-scheduler.js';
import { readLimits } from './read-policy.js';
import { bundledSites, legacySite, loadingSites, setCommunitySites, type SiteDefinition } from './registry.js';
import { installationKey } from './installation.js';
import { createSourceLedger } from './ledger.js';
import { initialTransportState, createSiteTransport, SITE_PORT as BASE_PORT, SITE_STATE_KEY as BASE_STATE_KEY, type SiteSender, type TransportState, validSiteSender } from './transport.js';
import { object, literal, str } from './schema.js';
import { validAdapterMessage } from './schemas.js';
import { adapterBrowserSupport } from './browser-support.js';
import { handleRepairRequest, validRepairRequest } from './repair-runtime.js';
import { assertSourceRebound } from './portable.js';
import { createCommunityRuntime, validCommunityManagement } from './community-runtime.js';
import { installedSites } from './community-package.js';
import type { CommunityInstallation } from './community-state.js';
import { bundledDriver, communityDriver, createCommunityEvents, managementPage, type NavigationDetails, type SiteDriver } from './site-driver.js';
import { siteGrants } from './community-definition.js';
import { createSiteActivity, currentSiteProblem, activityCode, siteOperation, sourceActivityCounts } from './activity.js';
import { installSiteActivity } from './activity-runtime.js';
import { createLane } from '../automation/lane.js';
function createSiteHost(definition: SiteDefinition, driver: SiteDriver = bundledDriver(definition)) {
  const semanticRetry = object({ kind: literal('known.siteAdapters.semantic.retry'), jobId: str(128), reclassify: v => v === undefined || literal(true, false)(v) });
  const LIMITS = readLimits(definition);
  const siteLedger = createSourceLedger(sharedLedger.db, {}, definition);
  const { validCloudManagement, handleCloudManagement } = createCloudRuntime(definition);
  const SITE_STATE_KEY = installationKey(BASE_STATE_KEY, definition), SITE_PORT = installationKey(BASE_PORT, definition);
  const recoveryAlarm = installationKey(SITE_RECOVERY_ALARM, definition);
  const browserSupport = () => adapterBrowserSupport(navigator.userAgent);
  const activity = createSiteActivity(chrome.storage.local, definition,
    { extensionVersion: chrome.runtime.getManifest?.().version ?? 'unknown', browserMajor: browserSupport().major });
  installSiteActivity(definition, activity);
  const activityRequest = object({ kind: literal('known.siteAdapters.activity.list', 'known.siteAdapters.activity.report', 'known.siteAdapters.activity.dismiss'), id: v => v === undefined || str(128)(v) });
  const checkOperations = object({ kind: literal('known.siteAdapters.operations.check') });
  async function failed(raw: unknown, error: unknown) {
    const input = raw as { kind?: string; jobId?: string; id?: string } | null, operation = siteOperation(input?.kind ?? '');
    const code = error instanceof Error ? error.message : 'unavailable';
    const incident = await activity.record({ kind: 'problem', operation, code, action: input?.kind, taskId: input?.jobId ?? `management:${operation}` }).catch(() => undefined);
    return { error: incident?.code ?? activityCode(code), incidentId: incident?.id };
  }
  async function settledManagement(raw: unknown, result: unknown) {
    const response = result as { error?: string } | null;
    if (typeof response?.error === 'string') return { ...response, ...await failed(raw, new Error(response.error)) };
    const operation = siteOperation((raw as { kind: string }).kind);
    await activity.resolve(`management:${operation}`, operation).catch(() => undefined); return result;
  }
  const grants = siteGrants(definition);
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
    write: s => chrome.storage.local.set({ [SITE_STATE_KEY]: s }), permitted: async () => browserSupport().supported && await chrome.permissions.contains(grants) && await driver.available(),
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
    if (!browserSupport().supported || !validSiteSender(sender, chrome.runtime.id, definition) || !await chrome.permissions.contains(grants) || !await driver.available() || !(await read()).enabled) return false;
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
    if (error) await activity.record({ kind: 'problem', operation: 'inspect', taskId: 'inspection', requestId: message.requestId,
      code: error.code, httpStatus: error.httpStatus, sourceCode: error.sourceCode }).catch(() => undefined);
    else await activity.resolve('inspection', 'inspect').catch(() => undefined);
    await reads.finish(message.requestId, error?.retryAfterMs);
    return true;
  }
  const ports = new Map<string, chrome.runtime.Port>();
  let workTimer: ReturnType<typeof setTimeout> | undefined, workAt = Infinity, disposed = false;
  // Registration and disposal take turns, so a reconcile already running cannot re-register a retired package's world.
  const registration = createLane();
  function scheduleSourceWork(at: number) {
    if (disposed || workTimer && at >= workAt) return;
    workAt = at; clearTimeout(workTimer);
    scheduleSourceAlarm(at, recoveryAlarm);
    workTimer = setTimeout(() => { workAt = Infinity; workTimer = undefined; void wakeSourceWork().catch(() => undefined); }, Math.max(50, at - Date.now()));
  }
  async function currentSiteSource(tabId?: number, origin?: import('./ledger-types.js').SourceContext, readScope = definition.readScope) {
    const s = await read(), lease = selectReadLease({ readScope }, s.leases, id => ports.has(id), Date.now(), origin, tabId);
    return lease ? { context: await sourceContext(lease, siteLedger), expiresAt: lease.expiresAt } : null;
  }
  const sendSiteCommand = (c: import('./ledger-types.js').SourceContext, command: HostCommand) => {
    const port = ports.get(c.leaseId); if (!port) throw new Error('pageUnavailable'); port.postMessage(command);
  };
  let renewingLease: string | undefined;
  async function readableSiteSource(tabId?: number, origin?: import('./ledger-types.js').SourceContext, readScope = definition.readScope) {
    const source = await currentSiteSource(tabId, origin, readScope);
    if (!source) {
      const state = await read();
      const expired = selectReadLease({ readScope }, state.leases.filter(l => l.generation === state.generation && l.sourceGeneration === state.sourceGeneration
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
  const confirmations = createConfirmationQueue(siteLedger, reads, { activity, source: origin => readableSiteSource(undefined, origin), send: sendSiteCommand, alarm: scheduleSourceWork });
  // Import cursors belong to one document, even when individual account reads allow another tab.
  const archives = createSourceArchiveRuntime(reads, { activity, source: managementSource, readSource: origin => readableSiteSource(undefined, origin, 'document'), send: sendSiteCommand, alarm: scheduleSourceWork,
    reconciliation: { valid: validReconcileRequest, handle: handleReconcileRequest, status: reconciliationRuns.status, view: reconciliationRuns.view, cancel: reconciliationRuns.cancel },
    scope: currentCaptureScope,
    prioritizeLive: () => confirmations.wake(),
    catalog: async () => {
      const source = await currentSiteSource(), cache = (await chrome.storage.local.get(CATALOG))[CATALOG] as CatalogCache | undefined;
      if (!source || !cache || cache.context !== catalogContext(source.context) || cache.outstanding) throw new Error('refreshCatalogRequired');
      return cache.items;
    },
  }, siteLedger, definition);
  let working: Promise<void> | undefined, importing: Promise<unknown> | undefined, reconciling: Promise<unknown> | undefined, migrating: Promise<unknown> | undefined, workWanted = false;
  function wakeSourceWork(): Promise<void> {
    if (working) { workWanted = true; return working; }
    return working = (async () => {
      void flushManagedChanges().catch(() => undefined);
      void flushLocalTransfers().catch(() => undefined);
      migrating ??= captureDeviceId().then(deviceId => migrateLocalFirstBatch(siteLedger.db, { deviceId, lookup: async id => (await chrome.bookmarks.get(id).catch(() => []))[0] ?? null }))
        .then(more => { if (more) scheduleSourceWork(Date.now() + 100); }).catch(() => undefined).finally(() => { migrating = undefined; });
      if ((await read()).enabled) { void refreshSharedCatalog().catch(() => undefined); await confirmations.wake(); await archives.live.wake(); }
      await wakePlannedSaves();
      importing ??= archives.importer.wake().catch(() => undefined).finally(() => { importing = undefined; });
      reconciling ??= reconciliationRuns.wake().catch(() => undefined).finally(() => { reconciling = undefined; });
      const importJob = await archives.importer.status();
      if (importJob?.preview?.id && importJob.phase === 'attention' && importJob.reason === 'sourceReviewRequired') {
        const run = await reconciliationRuns.view(importJob.preview.id);
        if (run?.state === 'completed') {
          const reviews = await siteLedger.db.transaction(['importPages'], 'readonly', tx => rows<{ reviewReason?: string }>(tx, 'importPages', 'frozenEdge', importJob.preview!.id));
          if (reviews.every(r => !r.reviewReason || ['sourceReconcileCandidate', 'suppressed', 'policySkipped', 'copyPolicyMigrationRequired'].includes(r.reviewReason))) {
            const completed = await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
              const key = `importJob:${importJob.id}`, current = await get<import('./import-coordinator.js').ImportJob>(tx, 'meta', key);
              if (current?.phase !== 'attention' || current.previewId !== importJob.preview!.id || current.reason !== 'sourceReviewRequired') return false;
              put(tx, 'meta', key, { ...current, phase: 'completed', reason: 'reconciledWithExceptions' }); return true;
            });
            if (completed) {
              await activity.resolve(importJob.id, 'save').catch(() => undefined);
              await activity.record({ kind: 'saved', operation: 'save', taskId: importJob.id, phase: 'completed',
                connectionId: importJob.context.connectionId, counts: sourceActivityCounts(importJob) }).catch(() => undefined);
            }
          }
        }
      }
      const authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
      if (authority?.connectionId && await enqueueSourceSemantics(authority.connectionId)) scheduleSourceWork(Date.now() + 100);
      void semanticJobs.wake().catch(() => undefined);
    })().finally(() => { working = undefined; if (workWanted) { workWanted = false; scheduleSourceWork(Date.now() + 50); } });
  }
  function disconnectAll() { for (const [id, p] of ports) { try { p.postMessage({ operation: 'shutdown', leaseId: id }); p.disconnect(); } catch { /* gone */ } } ports.clear(); }
  const management = managementPage;
  async function injectOpen() {
    for (const tab of await chrome.tabs.query({ url: [...definition.matches] })) {
      if (tab.id !== undefined && !tab.incognito) await driver.inject(tab.id, true);
    }
  }
  async function stopOpen() {
    for (const tab of await chrome.tabs.query({ url: [...definition.matches] })) if (tab.id !== undefined && !tab.incognito) await driver.stop(tab.id);
  }
  function reconcile() { return registration(async () => {
    if (disposed) return;
    const openTabs = (await chrome.tabs.query({})).flatMap(tab => tab.id === undefined ? [] : [tab.id]);
    for (const id of await siteTransport.pruneTabs(openTabs)) await siteLedger.revokeDocuments(id);
    let s = await read(); const granted = browserSupport().supported && await chrome.permissions.contains(grants) && await driver.available();
    if (s.enabled && !granted) { await siteTransport.invalidate(); s = await read(); }
    await synchronizeSourceAuthority(s, siteLedger);
    await driver.register(s.enabled && granted);
  }); }
  const statusSchema = object({ kind: literal('known.siteAdapters.status'), reconcileOffset: v => v === undefined || Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 200000 && Number(v) % 100 === 0 });
  const enableSchema = object({ kind: literal('known.siteAdapters.enable'), enabled: literal(true, false) });
  const inspectSchema = object({ kind: literal('known.siteAdapters.inspect'), operation: literal('collections', 'items', 'resolve'), collectionId: v => v === undefined || definition.validateCollection(v), cursor: v => v === undefined || v === null || str(512)(v) });
  const retrySchema = object({ kind: literal('known.siteAdapters.retryConfirmation') });
  const confirmSchema = object({ kind: literal('known.siteAdapters.confirm'), accountId: str(128) });
  const reconnectSchema = object({ kind: literal('known.siteAdapters.reconnect') });
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
    driver.events.message((raw, sender, respond, channel) => {
      const addressed = raw as { adapterId?: string; request?: { adapterId?: string } } | null;
      const target = addressed?.request?.adapterId ?? addressed?.adapterId ?? legacySite.adapterId;
      if (target !== definition.adapterId) return false;
      if (addressed?.adapterId) { const { adapterId: _adapter, ...body } = raw as Record<string, unknown>; raw = body; }
      const d = raw as { kind?: string; request?: unknown; enabled?: boolean; accountId?: string } | null;
      if (d?.kind === 'known.siteAdapters.activation') {
        if (channel !== driver.page || !object({ kind: literal('known.siteAdapters.activation'), adapterId: v => v === undefined || v === definition.adapterId,
          installationCredential: v => v === undefined || str(256)(v) })(raw)) return false;
        void (async () => {
          await trustedStorage(); if (!await senderCurrent(sender)) return { status: 'unavailable', retryAfterMs: 500 };
          if (driver.page === 'userScript' && !await driver.credential((raw as { installationCredential?: string }).installationCredential)) return { status: 'unavailable' };
          const id = crypto.randomUUID();
          const slot = await activation.acquire({ id, documentId: sender.documentId!, deadlineAt: Date.now() + LIMITS.activationMs }, true);
          return slot.status === 'ready' ? { status: 'ready', activationId: slot.id, deadlineAt: slot.deadlineAt } : slot;
        })().then(respond, () => respond({ status: 'unavailable' })); return true;
      }
      if (d?.kind === 'known.siteAdapters.bootstrap') {
        if (channel !== driver.page || !object({ kind: literal('known.siteAdapters.bootstrap'), request: () => true })(raw)) return false;
        void (async () => {
          if (!validBootstrap(d.request) || d.request.runtime !== (definition.runtime ?? 'bundled')) return { status: 'unavailable', reason: 'version' };
          if (d.request.runtime === 'userScript' && !await driver.credential(d.request.installationCredential)) return { status: 'unavailable', reason: 'disabled' };
          const slot = (await activation.current()).active;
          if (!slot || slot.id !== d.request.activationId || slot.documentId !== sender.documentId || slot.deadlineAt <= Date.now() || !await senderCurrent(sender))
            return { status: 'unavailable', reason: 'disabled' };
          await activation.finish(slot.id);
          const reply = await siteTransport.bootstrap(d.request, sender);
          // An update can replace the credential while this request was in flight; its lease must not outlive the check.
          if (reply.status === 'ready' && d.request.runtime === 'userScript' && (disposed || !await driver.credential(d.request.installationCredential))) {
            await siteTransport.retire(reply.leaseId); return { status: 'unavailable', reason: 'disabled' };
          }
          await synchronizeSourceAuthority(await read(), siteLedger);
          if (reply.status === 'ready') {
            const s = await read(), lease = s.leases.find(l => l.id === reply.leaseId);
            if (!lease) return { status: 'unavailable', reason: 'disabled' };
            await siteLedger.bindLease(await sourceContext(lease, siteLedger), lease.expiresAt);
          }
          return reply;
        })().then(respond, () => respond({ status: 'unavailable', reason: 'disabled' })); return true;
      }
      // Page code speaks only activation and bootstrap here; everything else comes from extension pages.
      if (channel !== 'runtime') return false;
      if (validContentRequest(raw) || validDestinationRequest(raw)) {
        const path = sender.url && new URL(sender.url).pathname;
        if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) || !['/popup.html', '/site-adapters.html'].includes(path || '')) return false;
        void (validDestinationRequest(raw) ? handleDestinationRequest(raw) : handleContentRequest(raw, definition)).then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : 'unavailable' })); return true;
      }
      // The legacy cloud archive needs a server-side identity codec, which installed packages do not have.
      if (management(sender) && definition.runtime !== 'userScript' && validCloudManagement(raw)) {
        void handleCloudManagement(raw).then(result => settledManagement(raw, result)).then(respond, async e => respond({ ok: false, ...await failed(raw, e) })); return true;
      }
      if (management(sender) && validRepairRequest(raw)) {
        void handleRepairRequest(raw, definition).then(result => settledManagement(raw, result)).then(respond, async e => respond({ ok: false, ...await failed(raw, e) })); return true;
      }
      if (management(sender) && activityRequest(raw)) {
        void (async () => { await trustedStorage(); const r = raw as { kind: string; id?: string };
          if (r.kind.endsWith('.dismiss')) { if (!r.id) throw new Error('activityMissing'); await activity.dismiss(r.id); return { dismissed: true }; }
          return r.kind.endsWith('.list') ? { events: await activity.list() } : { report: await activity.report(r.id) };
        })().then(respond, async e => respond(await failed(raw, e))); return true;
      }
      if (management(sender) && checkOperations(raw)) {
        void trustedStorage().then(async () => {
          const authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
          if (authority?.enabled && authority.connectionId) {
            await retryLocalTransfers(siteLedger.db, authority.connectionId); await retrySourceObservations(siteLedger.db, authority.connectionId);
          }
          scheduleSourceWork(Date.now() + 50); await wakePlannedSaves(); return { checked: true };
        })
          .then(result => settledManagement(raw, result)).then(respond, async e => respond(await failed(raw, e))); return true;
      }
      if (!management(sender) || !(statusSchema(raw) || enableSchema(raw) || confirmSchema(raw) || reconnectSchema(raw) || inspectSchema(raw) || retrySchema(raw) || semanticRetry(raw) || archives.valid(raw))) return false;
      void (async () => {
        if (!browserSupport().supported && !statusSchema(raw) && !(enableSchema(raw) && !d!.enabled)) throw new Error('browserUnsupported');
        if (enableSchema(raw)) {
          if (d!.enabled && !await chrome.permissions.contains(grants)) throw new Error('permissionRequired');
          if (d!.enabled && !await driver.available()) throw new Error('communityToggleRequired');
          await siteTransport.configure(d!.enabled!); await synchronizeSourceAuthority(await read(), siteLedger); disconnectAll();
          if (!d!.enabled && await chrome.permissions.contains(grants)) await stopOpen();
          await reconcile(); if (d!.enabled) await injectOpen();
        }
        if (confirmSchema(raw)) { await siteTransport.confirm(d!.accountId!); await synchronizeSourceAuthority(await read(), siteLedger); disconnectAll(); await injectOpen(); }
        if (reconnectSchema(raw)) {
          if (!await chrome.permissions.contains(grants)) throw new Error('permissionRequired');
          if (!await managementSource()) throw new Error((await read()).sourceUnresolved ? 'sourceUnresolved' : 'pageUnavailable');
          scheduleSourceWork(Date.now() + 100);
        }
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
        if (!statusSchema(raw)) {
          const operation = siteOperation(d?.kind ?? '');
          await activity.resolve(`management:${operation}`, operation).catch(() => undefined);
          if (operation === 'configure' || operation === 'connect') await activity.record({ kind: 'configured', operation }).catch(() => undefined);
        }
        const archiveStatus = await archives.status(statusSchema(raw) ? (raw as { reconcileOffset?: number }).reconcileOffset : 0);
        const archiveState = { ...archiveStatus, semantic: archiveStatus.config ? await semanticJobs.status(archiveStatus.config.connectionId) : null };
        const siteStatus = await siteTransport.status();
        const documents = (await read()).leases.filter(lease => lease.expiresAt > Date.now() && ports.has(lease.id)).length;
        let archiveHold: string | null = archiveState.hold;
        if (archiveState.config) try { await assertSourceRebound(siteLedger.db, archiveState.config.connectionId); } catch (e) { archiveHold = e instanceof Error ? e.message : 'sourceNeedsReview'; }
        const writes = !archiveHold && browserSupport().supported && siteStatus.enabled && siteStatus.connected && archiveState.config?.state === 'active' && await chrome.permissions.contains({ permissions: ['bookmarks'] });
        if (statusSchema(raw)) await activity.resolve('management:status', 'status').catch(() => undefined);
        const events = await activity.list().catch(() => []);
        const problem = currentSiteProblem(events, { connectionId: archiveState.config?.connectionId, taskId: archiveState.import?.id, phase: archiveState.import?.phase });
        return { ...siteStatus, documents, browser: browserSupport(), grants: { site: await chrome.permissions.contains(grants), bookmarks: await chrome.permissions.contains({ permissions: ['bookmarks'] }),
          ...(definition.runtime === 'userScript' ? { userScripts: await driver.available() } : {}) },
          mode: writes ? 'localArchive' : 'inspector', writes, archiveHold, pipeline: await localSourceProgress(siteLedger.db, archiveState.config?.connectionId), activity: { problem, lastEvent: events[0] ?? null }, archive: archiveState, catalog: await catalogStatus(), ...(archiveResult ? { archiveResult } : {}), adapterId: definition.adapterId, features: siteFeatures(definition), capabilities: { itemIdentity: `${definition.siteKey}:${definition.identityVersion}`, observation: siteFeatures(definition).observe ? 'sourceObservations' : 'unavailable', humanActionProof: 'unavailable',
          negativeMembership: definition.negativeReadback ? 'available' : 'unavailable', reconciliation: reconciliationCapability(definition), collectionHierarchy: 'flat', shortLinks: 'unavailable', collectionChanges: siteFeatures(definition).collections ? 'explicitCatalogRead' : siteFeatures(definition).observe ? 'observedCatalog' : 'unavailable', nativeWrites: archiveState.config?.state === 'active' ? 'previewApprovalOrEnabledLivePolicy' : 'unavailable' },
        confirmations: await confirmations.status(), ...(inspectionStatus ? { inspectionStatus } : {}), inspection: (await chrome.storage.local.get(INSPECTION))[INSPECTION] ?? null };
      })().then(respond, async e => respond(await failed(raw, e))); return true;
    });
    driver.events.connect(port => {
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
            if (receipt.status === 'rejected') await activity.record({ kind: 'problem', operation: 'inspect',
              taskId: raw.hint.interactionId, requestId: raw.requestId, code: receipt.reason, connectionId: (await sourceContext(lease, siteLedger)).connectionId });
            port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: receipt });
            scheduleSourceWork(Date.now() + 50); return;
          }
          if (raw.operation === 'connect') { scheduleSourceWork(Date.now() + 50); port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: { status: 'readResult', value: 'connected' } }); return; }
          if (raw.operation === 'emit') {
            scheduleSourceAlarm(Date.now() + 30000, recoveryAlarm);
            const receipt = await siteLedger.acceptObservation(await sourceContext(lease, siteLedger), raw.requestId, raw.data);
            port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: receipt });
            // The alarm above only recovers a worker that stops; an accepted live save is planned now, like a hint.
            if (receipt.status !== 'rejected') scheduleSourceWork(Date.now() + 50);
            return;
          }
          // Optional capture/recipe operations require a separately implemented host capability.
          port.postMessage({ operation: 'reply', requestId: raw.requestId, reply: { status: 'rejected', reason: 'paused' } });
        }).catch(() => { port.disconnect(); close(); }).finally(() => { pending--; });
      });
    });
    const navigated = (d: NavigationDetails) => {
      if (d.frameId !== 0) return;
      void siteTransport.navigate(d.tabId, d.url, d.documentId).then(async relevant => {
        if (!relevant) return;
        await siteLedger.revokeDocuments(d.tabId);
        for (const [id, p] of ports) if (p.sender?.tab?.id === d.tabId) {
          p.disconnect(); ports.delete(id);
        }
        if ((await read()).enabled && await chrome.permissions.contains(grants) && matchesSiteUrl(definition, d.url)) await driver.inject(d.tabId, false, d.documentId);
      }).catch(() => undefined);
    };
    driver.events.navigation(navigated);
    driver.events.storage((changes, area) => { if (area === 'local' && changes[AUTOMATION_CHANGED_KEY] || Object.keys(changes).some(key => key.startsWith('known.auth.') || key.startsWith('known.personal-sync.') || key === 'known.sync.collection.v1')) scheduleSourceWork(Date.now() + 50); });
    driver.events.permissionsAdded(() => { void reconcile().catch(() => undefined); });
    driver.events.tabRemoved(id => { void siteTransport.removeTab(id).then(relevant => relevant ? siteLedger.revokeDocuments(id) : undefined).catch(() => undefined); });
    driver.events.permissionsRemoved(removed => {
      if (!removed.permissions?.some(p => grants.permissions.includes(p)) && !removed.origins?.some(o => grants.origins.includes(o) || o === '<all_urls>')) return;
      void siteTransport.invalidate().then(async () => { await synchronizeSourceAuthority(await read(), siteLedger); disconnectAll(); await reconcile(); }).catch(() => undefined);
    });
    driver.events.alarm(alarm => { if (alarm.name === recoveryAlarm) void synchronizeSourceAuthorityFromCurrent().then(async () => { await wakeSourceWork(); }).catch(() => undefined); });
    driver.events.startup(() => { void reconcile().then(async () => { await wakeSourceWork(); }).catch(() => undefined); });
    driver.events.installed(() => {
      void siteTransport.invalidate().then(async () => { disconnectAll(); await reconcile(); await injectOpen(); }).catch(() => undefined);
    });
    started = reconcile();
    void started.then(async () => { await wakeSourceWork(); }).catch(() => undefined);
  }
  let started: Promise<void> = Promise.resolve();

  async function synchronizeSourceAuthorityFromCurrent() { await synchronizeSourceAuthority(await read(), siteLedger); }
  /** Retires an installed package's host: before new bytes take over its site, or for good once the package is removed. */
  function dispose(removed: boolean) {
    disposed = true; clearTimeout(workTimer); workTimer = undefined;
    return registration(async () => {
      await chrome.alarms.clear(recoveryAlarm).catch(() => undefined);
      if (removed) await siteTransport.configure(false); else await siteTransport.invalidate();
      await synchronizeSourceAuthority(await read(), siteLedger);
      disconnectAll(); await stopOpen().catch(() => undefined);
      if (removed) await driver.unregister();
    });
  }

  return { definition, install: installHandlers, ready: trustedStorage, resolve, source: currentSiteSource,
    enqueue: (c: import('./ledger-types.js').SourceContext, id: string, hint: import('./contracts.js').MembershipHint) => confirmations.enqueue(c, id, hint),
    wakeAt: scheduleSourceWork, wake: () => scheduleSourceWork(Date.now() + 50), dispose,
    /** Open pages pick up a replaced package once its new world is registered. */
    attach: () => started.then(async () => { if ((await read()).enabled) await injectOpen(); }) };
}
const hosts = bundledSites.map(definition => createSiteHost(definition));
type SiteHost = ReturnType<typeof createSiteHost>;
const communityHosts = new Map<string, { host: SiteHost; dispose(): void; row: CommunityInstallation }>(), communityLane = createLane();
let communityLoaded: Promise<void> = Promise.resolve(), communityStarted: Promise<void> = Promise.resolve();
const communityEvents = createCommunityEvents(() => communityLoaded);
/** Brings package hosts in line with what is installed: new bytes get a new host and world, a removed package's site is turned off. */
function refreshCommunity(): Promise<void> {
  return communityLoaded = communityLane(async () => {
    await hosts[0]!.ready();
    const rows = await community.prepare(), sites = installedSites(rows);
    setCommunitySites(sites.map(s => s.definition));
    const replaced = new Set<string>();
    for (const [adapterId, current] of communityHosts) {
      const next = sites.find(s => s.definition.adapterId === adapterId)?.row;
      if (next && next.id === current.row.id && next.generation === current.row.generation && next.approved.digest === current.row.approved.digest) continue;
      current.dispose(); communityHosts.delete(adapterId); if (next) replaced.add(adapterId);
      await current.host.dispose(!next).catch(() => undefined);
    }
    for (const { row, definition } of sites) {
      if (communityHosts.has(definition.adapterId)) continue;
      const scope = communityEvents.scope(), host = createSiteHost(definition, communityDriver(row, definition, scope.events));
      communityHosts.set(definition.adapterId, { host, dispose: scope.dispose, row }); host.install();
      if (replaced.has(definition.adapterId)) void host.attach().catch(() => undefined);
    }
    void community.prune(rows).catch(() => undefined);
  });
}
const community = createCommunityRuntime({ ready: () => hosts[0]!.ready(), changed: refreshCommunity });
const siteHosts = () => [...hosts, ...[...communityHosts.values()].map(c => c.host)];
export function installSiteAdapters() {
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    if (!managementPage(sender) || !validCommunityManagement(raw)) return false;
    void community.management(raw).then(respond, e => respond({ ok: false, error: e instanceof Error ? e.message : 'unavailable' })); return true;
  });
  communityEvents.install(); communityStarted = refreshCommunity().catch(() => undefined); loadingSites(communityStarted);
  installContentBindings(); installPlannedSaveRuntime(); installSourceLayout();
  installSemanticRuntime();
  installReconciliationRuntime();
  installSourceRecoveryScheduler(at => hosts[0]!.wakeAt(at));
  installContentResolver(async (url, tabId) => {
    await communityStarted;
    for (const host of siteHosts()) {
      if (!host.definition.capabilities.includes('resolveItem')) continue; // Not every site, bundled or installed, can name the item a page shows.
      const id = await host.resolve(url, tabId); if (id) return { siteKey: host.definition.siteKey, identityVersion: host.definition.identityVersion, itemId: id };
    }
    return null;
  });
  if (__KNOWN_EXTENSION_EVIDENCE__) installSiteAdapterEvidence();
  for (const host of hosts) host.install();
}
