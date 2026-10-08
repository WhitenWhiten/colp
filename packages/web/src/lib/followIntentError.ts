/* Shared intent-failure classification for the follow workflows
   (useFollowWorkflow / useCollectionFollowWorkflow / useReportFollowWorkflow).
   command_id_reused means the intent collided with a prior command — refresh
   authority.  Transport uncertainty or an in-flight command keeps the exact
   intent retryable ('Retry').  A server-declared user_action
   rejection (e.g. following your own digest) can never succeed on retry, so
   the workflow drops back to an authority re-read ('Retry status') instead of
   offering a permanently failing intent. */
import { isProductApiError } from '../api'

export type FollowIntentErrorPatch = {
  status: 'conflict' | 'unknown' | 'error'
  message: string
  retryKind: 'authority' | 'intent'
}

export function followIntentErrorPatch(error: unknown, fallbackMessage: string): FollowIntentErrorPatch {
  if (isProductApiError(error) && error.isCommandIdReused) {
    return { status: 'conflict', message: error.recoveryHint, retryKind: 'authority' }
  }
  if (isProductApiError(error) && (error.code === 'transport_error' || error.isCommandInProgress)) {
    return { status: 'unknown', message: error.recoveryHint, retryKind: 'intent' }
  }
  if (isProductApiError(error) && error.recovery === 'user_action') {
    return { status: 'error', message: error.recoveryHint, retryKind: 'authority' }
  }
  return {
    status: 'error',
    message: isProductApiError(error) ? error.recoveryHint : fallbackMessage,
    retryKind: 'intent',
  }
}
