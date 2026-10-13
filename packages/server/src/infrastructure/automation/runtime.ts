import { createAutomationAdmission } from './aggregate-store.js';
import { executePendingIntake } from './intake-executor.js';
import type { InspectAutomationSource } from './source-position-store.js';
/** M1 has no M2 worker-policy, budget, target or event-subscription dependencies. */
export function createAutomationRuntime(serverUuid: string): InspectAutomationSource {
  const admit = createAutomationAdmission(serverUuid);
  return async (tx, actor, collectionId, sources) => {
    await admit(tx, actor, collectionId, sources);
    return executePendingIntake(tx, actor, collectionId, serverUuid);
  };
}
