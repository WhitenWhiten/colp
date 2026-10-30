import { ClassificationError, ClassificationProviderError } from './generated/classification/index.js';

/** Preserve the failure category without exposing provider bodies, credentials or raw exceptions. */
export function localClassificationFailure(error: unknown): string {
  if (error instanceof ClassificationProviderError) {
    switch (error.code) {
      case 'credentials': return 'local_key_rejected';
      case 'contract_drift': return 'local_request_failed';
      case 'rate_limited': return 'local_rate_limited';
      case 'deadline': return 'local_timeout';
      case 'outcome_unknown': return 'local_result_unknown';
      case 'configuration_changed': return 'local_settings_changed';
    }
  }
  if (error instanceof ClassificationError) {
    if (error.code === 'context_limit') return 'local_request_too_large';
    return error.code === 'contract_drift' ? 'local_request_failed' : 'local_classification_failed';
  }
  if (error instanceof Error) {
    if (/^destination_policy_/u.test(error.message)) return error.message;
    if (error.name === 'TimeoutError') return 'local_timeout';
    if (error.message === 'local_taxonomy_too_large') return 'local_taxonomy_too_large';
    if (error.message === 'sourceAutomationPaused' || error.message === 'sourceAutomationPausedBeforeDispatch') return error.message;
    if (error.message === 'local_authority_changed') return 'local_settings_changed';
    if (error.message === 'local_result_unavailable') return 'local_result_unknown';
  }
  return 'local_classification_failed';
}
