import { siteGrants } from '../site-adapters/community-definition.js';
import type { SourceAuthority } from '../site-adapters/ledger-types.js';
import { DEVICE_BRIDGE_KEY, DEVICE_BRIDGE_STATUS_KEY, createDeviceBridgeRunner, isCaptureBridgeOperation, type BrowserRequest } from '../automation/device-bridge.js';
import { deviceResultPage } from '../automation/device-bridge-result.js';
import { fetchDeviceRequests, completeDeviceRequest, type DeviceAuthority, type DeviceBridgeAuthority } from '../automation/device-client.js';
import { automationDatabase } from '../automation/indexeddb-store.js';
import { automationOwnerKey } from '../automation/bundle-store.js';
import { createRuntimeAuth, currentSyncScope, loadConfig } from './scope.js';
import { siteLedger } from '../site-adapters/source-runtime.js';
import { semanticJobs } from '../site-adapters/semantic-runtime.js';
import type { SemanticJob } from '../site-adapters/semantic-jobs.js';
import { allSites, sitesLoaded } from '../site-adapters/registry.js';
import { localClassificationEnabled } from '../classification-local-session.js';
import { runLocalClassification } from './classification-local.js';
import { classificationDocument } from '../classification-intent.js';
import { extensionOrigin, store, workCoordinator } from './runtime.js';
import { managedDestinations } from '../site-adapters/managed-destinations.js';
import { iterateCursor } from '../sync-state/idb.js';

/** A separate installation channel: a paused or broken Sync session cannot
 * prevent an explicitly enabled agent from diagnosing this browser. */
export async function refreshDeviceBridge(): Promise<void> {
  const ownerKey = (await chrome.storage.local.get(DEVICE_BRIDGE_KEY))[DEVICE_BRIDGE_KEY];
  if (typeof ownerKey !== 'string') return;
  let code: string | null = null;
  try {
    const credential = await createRuntimeAuth(await loadConfig()).ensureFreshCredential();
    const scope = await currentSyncScope({ allowStopped: true });
    if (automationOwnerKey({ serverOrigin: credential.serverOrigin, accountId: credential.subject! }) !== ownerKey) return;
    const proof = await store.loadReplicaReportProof(scope);
    if (!proof) throw Error('device_proof_unavailable');
    const authority = await store.fence.capture();
    const isCurrent = async () => {
      await store.fence.assertWritable(authority.generation);
      const current = await currentSyncScope({ allowStopped: true });
      return current.serverOrigin === scope.serverOrigin && current.accountId === scope.accountId && current.replicaId === scope.replicaId
        && current.collectionId === scope.collectionId && current.generation === scope.generation;
    };
    await pollDeviceBridge({ serverOrigin: credential.serverOrigin, accessToken: credential.accessToken,
      origin: extensionOrigin(), replicaId: scope.replicaId, replicaProof: proof }, isCurrent);
  } catch (error) { code = error instanceof Error && /^[a-zA-Z0-9_]{1,80}$/u.test(error.message) ? error.message : 'bridge_unavailable'; }
  if ((await chrome.storage.local.get(DEVICE_BRIDGE_KEY))[DEVICE_BRIDGE_KEY] === ownerKey)
    await chrome.storage.local.set({ [DEVICE_BRIDGE_STATUS_KEY]: { ownerKey, at: Date.now(), code } });
}

export async function pollDeviceBridge(device: DeviceAuthority | DeviceBridgeAuthority, isCurrent: () => Promise<boolean>): Promise<void> {
  const scope = await currentSyncScope({ allowStopped: true }); if (!scope) return;
  const enabled = async () => (await chrome.storage.local.get(DEVICE_BRIDGE_KEY))[DEVICE_BRIDGE_KEY] === automationOwnerKey({ serverOrigin: scope.serverOrigin, accountId: scope.accountId });
  const authorize = async (request: BrowserRequest) => {
    if (!await isCurrent() || !await enabled()) throw new Error('device_bridge_disabled');
    const current = await currentSyncScope({ allowStopped: true });
    if (!current || current.replicaId !== scope.replicaId || current.accountId !== scope.accountId || current.serverOrigin !== scope.serverOrigin
      || current.generation !== scope.generation || request.replicaId !== scope.replicaId || request.collectionId !== scope.collectionId) throw new Error('device_scope_changed');
  };
  await automationDatabase().pruneDeviceRequests(Date.now());
  const response = await fetchDeviceRequests(device);
  if (!response.ok) throw new Error(`bridge_${response.problem}`);
  if (!response.body || typeof response.body !== 'object') throw new Error('device_request_invalid');
  const requests = (response.body as { items?: unknown }).items;
  if (!Array.isArray(requests) || requests.length > 8 || requests.some(r => !r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.replicaId !== 'string' || typeof r.collectionId !== 'string' || typeof r.operation !== 'string' || typeof r.expiresAt !== 'string' || !r.input || typeof r.input !== 'object')) throw new Error('device_request_invalid');
  const adapterStatus = async () => {
    await sitesLoaded();
    return Promise.all(allSites().map(async site => {
      const [authority, granted] = await Promise.all([
        siteLedger.db.read<SourceAuthority>('authorities', site.adapterId),
        chrome.permissions.contains(siteGrants(site)),
      ]);
      return { id: site.adapterId, name: site.label, siteKey: site.siteKey, enabled: authority?.enabled ?? false,
        connected: !!authority?.connectionId, connectionId: authority?.connectionId ?? null, permissionGranted: granted,
        collectionHierarchy: site.collectionHierarchy ?? 'flat', membershipModel: site.membershipModel ?? 'set' };
    }));
  };
  const inScope = (job: SemanticJob) => job.scope?.accountId === scope.accountId && job.scope.serverOrigin === scope.serverOrigin && job.scope.collectionId === scope.collectionId;
  const job = async (request: BrowserRequest) => {
    const value = await siteLedger.db.read<SemanticJob>('semanticJobs', request.input.jobId ?? '');
    if (!value || !inScope(value)) throw new Error('semanticJobUnavailable'); return value;
  };
  const area = automationDatabase().area(), ownerKey = automationOwnerKey({ serverOrigin: scope.serverOrigin, accountId: scope.accountId });
  const scopedArea = {
    async get(key: string) { const row = await area.get(key) as { ownerKey: string; entry: unknown } | undefined; return row?.ownerKey === ownerKey ? row.entry : undefined; },
    set: (key: string, entry: unknown) => area.set(key, { ownerKey, entry, retainUntil: Date.now()+30*86400000 }),
  };
  await createDeviceBridgeRunner(scopedArea, {
    authorize,
    async execute(request) {
      await authorize(request);
      if (isCaptureBridgeOperation(request)) return (await import('./device-bridge-classification.js'))
        .handleCaptureBridge(request, scope, () => authorize(request));
      if (request.operation === 'adapters.status') {
        return { sites: await adapterStatus(),
          classificationEnabled: await localClassificationEnabled() };
      }
      if (request.operation === 'classification.diagnostics' || request.operation === 'adapters.diagnostics' || request.operation === 'adapters.jobs') {
        const jobs: SemanticJob[] = [];
        await siteLedger.db.transaction(['semanticJobs'], 'readonly', async tx => {
          await iterateCursor(tx.objectStore('semanticJobs'), null, value => {
            const valueJob = value as SemanticJob;
            if (inScope(valueJob) && (!request.input.connectionId || valueJob.connections.includes(request.input.connectionId))) jobs.push(valueJob);
          });
        });
        const group = request.input.group ?? 'recovery', states = group === 'recovery' ? ['attention', 'pending'] : ['suppressed', 'completed'];
        jobs.sort((a,b) => states.indexOf(a.state)-states.indexOf(b.state) || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
        const visible = jobs.filter(j => states.includes(j.state));
        let offset = 0;
        if (request.input.cursor) { offset = visible.findIndex(j => j.id === request.input.cursor) + 1; if (!offset) throw new Error('invalid_cursor'); }
        return deviceResultPage(request.id, visible.slice(offset).map(j => ({ id: j.id, title: j.title, state: j.state, reason: j.reason,
          connections: j.connections, retryable: ['attention','pending'].includes(j.state) })), {
          ...(request.operation === 'adapters.diagnostics' ? { sites: (await adapterStatus()).filter(s => s.connectionId === request.input.connectionId) } : {}),
          classificationEnabled: await localClassificationEnabled(), counts: { attention: jobs.filter(j => j.state === 'attention').length,
            pending: jobs.filter(j => j.state === 'pending').length, history: jobs.filter(j => ['completed','suppressed'].includes(j.state)).length } });
      }
      const value = await job(request);
      if (request.operation === 'adapters.retry' || request.operation === 'classification.retry') {
        await semanticJobs.retry(value.id, value.connections[0]!, request.operation === 'classification.retry' && !value.command); return { jobId: value.id, scheduled: true };
      }
      if (request.operation === 'classification.preview') {
        if (!await localClassificationEnabled()) throw new Error('local_key_required');
        const mounts = await managedDestinations(siteLedger.db);
        return workCoordinator.run('local-classification', async context => {
          await authorize(request);
          const reply = await runLocalClassification({ document: classificationDocument(value, { folder: true, tags: false }), commandId: `bridge:${request.id}`,
            generation: context.generation, signal: context.signal, excludedFolderIds: mounts.map(m => m.root.nativeId), assertCurrent: () => authorize(request) });
          if (!reply.ok) throw new Error(reply.error);
          return { jobId: value.id, preview: reply.result };
        });
      }
      throw new Error('device_operation_unsupported');
    },
    async complete(result) {
      const reply = await completeDeviceRequest(device,result);
      return reply.ok ? 'accepted' : reply.status === 413 ? 'tooLarge' : reply.status === 400 || reply.status === 422 ? 'rejected' : 'retry';
    },
  })(requests);
}
