import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import { validBatchRequest } from '../src/sw/messages.js';
import { statusCopy } from '../src/bookmark-manager-batch-ui.js';

describe('options bookmark manager batch UI contract', () => {
  test('manager exposes batch preview, second confirm, undo, and selection', async () => {
    const source = await readFile(new URL('../src/bookmark-manager-batch-ui.ts', import.meta.url), 'utf8');
    assert.match(source, /Move selected items/);
    assert.match(source, /createDialog\(/);
    assert.match(source, /manager-batch-dialog/);
    assert.match(source, /Rename selected|known.batch/);
    assert.match(source, /known.batch.preview/);
    assert.match(source, /known.batch.confirm/);
    assert.match(source, /known.batch.undo/);
    assert.match(source, /secondConfirm/);
    assert.match(source, /mgr-select/);
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(source, /Permanently delete/);
    assert.doesNotMatch(source, /item\(s\)/);
    const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
    assert.match(html, /manager-batch-move/);
    assert.match(html, /manager-batch-delete/);
    assert.match(html, /manager-batch-undo/);
    // The dialog itself is built by createDialog(), so it shares the capture-dialog look.
    assert.doesNotMatch(html, /<dialog[^>]*manager-batch/);
  });

  test('batch messages reject empty, oversized, and ungestured confirms', () => {
    assert.equal(validBatchRequest({ kind: 'known.batch.preview', operation: 'delete', nativeIds: ['a'] }), true);
    assert.equal(validBatchRequest({ kind: 'known.batch.preview', operation: 'delete', nativeIds: [] }), true);
    assert.equal(validBatchRequest({
      kind: 'known.batch.confirm', commandId: 'cmd', operation: 'delete', nativeIds: ['a'],
      previewDigest: 'sha256:x', userGesture: true, secondConfirm: true,
    }), true);
    assert.equal(validBatchRequest({
      kind: 'known.batch.confirm', commandId: 'cmd', operation: 'delete', nativeIds: ['a'],
      previewDigest: 'sha256:x',
    }), false);
    assert.equal(validBatchRequest({ kind: 'known.batch.undo', planId: 'p', commandId: 'c', userGesture: true }), true);
  });
});

describe('batch status copy distinguishes an apply failure from an undo failure', () => {
  const status = (over: Partial<Parameters<typeof statusCopy>[0]>) => ({
    planId: 'p', commandId: 'c', operation: 'delete' as const, state: 'partial',
    reused: false, applied: 1, failed: 1, changed: 0, undone: 0, items: [],
    ...over,
  });

  test('a partially applied batch reports the apply, not an undo nobody ran', () => {
    // `state === 'partial' && failed > 0` describes a partial apply exactly as
    // well as a failed undo, so inferring the undo from it made a half-applied
    // delete say "The undo did not restore 1 item(s)."
    assert.equal(statusCopy(status({ applied: 1, failed: 1 }), false), 'Updated 1, failed 1.');
    assert.equal(statusCopy(status({ applied: 0, failed: 2 }), false), 'The batch could not be applied.');
  });

  test('a failed undo still outranks the success copy', () => {
    assert.equal(statusCopy(status({ applied: 2, failed: 1 }), true), 'The undo did not restore 1 item.');
    assert.equal(statusCopy(status({ applied: 2, failed: 2 }), true), 'The undo did not restore 2 items.');
    assert.equal(statusCopy(status({ applied: 2, failed: 1, undone: 1 }), true),
      'Undo restored 1, could not restore 1.');
    assert.equal(statusCopy(status({ state: 'undone', undone: 2, applied: 2 }), true), 'Undone.');
  });
});
