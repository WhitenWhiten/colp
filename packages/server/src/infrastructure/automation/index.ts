export { createAutomationUnitOfWork } from './unit-of-work.js';
export { exportAutomations } from './export.js';
export { createBindingReadPort, createBindingStore } from './bindings.js';
export { createDependencyIndex } from './dependency-index.js';
export { createAutomationHealthMonitor } from './health-worker.js';

export { createAutomationSourceInspector } from './source-position-store.js';
export { setAutomationCaptureEnabled, automationCaptureEnabled } from './fact-capture.js';
export { createApprovedProposalApplier } from './approved-proposals.js';
export { createAutomationAdmission } from './aggregate-store.js';
export { createAutomationDeviceUnitOfWork } from './device-unit-of-work.js';
export { createAutomationRuntime } from './runtime.js';
export { createTargetWorkerService } from './target-worker.js';
export type { CurrentBindingVerifier, TargetWorkerService } from './target-worker.js';

export { createAutomationWorkerService } from './worker-service.js';
export { createResultSubmissionPort } from './result-store.js';
export { createProposalPlanGateway } from './proposal-plan-gateway.js';

export { createWebhookVerifier } from './webhook-verifier.js';
export { createSubscriptionStore } from './subscription-store.js';
export { createDeliveryWorker } from './delivery-worker.js';
export { retainAutomationHistory } from './retention-worker.js';

export { createAutomationMaintenanceLoop } from './maintenance-loop.js';
export { resumeOwnerBudgets } from './budget-wakes.js';
export { convergeOwnerWork } from './owner-maintenance.js';
