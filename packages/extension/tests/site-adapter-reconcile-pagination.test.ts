// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { installReconcileControls, paintReconciliation, reconcileSelections } from '../src/site-adapters/settings-reconcile.js';
import type { ReconcilePreview } from '../src/site-adapters/reconcile-model.js';
afterEach(() => vi.unstubAllGlobals());
test('page navigation preserves choices and displays aggregate progress outside the visible page', () => {
  document.body.innerHTML = readFileSync('site-adapters.html', 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  vi.stubGlobal('chrome', {});
  const send = vi.fn(async () => ({})); installReconcileControls(send);
  const preview: ReconcilePreview = { version: 1, id: 'preview', importId: 'import', digest: 'frozen', createdAt: 1, policyRevision: 1,
    context: { connectionId: 'source', installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', tabId: 1, routeEpoch: 0, leaseId: 'lease' }, snapshots: [],
    differences: [{ id: 'deleted', collectionId: 'saved', itemId: 'post', kind: 'localDeleted', title: 'Deleted post', choices: ['keep', 'restore'] }],
    page: { offset: 0, next: 100, total: 101, counts: { present: 10000, localDeleted: 101 } } };
  paintReconciliation(preview, null, 'preview');
  const select = document.querySelector<HTMLSelectElement>('[data-difference-id="deleted"]')!;
  select.value = 'restore'; select.dispatchEvent(new Event('change'));
  document.getElementById('reconcile-more')!.click();
  expect(send).toHaveBeenLastCalledWith({ kind: 'known.siteAdapters.status', reconcileOffset: 100 });
  const next = { ...preview, differences: [], page: { ...preview.page!, offset: 100, next: null } };
  paintReconciliation(next, null, 'preview');
  expect(reconcileSelections()).toEqual([{ id: 'deleted', choice: 'restore' }]);
  document.getElementById('reconcile-previous')!.click();
  expect(send).toHaveBeenLastCalledWith({ kind: 'known.siteAdapters.status', reconcileOffset: 0 });
  paintReconciliation(next, { id: 'run', preview, scope: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library', authorityGeneration: 1 },
    state: 'approved', operations: [], updatedAt: 1, progress: { completed: 90, pending: 10, attention: 1, undone: 0 } }, 'attention');
  expect(document.getElementById('reconcile-retry')!.hidden).toBe(false);
  expect(document.getElementById('reconcile-result')!.textContent).toContain('90 applied');
  expect(document.getElementById('reconcile-summary')!.textContent).toContain('10000');
});
