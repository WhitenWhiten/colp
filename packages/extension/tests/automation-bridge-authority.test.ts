import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { DEVICE_BRIDGE_KEY } from '../src/automation/device-bridge.js';
import { automationOwnerKey } from '../src/automation/bundle-store.js';
import { automationRefreshProblem } from '../src/automation/refresh-problem.js';
const f = vi.hoisted(() => ({ scope: { serverOrigin: 'https://server.test', accountId: 'owner', collectionId: 'library', replicaId: 'replica', generation: 1 },
  scopeRead: vi.fn(), fetch: vi.fn(async () => ({ ok: true, body: { items: [] } })), proof: vi.fn(async () => 'installation-proof') }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: f.scopeRead, loadConfig: async () => ({}), createRuntimeAuth: () => ({
  ensureFreshCredential: async () => ({ subject: 'owner', serverOrigin: 'https://server.test', accessToken: 'credential' }) }) }));
vi.mock('../src/sw/runtime.js', () => ({ extensionOrigin: () => 'chrome-extension://browser', workCoordinator: {},
  store: { loadReplicaReportProof: f.proof, fence: { capture: async () => ({ generation: 1 }), assertWritable: async () => {} } } }));
vi.mock('../src/automation/device-client.js', () => ({ fetchDeviceRequests: f.fetch, completeDeviceRequest: vi.fn() }));
vi.mock('../src/automation/indexeddb-store.js', () => ({ automationDatabase: () => ({ pruneDeviceRequests: async () => {}, area: () => ({}) }) }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { db: {} } }));
vi.mock('../src/site-adapters/semantic-runtime.js', () => ({ semanticJobs: {} }));
import { refreshDeviceBridge } from '../src/sw/device-bridge.js';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

test('an enabled bridge uses installation proof while personal sync is stopped, without minting a session', async () => {
  const storage = new MemoryStorageArea();
  await storage.set({ [DEVICE_BRIDGE_KEY]: automationOwnerKey(f.scope) });
  vi.stubGlobal('chrome', { storage: { local: storage } });
  f.scopeRead.mockImplementation(async options => { if (!options?.allowStopped) throw Error('personal_sync_stopped'); return f.scope; });
  await refreshDeviceBridge();
  expect(f.fetch).toHaveBeenCalledWith({ serverOrigin: f.scope.serverOrigin, accessToken: 'credential', origin: 'chrome-extension://browser',
    replicaId: f.scope.replicaId, replicaProof: 'installation-proof' });
  expect(f.scopeRead).toHaveBeenCalledWith({ allowStopped: true });
});

test.each([['personal_sync_stopped', 'syncPaused'], ['offline', 'offline'], ['server_configuration_failed', 'permission'],
  ['authentication_required', 'signedOut'], ['server_unavailable', 'server']])('refresh failure %s retains its actual cause', (code, problem) => {
  expect(automationRefreshProblem(Error(code))).toBe(problem);
});
