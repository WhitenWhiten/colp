import { type AckIntentRecord } from './types.js';
import { canonicalJson } from './codec.js';

export function sameAckIntent(prior: AckIntentRecord, intent: AckIntentRecord) {
  const { state: _priorState, result: _priorResult, ...priorIdentity } = prior;
  const { state: _intentState, result: _intentResult, ...intentIdentity } = intent;
  return canonicalJson(priorIdentity) === canonicalJson(intentIdentity);
}
