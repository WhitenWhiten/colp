import { createLane } from './automation/lane.js';
import type { CaptureTask } from './capture/contracts.js';
/** Linearizes exclusion activation with cloud dispatch. Unknown old cloud commands must settle before activation. */
export const withDestinationPolicyBoundary = createLane();
export function unsettledCloudDestination(task: Pick<CaptureTask, 'local' | 'automatic'>) {
  return !task.local && !!task.automatic && (!task.automatic.decision
    || task.automatic.applySubmitted && !['applied', 'rejected'].includes(task.automatic.applyState ?? ''));
}
