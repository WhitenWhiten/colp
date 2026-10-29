import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import type { SemanticJob, SemanticPorts } from '../src/site-adapters/semantic-jobs.js';
const f = vi.hoisted(() => ({ db: undefined as unknown as ReturnType<typeof createSourceDatabase>, ports: undefined as unknown as SemanticPorts,
  paused: vi.fn(async () => true), classify: vi.fn() }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return f.db; } }, SITE_RECOVERY_ALARM: 'site' }));
vi.mock('../src/site-adapters/semantic-jobs.js', async original => ({ ...await original<object>(), createSemanticJobs: (_db: unknown, ports: SemanticPorts) => { f.ports = ports; return {}; } }));
vi.mock('../src/sw/automation.js', () => ({ sourceAutomationsPaused: f.paused }));
vi.mock('../src/site-adapters/semantic-associations.js', () => ({ semanticContext: vi.fn(), scopedSemanticBindings: vi.fn(), attachSemanticAssociation: vi.fn(), importSharedSemantic: vi.fn() }));
vi.mock('../src/site-adapters/local-save-runtime.js', () => ({ prepareLocalSlot: vi.fn(), rememberLocalSourceSave: vi.fn() }));
vi.mock('../src/site-adapters/local-reuse-runtime.js', () => ({ executeLocalSave: vi.fn(), recoverLocalSave: vi.fn() }));
vi.mock('../src/site-adapters/managed-runtime.js', () => ({ managedSaves: {}, managedClientForLibrary: vi.fn(), projectManagedBinding: vi.fn() }));
vi.mock('../src/site-adapters/content-runtime.js', () => ({ assertContentNative: vi.fn() }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/capture-native.js', () => ({ assertCaptureScope: vi.fn() }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: vi.fn() }));
vi.mock('../src/sw/runtime.js', () => ({ workCoordinator: { run: async (_: string, work: (context: { generation: number; signal: AbortSignal }) => Promise<unknown>) => work({ generation: 1, signal: new AbortController().signal }) } }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertSourceRoot: async () => ({}), executePlannedNative: vi.fn(), recoverPlannedNative: vi.fn() }));
vi.mock('../src/classification-local-session.js', () => ({ localClassificationEnabled: async () => true, localClassificationCanRunOffline: async () => true }));
vi.mock('../src/sw/classification-local.js', () => ({ runLocalClassification: f.classify }));
vi.mock('../src/sw/classification-destination.js', () => ({ classificationDestinationPolicy: { assertAllowed: async () => {} } }));
test('global pause prevents semantic authorization and provider invocation', async () => {
  f.db = createSourceDatabase(new IDBFactory());
  await import('../src/site-adapters/semantic-runtime.js');
  const job = { id: 'job', controlRevision: 0, scope: { serverOrigin: 'https://sync.test', accountId: null, collectionId: null },
    sources: [{ connectionId: 'connection', policyRevision: 1, installationGeneration: 1, sourceSessionGeneration: 1 }],
    connections: ['connection'], content: { site: 'bilibili', identityVersion: 1, itemId: 'video:av:1', accountId: null },
    title: 'Video', url: 'https://www.bilibili.com/video/av1', providerCommandId: 'provider' } as SemanticJob;
  vi.stubGlobal('navigator', { onLine: true });
  f.classify.mockResolvedValue({ ok: false, error: 'provider_called_while_paused' });
  try {
    await f.db.transaction(['authorities', 'meta', 'semanticJobs'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ enabled: true, connectionId: 'connection', installationGeneration: 1, sourceSessionGeneration: 1 }, 'bundled.bilibili');
      tx.objectStore('meta').put({ enabled: true, semantic: 'automatic', policy: { revision: 1, copies: 'sourceAndSemantic' } }, 'policy:connection');
      tx.objectStore('semanticJobs').put(job, job.id);
    });
    await expect(f.ports.authorize(job)).rejects.toThrow('sourceAutomationPaused');
    await expect(f.ports.classify(job)).rejects.toThrow('sourceAutomationPausedBeforeDispatch');
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.paused).toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); await f.db.close(); }
});
