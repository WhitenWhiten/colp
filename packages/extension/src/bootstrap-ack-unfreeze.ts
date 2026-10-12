/**
 * Completed bootstrap Ack is not proof that a pending Pull page or unknown
 * Chrome create has settled. Authority refresh is server auth only.
 */
export { pendingNativeOrPullFacts } from './native-repair.js';

export function mayUnfreezeForCompletedBootstrapAck(input: {
  readonly pendingIncompletePull: boolean;
  readonly nativeResultUnknown: boolean;
}): boolean {
  return !input.pendingIncompletePull && !input.nativeResultUnknown;
}


