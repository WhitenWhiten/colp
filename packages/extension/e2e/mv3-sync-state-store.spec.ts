import { test, expect, chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DATABASE_VERSION } from '../src/sync-state/schema.js';
import { openExtensionOptions } from './extension-auth.js';

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const extensionPath = resolve(import.meta.dirname, '../dist/development');
const scope = { environment: 'production', serverId: 'server-e2e', serverOrigin: 'https://known.example',
  accountId: 'account-e2e', browserProfileId: 'profile-e2e', collectionId: 'collection-e2e',
  replicaId: 'replica-e2e', generation: 1 };
interface EvidenceExport { readonly scope: { readonly replicaId: string }; readonly queue: ReadonlyArray<{
  readonly sequence: number; readonly digest: string }>; readonly receipts: ReadonlyArray<{ readonly operationDigest: string }>;
  readonly recovery: { readonly complete: boolean } | null }
interface EvidenceLease { readonly outcome: string; readonly ownerId: string; readonly fence: number }

test('MV3 survives worker termination and full browser restart with all durable authorities', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-28-browser-'));
  let context = await launch(profile);
  try {
    let page = await extensionPage(context);
    const seeded = await call<EvidenceExport>(page, 'seedEvidence', scope);
    expect(seeded.queue[0]!.sequence).toBe(1);
    // A worker boot walks the native tree once per extension session, marked in storage.session:
    // the mark must outlive a recycled worker and be gone after a browser restart.
    const sessionProbe = () => chrome.storage.session.get('known.e2e.session-probe');
    await page.evaluate(() => chrome.storage.session.set({ 'known.e2e.session-probe': true }));
    await stopWorker(context, page);
    page = await extensionPage(context);
    expect(await call<EvidenceExport>(page, 'exportScope', scope)).toEqual(seeded);
    expect(await page.evaluate(sessionProbe)).toEqual({ 'known.e2e.session-probe': true });
    await context.close();

    context = await launch(profile);
    page = await extensionPage(context);
    expect(await page.evaluate(sessionProbe)).toEqual({});
    const restarted = await call<EvidenceExport>(page, 'exportScope', scope);
    expect(restarted).toEqual(seeded);
    expect(restarted.receipts[0]!.operationDigest).toBe(restarted.queue[0]!.digest);
    expect(restarted.recovery).toMatchObject({ complete: true });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('real Chromium unique indexes and lease fences arbitrate independent extension contexts', async () => {
  const context = await launch('');
  try {
    const a = await extensionPage(context); const b = await extensionPage(context);
    await call<null>(a, 'registerEvidenceScope', scope);
    const results = await Promise.all([call<EvidenceLease>(a, 'acquireEvidenceLease', scope, 'owner-a'),
      call<EvidenceLease>(b, 'acquireEvidenceLease', scope, 'owner-b')]);
    const winner = results.find((value) => value.outcome === 'acquired');
    expect(winner).toBeTruthy();
    const duplicate = await Promise.all([call<{ readonly sequence: number }>(a, 'enqueueEvidence', scope, 'same-op'),
      call<{ readonly sequence: number }>(b, 'enqueueEvidence', scope, 'same-op')]);
    expect(new Set(duplicate.map((value) => value.sequence))).toEqual(new Set([1]));
    const queued = duplicate[0]!;
    await call(a, 'claimEvidenceQueue', scope, winner!.ownerId, winner!.fence, 1_000);
    const replacement = await call<EvidenceLease>(b, 'acquireEvidenceLease', scope, 'replacement', 32_000);
    expect(replacement.outcome).toBe('acquired');
    await expect(call(a, 'completeEvidenceQueue', scope, queued.sequence, winner!.ownerId, winner!.fence,
      'same-op', 'sha256:same-op')).rejects.toThrow('stale_fence');
    expect((await call<EvidenceExport>(b, 'exportScope', scope)).receipts).toHaveLength(0);
  } finally { await context.close(); }
});

test('bounded history retention resumes after a real worker restart and preserves unapplied echoes', async () => {
  const context = await launch('');
  try {
    let page = await extensionPage(context);
    await call(page, 'registerEvidenceScope', scope);
    const exported = await call<{ scope: { scopeKey: string } }>(page, 'exportScope', scope);
    await page.evaluate(async key => {
      const request = indexedDB.open('known-phase3-indexeddb-entry');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const tx = db.transaction(['outbound_queue', 'receipts', 'bookmark_events', 'cursors', 'durable_sequences'], 'readwrite');
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
        for (let sequence = 1; sequence <= 2; sequence += 1) {
          tx.objectStore('outbound_queue').put({ scopeKey: key, sequence, opId: `op-${sequence}`, batchId: `batch-${sequence}`,
            idempotencyKey: `idem-${sequence}`, digest: `sha256:op-${sequence}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
            baseRevision: 'rev', operationRevision: `local-${sequence}`, status: 'terminal',
            retry: { attempt: 0, notBefore: 0 }, ...(sequence === 2 ? { echoApplied: true } : {}),
            payload: sequence === 1 ? { type: 'update_node_content', targetId: 'node-1' }
              : { type: 'create_node', payload: { parentId: 'parent', node: { kind: 'bookmark', title: 'Original',
                url: 'https://example.test/original', tags: ['original-tag'] } } } });
          tx.objectStore('receipts').put({ scopeKey: key, receiptId: `receipt-${sequence}`, sequence, opId: `op-${sequence}`,
            operationDigest: `sha256:op-${sequence}`, kind: 'terminal', resultDigest: 'sha256:result',
            result: { results: [{ opId: `op-${sequence}`, sequence, status: 'applied', targetId: `node-${sequence}`, revision: 'rev' }] } });
          tx.objectStore('bookmark_events').put({ scopeKey: key, eventId: `event-${sequence}`, ordinal: sequence,
            dedupeKey: `dedupe-${sequence}`, occurredAt: '2026-10-23T00:00:00Z', kind: sequence === 2 ? 'create' : 'change', nativeId: `native-${sequence}`,
            status: 'processed', opId: `op-${sequence}`, details: { title: 'old' } });
        }
        tx.objectStore('cursors').put({ scopeKey: key, cursor: 'snapshot', checkpoint: 'rev',
          evidence: { snapshotId: 'snapshot', pageDigest: 'sha256:page' } });
        tx.objectStore('durable_sequences').put({ scopeKey: key, next: 3 });
        await done;
      } finally { db.close(); }
    }, exported.scope.scopeKey);
    for (let pass = 0; pass < 4; pass += 1) await call(page, 'compactEvidenceScope', scope, 100, 1);
    await stopWorker(context, page);
    page = await extensionPage(context);
    for (let pass = 0; pass < 4; pass += 1) await call(page, 'compactEvidenceScope', scope, 24 * 60 * 60_000 + 100, 1);
    const retained = await call<{ queue: { sequence: number }[]; receipts: { sequence: number }[];
      bookmarkEvents: { ordinal: number }[] }>(page, 'exportScope', scope);
    expect(retained.queue.map(row => row.sequence)).toEqual([1]);
    expect(retained.receipts.map(row => row.sequence)).toEqual([1]);
    expect(retained.bookmarkEvents.map(row => row.ordinal)).toEqual([1]);
    await stopWorker(context, page);
    page = await extensionPage(context);
    const restarted = await call<{ compactSummaries: { kind: string; id: string; evidence?: unknown }[] }>(page, 'exportScope', scope);
    expect(restarted.compactSummaries.find(row => row.kind === 'automation_create')).toMatchObject({
      id: 'native-2', evidence: { nodeId: 'node-2', operationId: 'op-2', parentNodeId: 'parent',
        title: 'Original', url: 'https://example.test/original', tags: ['original-tag'] },
    });
  } finally { await context.close(); }
});

test('blocked/versionchange closes connections and reopens without clearing state', async () => {
  const context = await launch('');
  try {
    const page = await extensionPage(context); await call<EvidenceExport>(page, 'seedEvidence', scope);
    const result = await page.evaluate(async (databaseVersion) => {
      const opened = indexedDB.open('known-phase3-indexeddb-entry', databaseVersion + 1);
      return new Promise<string>((resolveResult, reject) => {
        opened.onupgradeneeded = () => opened.transaction?.abort();
        opened.onerror = () => resolveResult(opened.error?.name ?? 'error');
        opened.onblocked = () => reject(new Error('connection ignored versionchange'));
      });
    }, DATABASE_VERSION);
    expect(result).toBe('AbortError');
    expect((await call<EvidenceExport>(page, 'exportScope', scope)).scope.replicaId).toBe(scope.replicaId);
  } finally { await context.close(); }
});

test('real Chromium upgrades the pinned P3-03 v1 and v2 databases without duplicate legacy authority', async () => {
  for (const version of [1, 2]) {
    const profile = await mkdtemp(resolve(tmpdir(), `known-p3-28-v${version}-`));
    const context = await launch(profile);
    try {
      const page = await extensionPage(context);
      const fixture = JSON.parse(await readFile(resolve(import.meta.dirname,
        `../tests/fixtures/indexeddb-p3-03-v${version}.json`), 'utf8'));
      await page.evaluate(({ version, state }) => new Promise<void>((resolveSeed, reject) => {
        const request = indexedDB.open('known-phase3-indexeddb-entry', version);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('replica_state', { keyPath: ['serverId', 'collectionId', 'replicaId'] }).put(state);
          if (version === 2) {
            db.createObjectStore('event_dedupe', { keyPath: ['serverId', 'collectionId', 'replicaId', 'eventId'] });
            db.createObjectStore('leases', { keyPath: ['serverId', 'collectionId', 'replicaId'] });
            db.createObjectStore('schema_metadata', { keyPath: 'key' });
          }
        };
        request.onsuccess = () => { request.result.close(); resolveSeed(); };
        request.onerror = () => reject(request.error);
      }), { version, state: fixture.state });
      const migrated = await call<{ readonly unackedQueue: ReadonlyArray<{ readonly sequence: number }>;
        readonly receipts: ReadonlyArray<{ readonly operationDigest: string }> }>(page, 'exportLegacyDiagnostic', scope);
      expect(migrated.unackedQueue[0]?.sequence).toBe(41);
      expect(migrated.receipts[0]?.operationDigest).toBe(fixture.state.receipt.digest);
      const database = await page.evaluate(() => new Promise<{ readonly version: number; readonly stores: string[] }>((resolveDatabase, reject) => {
        const request = indexedDB.open('known-phase3-indexeddb-entry');
        request.onsuccess = () => { const result = request.result;
          resolveDatabase({ version: result.version, stores: Array.from(result.objectStoreNames) }); result.close(); };
        request.onerror = () => reject(request.error);
      }));
      expect(database.version).toBe(DATABASE_VERSION);
      expect(database.stores).not.toEqual(expect.arrayContaining(['replica_state', 'event_dedupe', 'leases']));
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  }
});

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
}
async function extensionPage(context: BrowserContext): Promise<Page> {
  return (await openExtensionOptions(context)).page;
}
async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(({ method, args }) => chrome.runtime.sendMessage({
    kind: 'known.sync-state.evidence', method, args,
  }), { method, args }) as { readonly ok: boolean; readonly error?: string; readonly value?: T };
  if (!result?.ok || result.value === undefined) throw new Error(result?.error ?? 'evidence_failed'); return result.value;
}
async function stopWorker(context: BrowserContext, page: Page) {
  const cdp: CDPSession = await context.newCDPSession(page); await cdp.send('ServiceWorker.enable');
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url.includes(EXTENSION_ID));
  expect(target).toBeTruthy(); await cdp.send('Target.closeTarget', { targetId: target!.targetId }); await cdp.detach();
}
