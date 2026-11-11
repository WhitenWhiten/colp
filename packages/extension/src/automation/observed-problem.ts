import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { t } from '../i18n.js';
import type { ObservationProblem, ObservationStage } from './observed-queue.js';

export function observationProblem(stage: ObservationStage, error: unknown): ObservationProblem {
  const raw = error instanceof Error ? error.message : null;
  const code = classifyBookmarkApiFailure(error) === 'permission_denied' ? 'permission_required'
    : typeof raw === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/u.test(raw) ? raw : `${stage}_unavailable`;
  return { stage, code, retryable: !['observation_expired', 'observation_context_changed', 'move_not_confirmed', 'observation_interrupted'].includes(code) };
}

/** Causes and a next step for checks that could not safely reach a native move. */
export function observedProblemMessage(problem: ObservationProblem): string {
  if (problem.code === 'observation_expired') return t('automation_observedExpired',
    'The automatic filing check expired. The bookmark stayed in its current folder. Choose a folder yourself.');
  if (problem.code === 'move_not_confirmed') return t('automation_observedMoveUnconfirmed',
    'The automatic move could not be confirmed. Check the bookmark’s current folder and choose its location yourself.');
  if (!problem.retryable) return t('automation_observedInterrupted',
    'The automatic filing check was interrupted or its account changed. Check the bookmark and choose a folder yourself.');
  if (problem.code === 'permission_required') return t('automation_observedPermission',
    'Allow bookmark access, then choose Check now to retry the pending filing check. You can also choose a folder yourself.');
  if (problem.stage === 'move') return t('automation_observedMovePending',
    'Could not confirm the automatic move. Its recovery record is kept. Choose Check now to check the bookmark’s current folder before trying again.');
  if (problem.stage === 'receipt') return t('automation_recoveryReceipt',
    'The move could not be recorded. Its recovery record is kept; choose Check now to retry.');
  if (problem.stage === 'evidence') return t('automation_observedEvidence',
    'Could not read this bookmark’s sync or import history. The pending check is kept. Choose Check now to retry, or choose a folder yourself.');
  if (problem.stage === 'rules') return t('automation_observedRules',
    'Could not read rules or pause status. The pending check is kept. Choose Check now to retry, or choose a folder yourself.');
  if (problem.stage === 'intent') return t('automation_observedIntent',
    'Could not save recovery information for automatic filing. The bookmark stayed where it is. Choose Check now to retry, or choose a folder yourself.');
  return t('automation_observedBookmark',
    'Could not read the bookmark. The pending filing check is kept. Choose Check now to retry, or choose a folder yourself.');
}
