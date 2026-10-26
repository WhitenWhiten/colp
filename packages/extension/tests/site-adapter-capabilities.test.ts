// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createSourceLayout } from '../src/site-adapters/layout.js';
import { createSourceArchiveRuntime } from '../src/site-adapters/archive-runtime.js';
import { observedCatalog } from '../src/site-adapters/observed-catalog.js';
import { siteFeatures, reconciliationCapability } from '../src/site-adapters/capabilities.js';
import { renderSiteCapabilities } from '../src/site-adapters/settings-capabilities.js';
import { validateSiteDefinitions, validateAdapterImplementation } from '../src/site-adapters/registry-validation.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { createRuleListStore } from '../src/automation/rule-list-store.js';
import { flattenList } from '../src/automation/rule-list-flatten.js';
import { memoryStateArea } from './automation-fixture.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { postsDefinition, post, saved, createDomPostsAdapter } from './fixtures/site-adapters/posts.js';
import type { StoredSavePlan } from '../src/site-adapters/planned-types.js';
import type { SiteDefinition } from '../src/site-adapters/registry-types.js';
const state = vi.hoisted(() => ({ layout: undefined as ReturnType<typeof createSourceLayout> | undefined, rules: undefined as ReturnType<typeof createRuleListStore> | undefined }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: {} }));
vi.mock('../src/site-adapters/planned-runtime.js', () => ({ executePlannedSave: async () => { throw new Error('unexpectedNativeExecution'); } }));
vi.mock('../src/site-adapters/layout-runtime.js', () => ({ sourceLayout: new Proxy({}, { get: (_, key) => state.layout![key as keyof ReturnType<typeof createSourceLayout>] }) }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertPlannedNative: async () => {}, assertSourceRoot: async () => ({ inRange: false }) }));
vi.mock('../src/sw/automation.js', () => ({ sourceAutomationsPaused: async () => false }));
vi.mock('../src/sw/automation-browser.js', () => ({ currentFlat: async () => flattenList(await state.rules!.load()), browserRuleStore: () => state.rules }));
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
const observer: SiteDefinition = { ...postsDefinition, capabilities: ['observeFavorites'], negativeReadback: false };
async function setup(definition = observer) {
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db, {}, definition);
  const a = await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: false });
  const context = { installationId: definition.adapterId, connectionId: a.connectionId!, documentId: 'doc', tabId: 1, routeEpoch: 0, leaseId: 'lease', installationGeneration: 1, sourceSessionGeneration: 1 };
  await ledger.bindLease(context, Date.now() + 600000); state.rules = createRuleListStore(memoryStateArea());
  const node = { id: 'root', title: 'Root', dateAdded: 10 };
  state.layout = createSourceLayout(db, { rules: async () => flattenList(await state.rules!.load()), paused: async () => false, deviceId: async () => 'device', lookup: async id => id === 'root' ? node : null, assertRoot: async () => {} });
  vi.stubGlobal('chrome', { permissions: { contains: async () => true }, bookmarks: { get: async () => [node] } });
  const catalog = vi.fn(async () => { if (!siteFeatures(definition).collections) throw new Error('unexpectedEnumeration'); return [saved]; });
  const runtime = createSourceArchiveRuntime(createReadScheduler(new MemoryStorageArea(), 'reads'), { source: async () => ({ context, expiresAt: Date.now() + 60000 }), readSource: async () => ({ context, expiresAt: Date.now() + 60000 }),
    catalog, send: () => {}, prioritizeLive: async () => {}, alarm: () => {} }, ledger, definition);
  const configure = (live = true) => runtime.handle({ kind: 'known.siteAdapters.archive.configure', rootNativeId: 'root', collectionIds: [saved.id], live });
  return { db, ledger, context, runtime, catalog, configure };
}
test('observation-only adapters configure and plan live archives from current catalog facts without enumeration', async () => {
  validateSiteDefinitions([observer]); const adapter = createDomPostsAdapter(); validateAdapterImplementation(observer, { start: adapter.start, detectSource: adapter.detectSource });
  const f = await setup(); try {
    expect((await f.ledger.acceptObservation(f.context, 'catalog', { type: 'catalog.upsert', collections: [saved] })).status).toBe('accepted');
    expect(await f.runtime.status()).toMatchObject({ catalog: [saved], catalogCoverage: 'observedOnly' });
    await f.configure(); expect(f.catalog).not.toHaveBeenCalled();
    await expect(f.runtime.handle({ kind: 'known.siteAdapters.import.start' })).rejects.toThrow('unsupported');
    await f.ledger.acceptObservation(f.context, 'favorite', { type: 'favorite.confirmed', interactionId: 'click', item: post, memberships: { mode: 'delta', added: [saved.id], removed: [] }, confirmation: { kind: 'settledDom', detector: 'fixture-dom' } });
    await f.runtime.live.wake();
    const plans = await f.db.transaction(['savePlans'], 'readonly', tx => new Promise<StoredSavePlan[]>(resolve => { const r = tx.objectStore('savePlans').getAll(); r.onsuccess = () => resolve(r.result); }));
    expect(plans).toHaveLength(1); expect(plans[0]).toMatchObject({ state: 'approved', plan: { classification: 'disabled', purpose: 'sourceArchive' } });
    expect(plans[0]!.plan.effects.map(e => e.kind)).toEqual(['ensureSourceFolder', 'createBookmark']);
  } finally { await f.db.close(); }
});
test('observation-only setup ignores old generations and other connections', async () => {
  const f = await setup(); try {
    await f.ledger.acceptObservation(f.context, 'catalog', { type: 'catalog.upsert', collections: [saved] });
    f.context.installationGeneration = 2;
    await f.ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 2, sourceSessionGeneration: 1, negativeReadback: false });
    await f.ledger.bindLease(f.context, Date.now() + 60000);
    await f.db.transaction(['collections'], 'readwrite', async tx => { tx.objectStore('collections').put({ entity: saved, source: { installationId: observer.adapterId, installationGeneration: 2, sourceSessionGeneration: 1 } }, sourceKey('another-connection', saved.id)); });
    expect(await observedCatalog(f.ledger, f.context)).toEqual([]); await expect(f.configure()).rejects.toThrow('refreshCatalogRequired');
    await f.ledger.acceptObservation(f.context, 'fresh-catalog', { type: 'catalog.upsert', collections: [saved] }); await expect(f.configure()).resolves.toMatchObject({ configured: true });
  } finally { await f.db.close(); }
});
test('enumeration-only setup does not require synthetic emit messages and rejects enabling live archives', async () => {
  const definition: SiteDefinition = { ...observer, capabilities: ['enumerateCollections', 'enumerateItems'], validateMessage: m => m.operation !== 'emit' };
  const f = await setup(definition); try {
    await expect(f.configure()).rejects.toThrow('unsupported'); await expect(f.configure(false)).resolves.toMatchObject({ configured: true });
    expect(f.catalog).toHaveBeenCalledOnce(); expect(await f.db.read('collections', sourceKey(f.context.connectionId, saved.id))).toMatchObject({ entity: saved });
    await expect(f.runtime.handle({ kind: 'known.siteAdapters.import.start' })).resolves.toHaveProperty('importId');
  } finally { await f.db.close(); }
});
test.each([observer, { ...observer, capabilities: ['enumerateCollections', 'enumerateItems'] as const }, { ...observer, capabilities: ['resolveItem'] as const }])('settings gates controls for $capabilities and keeps cancellation available for older jobs', definition => {
  document.body.innerHTML = readFileSync(resolve(process.cwd(), 'site-adapters.html'), 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/giu, '');
  renderSiteCapabilities(document, definition); const f = siteFeatures(definition);
  expect(document.querySelector<HTMLButtonElement>('#read-catalog')!.hidden).toBe(!f.collections);
  expect(document.querySelector<HTMLButtonElement>('#read-item')!.hidden).toBe(!f.resolve);
  expect(document.querySelector<HTMLElement>('[aria-labelledby="sites-import-heading"]')!.hidden).toBe(!f.import);
  if (!f.import) { expect(document.querySelector<HTMLButtonElement>('#start-import')!.disabled).toBe(true); renderSiteCapabilities(document, definition, true);
    expect(document.querySelector<HTMLElement>('[aria-labelledby="sites-import-heading"]')!.hidden).toBe(false); }
  expect(document.querySelector('#capability-summary')!.textContent).not.toContain('Positive observation only');
});

test('rechecking capability distinguishes positive reads from qualified absence', () => {
  expect(reconciliationCapability({ negativeReadback: false, collectionSnapshot: 'positiveOnly' })).toBe('positiveOnly');
  expect(reconciliationCapability({ negativeReadback: true })).toBe('scopedAbsence');
  expect(reconciliationCapability({ negativeReadback: false, collectionSnapshot: 'pointInTime' })).toBe('snapshotAbsence');
});
