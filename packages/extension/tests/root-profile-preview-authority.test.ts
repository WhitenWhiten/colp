import { expect, test } from 'vitest';
import { scope, seedSelected, tree } from './sw-authority-entry-fixture.js';
import { store, sw, syncState } from '../src/sw/runtime.js';
import { handleRootRequest } from '../src/sw/roots.js';
import { rejoinSession } from './rejoin-http-fixture.js';
import type { RootRequest } from '../src/types.js';

async function review() {
  const response = await handleRootRequest({ kind: 'known.roots.get' });
  if (!response.ok || !('view' in response)) throw new Error('root_view_missing');
  const request = { kind: 'known.roots.preview' as const, viewId: response.view.viewId,
    selectedRefs: response.view.roots.filter(row => row.selected).map(row => row.ref),
    privateRefs: response.view.roots.filter(row => row.privateLocal).map(row => row.ref) };
  const result = await handleRootRequest(request);
  if (!result.ok || !('preview' in result)) throw new Error(`root_preview_missing:${JSON.stringify(result)}`);
  expect(result.preview).toMatchObject({ additions: [], removals: [], shifts: [] });
  return { view: response.view, request, preview: result.preview };
}

async function expectRejectedWithoutEffects(requests: RootRequest[]) {
  const before = await syncState.exportScope(scope), nativeBefore = structuredClone(tree);
  for (const request of requests) {
    expect(await handleRootRequest(request)).toEqual({ ok: false, error: 'request_invalid' });
    expect(await syncState.exportScope(scope)).toEqual(before);
    expect(tree).toEqual(nativeBefore);
    for (const name of ['create', 'update', 'move', 'remove', 'removeTree'] as const)
      expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
  }
}

test('current profile previews accept their own roots but reject another real profile ref and durable preview with no effects', async () => {
  await seedSelected(); await syncState.setFirstRun(scope, 'completed');
  const profileA = { ...scope }, reviewA = await review();
  const beforeA = await syncState.exportScope(profileA);
  // The same native IDs can exist in separate browser profiles. Scope identity,
  // rather than globally unique Chrome IDs, must bind both public proofs.
  Object.assign(scope, { browserProfileId: 'profile-b', replicaId: 'replica-b' });
  await store.saveSession(await rejoinSession(scope));
  await syncState.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-b', expiresAt: Date.now() + 60_000 }, selectedRoots: [], privateRoots: [],
    checkpoint: { serverRevision: 'cloud-revision', cursor: 'cloud-cursor' }, firstRun: 'completed', rootStatus: 'ready' });
  await seedSelected();
  const reviewB = await review();
  expect(reviewB.request.selectedRefs).toHaveLength(1); expect(reviewB.request.privateRefs).toHaveLength(1);
  expect(reviewB.request.selectedRefs).not.toEqual(reviewA.request.selectedRefs);
  expect(reviewB.request.privateRefs).not.toEqual(reviewA.request.privateRefs);
  await expectRejectedWithoutEffects([
    { ...reviewB.request, selectedRefs: reviewA.request.selectedRefs },
    { ...reviewB.request, privateRefs: reviewA.request.privateRefs },
    { kind: 'known.roots.confirm', previewId: reviewA.preview.previewId,
      treeDigest: reviewA.preview.treeDigest, confirmationId: 'foreign-confirm-a' },
  ]);
  expect(await syncState.exportScope(profileA)).toEqual(beforeA);
  Object.assign(scope, profileA); await store.saveSession(await rejoinSession(scope));
  const currentA = await review();
  await expectRejectedWithoutEffects([
    { ...currentA.request, selectedRefs: reviewB.request.selectedRefs },
    { kind: 'known.roots.confirm', previewId: reviewB.preview.previewId,
      treeDigest: reviewB.preview.treeDigest, confirmationId: 'foreign-confirm-b' },
  ]);
});

test('worker view expiry rejects the old view while stable folder refs and a reviewed durable preview retain their own semantics', async () => {
  await seedSelected(); await syncState.setFirstRun(scope, 'completed');
  const first = await review(), before = await syncState.exportScope(scope), nativeBefore = structuredClone(tree);
  syncState.close(); sw.rootViewTokens = undefined;
  const reopened = await review();
  expect(reopened.view.viewId).not.toBe(first.view.viewId);
  expect(reopened.request.selectedRefs).toEqual(first.request.selectedRefs);
  expect(reopened.request.privateRefs).toEqual(first.request.privateRefs);
  await expectRejectedWithoutEffects([{ ...reopened.request, viewId: first.view.viewId }]);
  // Preview records are durable: a new worker view alone does not revoke a
  // previously reviewed, unchanged boundary. The explicit click still works.
  expect(await handleRootRequest({ kind: 'known.roots.confirm', previewId: first.preview.previewId,
    treeDigest: first.preview.treeDigest, confirmationId: 'confirmed-after-reopen' }))
    .toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  const after = await syncState.exportScope(scope);
  expect(after.scope).toMatchObject({ selectedRoots: before.scope!.selectedRoots, privateRoots: before.scope!.privateRoots });
  expect(after.queue).toEqual(before.queue); expect(after.receipts).toEqual(before.receipts);
  expect(tree).toEqual(nativeBefore);
  expect(await syncState.getBoundaryCommand(scope, 'confirmed-after-reopen'))
    .toMatchObject({ kind: 'range', previewId: first.preview.previewId, state: 'committed' });
});
