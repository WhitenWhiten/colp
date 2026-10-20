// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test, vi } from 'vitest';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { replicaRebuildFailureCopy } from '../src/replica-rebuild-ui.js';
import { validReplicaRebuildRequest } from '../src/replica-rebuild.js';
import { setupRetirement } from './replica-retirement-harness.js';

const fixtures: Awaited<ReturnType<typeof setupRetirement>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks();
  vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function setup() {
  const f = await setupRetirement(); fixtures.push(f);
  // Keep the production store/worker/rebuilder. Only the extension messaging
  // boundary is bridged here; every preview and confirmation runs real logic.
  const sent: { kind: string }[] = [];
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: async (message: { kind: string }) => {
      sent.push(message);
      if (message.kind === 'known.sync.attention.get') return handleSyncAttentionRequest({ scope: f.currentScope,
        store: f.store, serverRetirement: true, rebuildPending: f.rebuilder.pendingStatus });
      if (validReplicaRebuildRequest(message)) return f.rebuilder.handle(message);
      return { ok: false, error: 'not_connected' };
    } }, tabs: { create: vi.fn(async () => undefined) } });
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.slice(markup.indexOf('<section id="sync-attention-settings"'),
    markup.indexOf('<section id="native-wait-settings"'));
  const refreshes: (() => void)[] = [];
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    refreshes.push(callback); return 0;
  }) as typeof setInterval);
  document.body.dataset.pane = 'sync'; bindSyncAttentionSettings();
  return { ...f, sent, refresh: () => refreshes.forEach(run => run()),
    button: document.getElementById('sync-attention-settings-rebuild') as HTMLButtonElement,
    feedback: document.getElementById('sync-attention-settings-feedback')! };
}
async function until(predicate: () => boolean) {
  await vi.waitFor(() => assert.equal(predicate(), true), { timeout: 1000, interval: 5 });
}
function action(label: string) { return Array.from(document.querySelectorAll('button')).find(button => button.textContent === label)!; }

test('the real Status binder advertises reset, explains server confirmation, and Cancel sends nothing', async () => {
  const f = await setup(); await until(() => !f.button.hidden);
  f.button.click(); await until(() => document.querySelector('.rebuild-confirm-copy') !== null);
  const copy = document.querySelector('.rebuild-confirm-copy')!.textContent!;
  assert.match(copy, /internet connection/); assert.match(copy, /will not be sent again/);
  assert.match(copy, /may already be in your library/); assert.match(copy, /review the merge again/);
  assert.equal(f.requests.length, 0); action('Cancel').click();
  await until(() => !f.button.disabled);
  assert.equal(f.sent.filter(row => row.kind === 'known.scope.rebuild.confirm').length, 0);
  assert.deepEqual(await f.store.listQueue(f.scope), f.original);
});

test('a real lost response leaves a visible retry explanation and never claims the local reset completed', async () => {
  const f = await setup(); f.setResponse(async () => { throw new Error('lost_response'); });
  await until(() => !f.button.hidden); f.button.click();
  await until(() => document.querySelector('.rebuild-confirm-copy') !== null); action('Reset sync').click();
  await until(() => !f.button.disabled && !f.feedback.hidden);
  assert.match(f.feedback.textContent!, /Waiting for the server to confirm/);
  assert.match(f.feedback.textContent!, /will not be sent again/);
  assert.equal(f.requests.length, 1); assert.deepEqual(await f.credentials.loadBinding(), f.binding);
  assert.deepEqual(await f.store.listQueue(f.scope), f.original);
});

test('a retained reset without current credentials shows how to restore authorization while disabling Reset', async () => {
  const f = await setup(); f.setResponse(async () => { throw new Error('offline'); });
  await until(() => !f.button.hidden); f.button.click();
  await until(() => document.querySelector('.rebuild-confirm-copy') !== null); action('Reset sync').click();
  await until(() => !f.button.disabled && f.requests.length === 1);
  await f.credentials.clearCredential(); f.setRestore(null);
  f.refresh(); await until(() => f.button.hidden && !f.feedback.hidden);
  assert.equal(f.button.hidden, true); assert.equal(f.feedback.hidden, false);
  assert.match(f.feedback.textContent!, /same account/); assert.match(f.feedback.textContent!, /Sign in again/);
  assert.equal(f.requests.length, 1); assert.deepEqual(await f.store.listQueue(f.scope), f.original);
});

test('permission and legacy recovery messages do not promise that a retry can bypass server authority', () => {
  assert.match(replicaRebuildFailureCopy('retirement_authentication_required'), /still have access/);
  assert.match(replicaRebuildFailureCopy('retirement_authority_denied'), /Signing in again cannot restore revoked/);
  assert.match(replicaRebuildFailureCopy('retirement_authority_denied'), /continue using bookmarks/);
  assert.match(replicaRebuildFailureCopy('retirement_legacy_authority_required'), /Update the server/);
  assert.match(replicaRebuildFailureCopy('rebuild_other_account_pending'), /another account/);
  assert.match(replicaRebuildFailureCopy('retirement_target_changed'), /address changed/);
  assert.match(replicaRebuildFailureCopy('native_outcome_unsettled'), /Resolve it in Status/);
});
