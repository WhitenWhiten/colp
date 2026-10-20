import { kns09Paused } from '../kns-09-release.js';
import { listRejoinDecisions, refreshRejoinDecisions, resolveRejoinDecision, validRejoinDecisionRequest,
  type RejoinDecisionRequest, type RejoinDecisionResponse } from '../scope-rejoin-decisions.js';
import { captureBoundaryAttempt } from './boundary-attempt.js';
import { scheduleSyncEngineWake } from './engine.js';
import { pendingRejoinAdmission, rejoinNative } from './rejoin-native.js';
import { hasBookmarkPermission, syncState, workCoordinator } from './runtime.js';
import { currentSyncScope } from './scope.js';

/** GET can resume a durable accepted choice. Both reads and explicit decisions
 * therefore share the native callback lane through intent, API and receipt. */
export async function handleRejoinDecisionRequest(message: RejoinDecisionRequest): Promise<RejoinDecisionResponse> {
  if (!validRejoinDecisionRequest(message)) return { ok: false, error: 'request_invalid' };
  try {
    return await workCoordinator.run('bookmark', async () => {
      const scope = await currentSyncScope();
      if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
      if (await kns09Paused('ui')) return { ok: false, error: 'sync_paused' };
      const attempt = await captureBoundaryAttempt(scope);
      const input = { store: syncState, scope,
        ...await rejoinNative(scope, attempt, await pendingRejoinAdmission(scope, attempt)) };
      await attempt.assertCurrent();
      if (message.kind === 'known.sync.rejoinDecisions.resolve') await resolveRejoinDecision(input, message);
      else await refreshRejoinDecisions(input);
      await attempt.assertCurrent();
      const decisions = await listRejoinDecisions(input);
      if (message.kind === 'known.sync.rejoinDecisions.resolve' || decisions.some(row => row.state === 'applying')) {
        scheduleSyncEngineWake('manual');
      }
      return { ok: true, decisions };
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)
      ? error.message : 'rejoin_unavailable' };
  }
}
