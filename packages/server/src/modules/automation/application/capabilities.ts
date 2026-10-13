import { AUTOMATION_CONTRACT_VERSION,AUTOMATION_PROFILE,type Capabilities } from '@know-n/colp/automation';
import type { AutomationPorts } from './ports.js';

/** Worker orchestration adds task capabilities; predicate evaluation keeps its installed bounded profile. */
export function automationCapabilities(ports: Pick<AutomationPorts,'runtimeEnabled' | 'workerEnabled' | 'eventsEnabled'>): Capabilities {
  return { contractVersion: AUTOMATION_CONTRACT_VERSION,ruleApiVersions: ['colp.automation/v1'],
    runtimeProfiles: ports.runtimeEnabled ? [AUTOMATION_PROFILE] : [],triggerModes: ports.runtimeEnabled ? (ports.workerEnabled ? ['each','countBatch'] : ['each']) : [],
    taskTypes: ports.workerEnabled ? ['classify.root','classify.refine','tags.generate','summary.generate','metadata.resolve','review.generate','digest.generate'] : [],
    eventsEnabled: ports.runtimeEnabled && ports.workerEnabled === true && ports.eventsEnabled === true,limits: { maxRules: 500,maxExpressionBytes: 4_194_304,maxTasksPerRule: 8 } };
}
