import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import {
  advancedConfirmationReady, advancedConfirmationRequest, advancedDeleteLabel, advancedModeHint,
  advancedModeLabel, advancedPreviewHasNativeId, advancedPreviewRequest, advancedPreviewSummary,
  selectionFingerprint,
} from '../src/advanced-first-run-ui.js';
import { validFirstRunRequest } from '../src/sw/messages.js';
import type { FirstRunPreviewOk } from '../src/types.js';

const confirmation = {
  scopeFingerprint: 'sha256:scope', treeDigest: 'sha256:tree', mode: 'upload' as const,
  remoteSnapshotId: 'snapshot-1', remoteRevision: 'revision-1', remoteCursor: 'cursor-1',
  destructivePlanDigest: 'sha256:plan', confirmationProof: 'sha256:proof',
};
const preview: FirstRunPreviewOk = {
  ok: true, previewId: 'preview-1', boundaryVersion: '2', treeDigest: 'sha256:tree',
  bookmarkCount: 1, folderCount: 0, skippedCount: 0, warnings: [],
  advanced: { ...confirmation, deletes: [{ targetId: 'remote-1', side: 'remote', kind: 'bookmark', title: 'Cloud copy' }] },
};

describe('advanced first-run UI contract', () => {
  test('exposes explanatory labels and sends mode only for an explicit advanced preview', () => {
    assert.match(advancedModeLabel('merge'), /Auto-merge/);
    assert.match(advancedModeLabel('upload'), /This device wins/);
    assert.match(advancedModeHint('download'), /After you confirm, they are removed from this browser/);
    assert.doesNotMatch(`${advancedModeHint('download')} ${advancedModeHint('upload')}`, /selected range/);
    assert.deepEqual(advancedPreviewRequest({ viewId: 'view', selectedRefs: ['bar'], excludedRefs: [], mode: 'upload' }), {
      kind: 'known.firstRun.preview', viewId: 'view', selectedRefs: ['bar'], excludedRefs: [], bootstrapMode: 'upload',
    });
    assert.deepEqual(advancedPreviewRequest({ viewId: 'view', selectedRefs: ['bar'], excludedRefs: [], mode: 'preview-only' }), {
      kind: 'known.firstRun.preview', viewId: 'view', selectedRefs: ['bar'], excludedRefs: [], bootstrapMode: 'merge',
    });
  });

  test('requires an advanced response before constructing the destructive confirmation', () => {
    assert.equal(advancedConfirmationReady('upload', preview), true);
    assert.equal(advancedConfirmationReady('download', preview), false);
    const request = advancedConfirmationRequest({ previewId: 'preview-1', confirmationId: 'confirm-1',
      libraryId: 'library-1', confirmation });
    assert.equal(request.kind, 'known.firstRun.confirm');
    assert.equal(request.bootstrapMode, 'upload');
    assert.deepEqual(request.advancedConfirmation, confirmation);
    const withDisplayItems = { ...confirmation, deletes: [{ side: 'remote', title: 'Display only' }] };
    const fromPreview = advancedConfirmationRequest({ previewId: 'preview-1', confirmationId: 'confirm-1',
      libraryId: 'library-1', confirmation: withDisplayItems });
    assert.equal(fromPreview.kind, 'known.firstRun.confirm');
    assert.equal(validFirstRunRequest(fromPreview), true);
    assert.deepEqual(fromPreview.advancedConfirmation, confirmation);
    assert.equal(advancedPreviewHasNativeId(preview.advanced), false);
    assert.equal(advancedDeleteLabel({ side: 'remote', kind: 'bookmark', title: '<unsafe>' }), 'Know-N · bookmark · <unsafe>');
  });

  test('invalidates a preview when range, library or mode changes', () => {
    const base = { viewId: 'view', selectedRefs: ['bar'], excludedRefs: [], libraryId: 'library', mode: 'upload' as const };
    const original = selectionFingerprint(base);
    assert.notEqual(selectionFingerprint({ ...base, selectedRefs: ['other'] }), original);
    assert.notEqual(selectionFingerprint({ ...base, libraryId: 'new-library' }), original);
    assert.notEqual(selectionFingerprint({ ...base, mode: 'download' }), original);
  });

  test('formats preview summary with noun units and proper pluralization (UX-54)', () => {
    const plural = advancedPreviewSummary({ matched: 12, localOnly: 3, remoteOnly: 5, candidates: 2, conflicts: 4 });
    assert.equal(plural, '12 matched items, 3 items only on this device, 5 items only in Know-N, 2 duplicate candidates, 4 conflicts.');
    const singular = advancedPreviewSummary({ matched: 1, localOnly: 1, remoteOnly: 1, candidates: 1, conflicts: 1 });
    assert.equal(singular, '1 matched item, 1 item only on this device, 1 item only in Know-N, 1 duplicate candidate, 1 conflict.');
  });

  test('message validator accepts only complete, mode-bound advanced confirmations', () => {
    assert.equal(validFirstRunRequest({ kind: 'known.firstRun.preview', viewId: 'view', selectedRefs: [], excludedRefs: [], bootstrapMode: 'upload' }), true);
    assert.equal(validFirstRunRequest({ kind: 'known.firstRun.preview', viewId: 'view', selectedRefs: [], excludedRefs: [], bootstrapMode: 'preview-only' }), false);
    assert.equal(validFirstRunRequest({ kind: 'known.firstRun.preview', viewId: 'view', selectedRefs: [], excludedRefs: [], bootstrapMode: undefined }), false);
    assert.equal(validFirstRunRequest({ kind: 'known.firstRun.preview', viewId: 'view', selectedRefs: [], excludedRefs: [], unexpected: true }), false);
    const valid = { kind: 'known.firstRun.confirm', previewId: 'preview-1', confirmationId: 'confirm-1',
      libraryId: 'library-1', bootstrapMode: 'upload', advancedConfirmation: confirmation };
    assert.equal(validFirstRunRequest(valid), true);
    assert.equal(validFirstRunRequest({ ...valid, advancedConfirmation: { ...confirmation, mode: 'download' } }), false);
    assert.equal(validFirstRunRequest({ ...valid, advancedConfirmation: { ...confirmation, confirmationProof: undefined } }), false);
    assert.equal(validFirstRunRequest({ ...valid, unexpected: true }), false);
    assert.equal(validFirstRunRequest({ ...valid, bootstrapMode: undefined }), false);
  });

  test('keeps the main button on merge and renders deletion rows with textContent', async () => {
    const source = await readFile(new URL('../src/first-run-ui.ts', import.meta.url), 'utf8');
    assert.match(source, /advancedMode !== 'merge'/u);
    assert.match(source, /row\.textContent = advancedDeleteLabel/u);
    assert.match(source, /firstRun === 'running'/u);
    assert.match(source, /advancedConfirmationRequest/u);
    assert.match(source, /refreshPreview\(true\)/u);
  });

  test('first-run polling timeout provides terminal guidance and retry action (UX-05)', async () => {
    const source = await readFile(new URL('../src/first-run-ui.ts', import.meta.url), 'utf8');
    assert.match(source, /Date\.now\(\) - statusPollStartedAt >= STATUS_POLL_MAX_MS/);
    assert.match(source, /Sync is still running in the background/);
    assert.match(source, /retryBtn\.className = 'btn btn-ghost btn-sm'/);
  });

  test('preview-only mode provides guidance and switch to merge action (UX-21)', async () => {
    const source = await readFile(new URL('../src/first-run-ui.ts', import.meta.url), 'utf8');
    assert.match(source, /PREVIEW_ONLY_GUIDANCE/);
    assert.match(source, /PREVIEW_ONLY_SWITCH_LABEL/);
    assert.match(source, /first-run-switch-merge/);
    assert.match(source, /advancedMode = 'merge'/);
  });

  test('conflict link in first run is only shown when backend provides href, with no hardcoded domain (UX-24)', async () => {
    const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../src/first-run-attention-ui.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /id="first-run-conflict-link"[^>]*>[\s\S]*?href="https:\/\/know-n\.com\/sync"/);
    assert.doesNotMatch(html, /id="remote-delete-conflict"[^>]*>[\s\S]*?href="https:\/\/know-n\.com\/sync"/);
    assert.match(source, /syncCenterHref\(href\)/);
    assert.match(source, /host\.hidden = false/);
    assert.match(source, /host\.hidden = true/);
  });

});
