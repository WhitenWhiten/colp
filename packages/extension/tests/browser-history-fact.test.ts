import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { browserHistoryFact, browserHistoryItem, isBrowserHistoryFact } from '../src/capture/browser-history-fact.js';
import { listBrowserCaptureHistory } from '../src/capture/local-history.js';
import type { CaptureScope, CaptureTask } from '../src/capture/contracts.js';

const scope: CaptureScope = { serverOrigin: 'https://known.example', accountId: 'account-a', collectionId: 'collection-a', authorityGeneration: 7 };
const draft = { captureId: 'capture-a', targetNativeId: 'parent', title: 'Saved on this device', url: 'https://example.org',
  source: 'manual-popup' as const, automaticIntent: false, createdAt: 100 };
const fact = browserHistoryFact(draft, 'native-a', 110);
const item = browserHistoryItem(fact, scope);

describe('account-independent native save facts', () => {
  it('projects an explicit allowlist instead of retaining a capture task', () => {
    const sensitive = { ...draft, scope, accessToken: 'secret', annotation: { tags: ['private'], note: 'private' },
      executionId: 'execution', decisionId: 'decision', billingAuthorization: { token: 'secret' },
      commandId: 'remote-command', feedbackKind: 'correction_applied' };
    const result = browserHistoryFact(sensitive, 'native-a', 110);
    assert.deepEqual(result, fact);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(JSON.stringify(result).includes('account-a'), false);
  });
  it('keeps device facts available after logout or changing account and collection', () => {
    for (const next of [{ ...scope, accountId: null, collectionId: null },
      { ...scope, accountId: 'account-b', collectionId: 'collection-b', authorityGeneration: 99 }]) {
      const result = browserHistoryItem(fact, next);
      assert.equal(result.title, draft.title);
      assert.equal(result.url, draft.url);
      assert.equal(result.historyReadOnly, true);
      assert.equal(result.historyOrigin, 'device');
      assert.equal(result.scope.accountId, null);
      assert.equal(result.scope.collectionId, null);
      assert.equal(result.localLocation?.writable, false);
      for (const key of ['decisionId', 'executionId', 'nodeId', 'nativeIntentId', 'cloudLocation']) {
        assert.equal(result[key as keyof typeof result], null);
      }
      assert.equal(result.sync, 'local-only');
    }
  });
  it('refuses corrupt records and extra fields rather than exporting them', () => {
    for (const candidate of [null, [], {}, { ...fact, accountId: 'private' }, { ...fact, note: 'private' },
      { ...fact, version: 2 }, { ...fact, savedAt: -1 }, { ...fact, createdAt: Number.NaN },
      { ...fact, source: 'cloud-import' }, { ...fact, nativeId: '' }, { ...fact, automatic: 'yes' }]) {
      assert.equal(isBrowserHistoryFact(candidate), false);
      assert.throws(() => browserHistoryItem(candidate as typeof fact, scope), /browser_history_invalid/u);
    }
  });
  it('retains ordering and origin facts without falsely claiming AI or cloud success', () => {
    const result = browserHistoryItem(browserHistoryFact({ ...draft, automaticIntent: true }, 'native', 123), scope);
    assert.equal(result.automaticIntent, false);
    assert.equal(browserHistoryFact({ ...draft, automaticIntent: true }, 'native', 123).automatic, true);
    assert.equal(result.createdAt, 100);
    assert.equal(result.savedAt, 123);
    assert.equal(result.classification, 'none');
    assert.equal(result.appliedRevision, null);
    assert.equal(result.syncConfirmedAt, undefined);
  });
});

describe('combined local history', () => {
  it('does not query other accounts to provide signed-out device facts', async () => {
    const reads: (string | null)[] = [];
    const tasks = { async listForOwner(owner: CaptureScope) { reads.push(owner.accountId); return []; } };
    const activity = { async listForOwner() { return [item]; } };
    const rows = await listBrowserCaptureHistory(tasks, { ...scope, accountId: null, collectionId: null }, undefined, undefined, activity);
    assert.deepEqual(reads, [null]);
    assert.equal(rows[0]?.historyReadOnly, true);
    assert.equal(rows[0]?.captureId, item.captureId);
  });
  it('deduplicates and prefers the current-account record to its narrow device summary', async () => {
    const rich: CaptureTask = { ...item, scope, sync: 'confirmed', decisionId: 'private-decision' };
    const tasks = { async listForOwner(owner: CaptureScope) { return owner.accountId ? [rich] : []; } };
    const rows = await listBrowserCaptureHistory(tasks, scope, undefined, undefined, { async listForOwner() { return [item]; } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0], rich);
    assert.equal(rows[0]?.sync, 'confirmed');
  });
  it('keeps guest history read-only after login and does not query account B', async () => {
    const reads: (string | null)[] = [];
    const tasks = { async listForOwner(owner: CaptureScope) { reads.push(owner.accountId); return owner.accountId ? [] : [item]; } };
    const rows = await listBrowserCaptureHistory(tasks, scope);
    assert.deepEqual(reads, ['account-a', null]);
    assert.equal(rows[0]?.historyReadOnly, true);
  });
  it('enforces read-only on activity and tolerates an unavailable optional diary', async () => {
    const tasks = { async listForOwner() { return []; } };
    const { historyReadOnly: _readOnly, ...withoutFlag } = item;
    const rows = await listBrowserCaptureHistory(tasks, scope, undefined, undefined, { async listForOwner() { return [withoutFlag]; } });
    assert.equal(rows[0]?.historyReadOnly, true);
    assert.deepEqual(await listBrowserCaptureHistory(tasks, scope, undefined, undefined,
      { async listForOwner() { throw new Error('indexeddb unavailable'); } }), []);
  });
  it('migrates only visible successful native saves and not replayable remote history', async () => {
    const { historyReadOnly: _readOnly, historyOrigin: _origin, ...native } = item;
    const saved: CaptureTask = { ...native, scope };
    const cloudOnly: CaptureTask = { ...saved, captureId: 'cloud', nativeId: null };
    const failed: CaptureTask = { ...saved, captureId: 'failed', save: 'failed' };
    const imported = { ...saved, captureId: 'imported', historyReadOnly: true as const };
    let remembered: readonly CaptureTask[] = [];
    const tasks = { async listForOwner(owner: CaptureScope) { return owner.accountId ? [saved, cloudOnly, failed, imported] : []; } };
    await listBrowserCaptureHistory(tasks, scope, undefined, undefined, {
      async rememberMany(records: readonly CaptureTask[]) { remembered = records; },
      async listForOwner() { return []; },
    });
    assert.deepEqual(remembered, [saved]);
  });
  it('keeps private history readable when optional device migration fails', async () => {
    const rows = await listBrowserCaptureHistory({ async listForOwner(owner: CaptureScope) { return owner.accountId ? [item] : []; } },
      scope, undefined, undefined, { async rememberMany() { throw new Error('unavailable'); }, async listForOwner() { return []; } });
    assert.deepEqual(rows, [item]);
  });
  it('applies the shared deterministic timestamp/id order and 50-row page limit', async () => {
    const before: readonly [number, string] = [1000, 'cursor'];
    const deviceRows = Array.from({ length: 60 }, (_, index) => ({ ...item, captureId: `id-${String(index).padStart(2, '0')}`, createdAt: 100 }));
    const rows = await listBrowserCaptureHistory({ async listForOwner() { return []; } }, scope, before, undefined,
      { async listForOwner(_owner: CaptureScope, cursor?: readonly [number, string]) { assert.equal(cursor, before); return deviceRows; } });
    assert.equal(rows.length, 50);
    assert.equal(rows[0]?.captureId, 'id-59');
    assert.equal(rows[49]?.captureId, 'id-10');
  });
});
