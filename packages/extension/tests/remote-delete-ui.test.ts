import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import { remoteDeletePendingCopy, remoteDeletePolicyHint } from '../src/remote-delete-ui.js';
import { validRemoteDeleteRequest } from '../src/sw/messages.js';

describe('P1-02 remote-delete Options contract', () => {
  test('exposes policy copy and validates mutating messages', () => {
    assert.match(remoteDeletePolicyHint('sync'), /this browser/);
    assert.match(remoteDeletePolicyHint('confirm'), /inbox/);
    assert.match(remoteDeletePolicyHint('keep_local'), /leaves sync/);
    assert.equal(remoteDeletePendingCopy(2), 'Cloud deletions waiting for confirmation: 2');
    assert.equal(validRemoteDeleteRequest({ kind: 'known.remoteDelete.policy.get' }), true);
    assert.equal(validRemoteDeleteRequest({ kind: 'known.remoteDelete.pending.list' }), true);
    assert.equal(validRemoteDeleteRequest({
      kind: 'known.remoteDelete.policy.set', policy: 'confirm', expectedCasVersion: 0, userGesture: true,
    }), true);
    assert.equal(validRemoteDeleteRequest({
      kind: 'known.remoteDelete.decide', decisionId: 'rdd:abc', action: 'apply', expectedCasVersion: 1,
      deleteRevision: 'delete-1', userGesture: true,
    }), true);
    assert.equal(validRemoteDeleteRequest({
      kind: 'known.remoteDelete.decide', decisionId: 'rdd:abc', action: 'apply', expectedCasVersion: 1,
      deleteRevision: 'delete-1',
    }), false);
    assert.equal(validRemoteDeleteRequest({
      kind: 'known.remoteDelete.policy.set', policy: 'preview-only', expectedCasVersion: 0, userGesture: true,
    }), false);
  });

  test('Options UI keeps native ids out of the public pending payload and wires inbox actions', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const ui = await readFile(resolve(root, 'src/remote-delete-ui.ts'), 'utf8');
    const html = await readFile(resolve(root, 'options.html'), 'utf8');
    const worker = await readFile(resolve(root, 'src/service-worker.ts'), 'utf8');
    assert.match(html, /id="remote-delete-policy"/);
    assert.match(html, /id="remote-delete-pending-list"/);
    assert.match(html, /id="tab-sync-center"[^>]*>Status</);
    assert.ok(html.indexOf('id="sync-card"') < html.indexOf('id="remote-delete-settings"'),
      'the deletion policy card lives inside the Sync center pane');
    assert.match(ui, /dataset\.pane === 'sync'/);
    assert.match(ui, /known\.remoteDelete\.decide/);
    assert.match(ui, /showApplyConfirmation/);
    assert.match(ui, /showApplyUndo/);
    assert.match(ui, /Deleted .* from this browser/);
    assert.doesNotMatch(ui, /nativeId/);
    assert.match(worker, /validRemoteDeleteRequest/);
    assert.match(worker, /handleRemoteDeleteRequest/);

    const css = await readFile(resolve(root, 'options.css'), 'utf8');
    assert.match(css, /\.remote-delete-confirm-wrap/);
  });
});
