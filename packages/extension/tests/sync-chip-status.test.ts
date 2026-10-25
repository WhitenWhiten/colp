import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import { popupFirstRunStatus } from '../src/first-run-draft.js';
import { attentionStatusKind, projectSyncStatus } from '../src/sync-status.js';
import type { PublicSyncAttention } from '../src/types.js';

/**
 * C-05, C-06, C-09, C-17f: the chip says what is true. Access the extension
 * lost, a pause that ends by itself, an unreadable store and an item that
 * clears by itself each get their own phrase instead of "Synced", "Action
 * required" or "Syncing" forever.
 */
const calm: PublicSyncAttention = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false,
  conflictPending: false, nativeWaitPending: false, waitCount: 0, terminal: false };

afterEach(() => { vi.unstubAllGlobals(); });

describe('attentionStatusKind', () => {
  test('removed bookmark access is its own phrase, below a conflict and above anything else', () => {
    assert.equal(attentionStatusKind({ ...calm, permissionRequired: true }), 'permission-required');
    assert.equal(attentionStatusKind({ ...calm, permissionRequired: true, issueCount: 3, retryAutomatic: false }), 'permission-required');
    assert.equal(attentionStatusKind({ ...calm, permissionRequired: true, conflictPending: true }), 'review-conflicts');
    assert.deepEqual(projectSyncStatus('permission-required'), { kind: 'permission-required', label: 'Bookmark access needed', tone: 'attention' });
  });

  test('a pause that ends by itself is a retry; a halt and a pause with an item to decide still need a person', () => {
    const cooling = { ...calm, retryAutomatic: false, coolingDown: true, phase: 'error' as const };
    assert.equal(attentionStatusKind(cooling), 'retrying');
    assert.equal(attentionStatusKind({ ...cooling, issueCount: 1 }), 'action-required');
    assert.equal(attentionStatusKind({ ...calm, retryAutomatic: false, phase: 'error' }), 'action-required');
    assert.equal(attentionStatusKind({ ...cooling, terminal: true }), 'action-required');
  });

  test('an item that clears by itself is not a decision, and a wait for a parent folder is not an action (C-17f)', () => {
    const waiting = { direction: 'pull' as const, code: 'waiting_dependency', recovery: 'automatic' as const };
    assert.equal(attentionStatusKind({ ...calm, issueCount: 1, issues: [waiting], waitCount: 1 }), undefined);
    assert.equal(attentionStatusKind({ ...calm, issueCount: 2, issues: [waiting, { direction: 'push', code: 'set_aside' }] }), 'action-required');
    assert.equal(attentionStatusKind({ ...calm, nativeWaitPending: true, waitCount: 1 }), 'action-required');
  });

  test('calm facts say nothing, so the engine phase decides', () => {
    assert.equal(attentionStatusKind(calm), undefined);
    assert.equal(attentionStatusKind({ ...calm, retryAutomatic: true, issueCount: 0 }), undefined);
  });

  test('the new phrases read as words, and the unreadable and stuck ones ask for attention', () => {
    assert.equal(projectSyncStatus('status-unavailable').label, 'Can’t read sync status');
    assert.equal(projectSyncStatus('status-unavailable').tone, 'attention');
    assert.equal(projectSyncStatus('stuck').label, 'Sync is stuck');
  });
});

describe('the chip when the status cannot be read (C-09)', () => {
  const chromeWith = (attention: () => unknown) => vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}) } },
    runtime: { sendMessage: async ({ kind }: { kind: string }) => {
      if (kind === 'known.firstRun.status') return { ok: true, firstRun: 'completed' };
      if (kind === 'known.sync.engine.status') return { ok: true, engine: { phase: 'sleeping', hasPendingWork: false } };
      if (kind === 'known.sync.attention.get') return attention();
      return { ok: false };
    } },
  });

  test('an unreadable store is "Can’t read sync status", not "Syncing" forever', async () => {
    chromeWith(() => ({ ok: false, error: 'state_unavailable' }));
    const { signedInSyncStatus } = await import('../src/sync-label.js');
    assert.deepEqual(await signedInSyncStatus(), projectSyncStatus('status-unavailable'));
  });

  test('a worker that cannot be reached says so too', async () => {
    chromeWith(() => { throw new Error('Could not establish connection'); });
    const { signedInSyncStatus } = await import('../src/sync-label.js');
    assert.deepEqual(await signedInSyncStatus(), projectSyncStatus('status-unavailable'));
  });

  test('a missing scope is not an error: the first-run state still decides', async () => {
    chromeWith(() => ({ ok: false, error: 'not_connected' }));
    const { signedInSyncStatus } = await import('../src/sync-label.js');
    assert.deepEqual(await signedInSyncStatus(), projectSyncStatus('synced'));
  });

  test('the chip names removed access and a pause', async () => {
    chromeWith(() => ({ ok: true, attention: { ...calm, permissionRequired: true } }));
    const { signedInSyncStatus } = await import('../src/sync-label.js');
    assert.deepEqual(await signedInSyncStatus(), projectSyncStatus('permission-required'));
    chromeWith(() => ({ ok: true, attention: { ...calm, retryAutomatic: false, coolingDown: true } }));
    assert.deepEqual(await signedInSyncStatus(), projectSyncStatus('retrying'));
  });
});

describe('a frozen recovery that keeps failing (C-17f)', () => {
  const recovering = (errorCode?: string) => popupFirstRunStatus({ connected: true, firstRun: 'completed', deferredDraft: false,
    engine: { phase: 'recovery', hasPendingWork: false, ...(errorCode ? { errorCode } : {}) } });

  test('a transient failure is a wait or a retry, not "Syncing"', () => {
    assert.equal(recovering('network_unavailable'), 'waiting-network');
    assert.equal(recovering('server_unavailable'), 'retrying');
    assert.equal(recovering('some_error_nobody_registered'), 'retrying');
  });

  test('recovery without an error, or renewing authority, is still syncing', () => {
    assert.equal(recovering(), 'syncing');
    assert.equal(recovering('recovery_required'), 'syncing');
  });
});
