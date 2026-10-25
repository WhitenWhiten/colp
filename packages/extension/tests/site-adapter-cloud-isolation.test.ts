import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceDigest, sourceKey, type SourceDatabase } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createCloudRuntime } from '../src/site-adapters/cloud-runtime.js';
import { cloudReviewKey } from '../src/site-adapters/cloud-review.js';
import type { CloudScope } from '../src/site-adapters/cloud-client.js';
import type { SiteDefinition } from '../src/site-adapters/registry-types.js';
import { postsDefinition, saved } from './fixtures/site-adapters/posts.js';
const fixture = vi.hoisted(() => ({ db: undefined as SourceDatabase | undefined, items: [] as unknown[], owner: { serverOrigin: 'https://cloud.example', accountId: 'cloud-user', collectionId: 'cloud-library', replicaId: 'device', generation: 1 } }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return fixture.db; } } }));
vi.mock('../src/sw/capture-target.js', () => ({ captureTarget: async () => ({ inRange: true, collectionId: fixture.owner.collectionId }) }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => ({}) }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => fixture.owner, loadConfig: async () => ({ serverOrigin: fixture.owner.serverOrigin }) }));
vi.mock('../src/sw/runtime.js', () => ({ store: { loadCredential: async () => ({ accessToken: 'test-access' }), fence: { read: async () => ({ generation: 1 }) }, assertWritable: async () => {} },
  syncState: { getMappingByNativeId: async (_: unknown, id: string) => ({ nodeKind: 'folder', colpId: id, projection: { resourceRevision: 'r1' } }) } }));
vi.mock('../src/auth-client.js', () => ({ colpCredentialHeaders: () => ({}) }));
vi.mock('../src/server-origin-permission.js', () => ({ credentialGatedFetch: () => vi.fn() }));
vi.mock('../src/sw/automation-browser.js', () => ({ currentFlat: async () => ({ items: fixture.items, stopped: false }), nativeFolderLookup: async () => null, browserRuleStore: () => ({}) }));
vi.mock('../src/sw/automation.js', () => ({ sourceAutomationsPaused: async () => false }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/site-adapters/layout-runtime.js', () => ({ assertNoCloudDestinationWork: async () => {} }));
vi.mock('../src/classification-destination-boundary.js', () => ({ withDestinationPolicyBoundary: async (work: () => Promise<unknown>) => work() }));
vi.mock('../src/site-adapters/cloud-client.js', () => ({ assertCloudReceipt: () => {}, createSourceCloudClient: () => ({ call: async (action: string, input: { scope: CloudScope }) => {
  if (action === 'status') return { connections: [] };
  if (action === 'configure') return { scopeDigest: sourceDigest(input.scope), lease: { replicaId: fixture.owner.replicaId, epoch: 1, token: 'lease', expiresAt: Date.now() + 120000 } };
  throw new Error('unexpectedCloudAction');
} }) }));
afterEach(() => { vi.unstubAllGlobals(); fixture.items = []; });
async function setupSite(definition: SiteDefinition) {
  const db = fixture.db!, ledger = createSourceLedger(db, {}, definition);
  const a = await ledger.setAuthority({ enabled: true, installationGeneration: 1, sourceSessionGeneration: 1, accountId: 'acct:reader', negativeReadback: false });
  const root = `root:${definition.adapterId}`, ruleId = `rule:${definition.adapterId}`;
  fixture.items.push({ id: ruleId, site: { admission: { connectionId: a.connectionId, entries: ['siteImport'], collectionIds: [saved.id] } }, action: { kind: 'file', folderNativeId: root } });
  await db.transaction(['meta', 'mounts'], 'readwrite', async tx => {
    tx.objectStore('meta').put({ enabled: true, policy: { revision: 1, copies: 'sourceAndSemantic' } }, `policy:${a.connectionId}`);
    tx.objectStore('mounts').put({ state: 'active', root: { nativeId: root, dateAdded: 10, deviceId: 'device' } }, sourceKey(a.connectionId, ruleId));
  });
  return { runtime: createCloudRuntime(definition), connectionId: a.connectionId!, definition };
}
test('two real cloud runtime instances can review in parallel and approve in reverse order without replacing each other', async () => {
  const db = createSourceDatabase(new IDBFactory()); fixture.db = db;
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => [{ id, title: id, dateAdded: 10 }] } });
  try {
    const [a, b] = await Promise.all([setupSite(postsDefinition), setupSite({ ...postsDefinition, adapterId: 'fixture.other', siteKey: 'other' })]);
    const [ra, rb] = await Promise.all([a.runtime.handleCloudManagement({ kind: 'known.siteAdapters.cloud.review' }), b.runtime.handleCloudManagement({ kind: 'known.siteAdapters.cloud.review' })]);
    const digest = (r: unknown) => (r as { digest: string }).digest;
    await expect(b.runtime.handleCloudManagement({ kind: 'known.siteAdapters.cloud.approve', digest: digest(ra) })).rejects.toThrow('sourceCloudPreviewStale');
    await expect(b.runtime.handleCloudManagement({ kind: 'known.siteAdapters.cloud.approve', digest: digest(rb) })).resolves.toMatchObject({ approved: true });
    await expect(a.runtime.handleCloudManagement({ kind: 'known.siteAdapters.cloud.approve', digest: digest(ra) })).resolves.toMatchObject({ approved: true });
    expect(await db.read('meta', 'sourceCloudReview')).toBeUndefined();
    expect(await db.read('meta', cloudReviewKey(a.definition, { ...fixture.owner, accountId: 'different-owner' }, a.connectionId))).toBeUndefined();
    expect(await db.read('meta', cloudReviewKey(a.definition, fixture.owner, b.connectionId))).toBeUndefined();
  } finally { await db.close(); }
});
