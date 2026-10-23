import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../infrastructure/database/runtime.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import { createPostgresMcpOauthRevocationStore } from '../infrastructure/database/index.js';
import { convergeOwnerWork, createAutomationMaintenanceLoop, resumeOwnerBudgets, retainAutomationHistory,
  createDeliveryWorker, createTargetWorkerService, createWebhookVerifier,
  createOwnerMaintenanceBatch, createPostgresOwnerMaintenanceQueue } from '../infrastructure/automation/index.js';
import { createAutomationBindingVerifier } from './automation-binding-verifier.js';
import { createWorkerApprovalApplier } from './automation-approval-composition.js';
import { createMcpSecurityEpochReader } from './api-mcp-oauth-composition.js';
import type { AppConfig } from './config.js';

export function composeWorkerAutomationMaintenance(config: AppConfig, db: Kysely<DatabaseSchema>, metrics: Metrics) {
  const delivery = config.mcpEventsEnabled && config.automationWebhookMasterKey
    ? createDeliveryWorker(db, createTargetWorkerService(db,
      createAutomationBindingVerifier(config, createMcpSecurityEpochReader(config, createPostgresMcpOauthRevocationStore({ db }))), async () => {}).authorize,
    createWebhookVerifier(config.automationWebhookMasterKey, { ...(config.automationWebhookPreviousMasterKey ? { previousMasterKey: config.automationWebhookPreviousMasterKey } : {}) }))
    : undefined;
  const approvals = createWorkerApprovalApplier(config, db, metrics);
  return createAutomationMaintenanceLoop({ delivery,
    maintain: createOwnerMaintenanceBatch({ queue: createPostgresOwnerMaintenanceQueue(db),
      async maintainOwner(ownerId) {
        await retainAutomationHistory(db, ownerId, config.mcpWriteEnabled === true);
        if (config.automationWorkEnabled) {
          await resumeOwnerBudgets(db, ownerId);
          await convergeOwnerWork(db, ownerId, config.publication.serverUuid);
        }
        await approvals?.sweep(ownerId);
      },
      onError() { metrics.increment('automation.maintenance.error'); },
    }),
    onError(kind) { metrics.increment(`automation.${kind}.error`); },
  });
}
