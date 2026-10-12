import { keepLocalFromDecision } from '../remote-delete-apply.js';
import { enqueueRemoteDeleteRestore } from '../remote-delete-restore.js';
import { kns09Paused } from '../kns-09-release.js';
import type { RemoteDeleteRequest, RemoteDeleteResponse } from '../types.js';
import { hasConflictBarrier } from '../engine-public-stability.js';
import { scheduleSyncEngineWake } from './engine.js';
import { hasBookmarkPermission, syncState } from './runtime.js';
import { currentSyncScope, loadConfig } from './scope.js';
import type { OpEvent } from '../remote-delete-policy.js';

const PENDING = ['pending', 'applying', 'restoring'] as const;

export async function handleRemoteDeleteRequest(message: RemoteDeleteRequest): Promise<RemoteDeleteResponse> {
  try {
    const scope = await currentSyncScope();
    if (message.kind === 'known.remoteDelete.policy.get' || message.kind === 'known.remoteDelete.pending.list') {
      return status(scope);
    }
    if (await kns09Paused('ui')) return { ok: false, error: 'sync_paused' };
    if (message.kind === 'known.remoteDelete.policy.set') {
      await syncState.setRemoteDeletePolicy(scope, {
        policy: message.policy, expectedCasVersion: message.expectedCasVersion, now: Date.now(),
      });
      return status(scope);
    }
    const permissionGranted = await hasBookmarkPermission();
    const decided = await syncState.decideRemoteDelete(scope, {
      decisionId: message.decisionId, action: message.action, expectedCasVersion: message.expectedCasVersion,
      deleteRevision: message.deleteRevision, generation: scope.generation, now: Date.now(), permissionGranted,
    });
    const raw = await syncState.getPullEvent(scope, decided.eventId);
    const event = raw?.payload as OpEvent | undefined;
    if (message.action === 'keep_local' && event) {
      await keepLocalFromDecision(syncState, scope, event, decided, () => Date.now());
    }
    if (message.action === 'restore') {
      await enqueueRemoteDeleteRestore(syncState, scope, decided, Date.now());
    }
    scheduleSyncEngineWake('manual');
    return status(scope);
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message
      : error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? String((error as { code: string }).code) : 'request_invalid';
    return { ok: false, error: code };
  }
}

async function status(scope: Awaited<ReturnType<typeof currentSyncScope>>): Promise<RemoteDeleteResponse> {
  const policy = await syncState.getRemoteDeletePolicy(scope);
  const pending = await syncState.listRemoteDeleteDecisions(scope, PENDING);
  let conflictPending = false;
  let after = 0;
  try {
    for (;;) {
      const page = await syncState.listQueue(scope, 'blocked', after, 1_000);
      if (hasConflictBarrier(page)) { conflictPending = true; break; }
      if (page.length < 1_000) break;
      after = page.at(-1)!.sequence;
    }
  } catch { /* status remains available if queue inspection fails */ }
  const config = await loadConfig().catch(() => undefined);
  const origin = config?.serverOrigin?.replace(/\/$/u, '') || 'https://know-n.com';
  return {
    ok: true, policy: policy.policy, casVersion: policy.casVersion, pendingCount: pending.length,
    pending: pending.map((row) => ({
      decisionId: row.decisionId, title: row.title, kind: row.nodeKind, state: row.state,
      casVersion: row.casVersion, deleteRevision: row.deleteRevision,
    })),
    conflictPending, conflictHref: `${origin}/sync`,
  };
}
