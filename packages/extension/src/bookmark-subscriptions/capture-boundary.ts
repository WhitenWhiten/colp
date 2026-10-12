import { isSubscriptionExcluded } from './guards.js';
import type { CaptureTask } from '../capture/contracts.js';
export async function assertPersonalCapture(task:Pick<CaptureTask,'nativeId'|'targetNativeId'|'localLocation'>){
  for(const id of new Set([task.nativeId,task.targetNativeId,task.localLocation?.nativeId].filter((id):id is string=>Boolean(id))))if(await isSubscriptionExcluded(id))throw new Error('subscription_capture_excluded');
}
