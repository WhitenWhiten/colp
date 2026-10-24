import type { Kysely } from 'kysely';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import type { DatabaseSchema } from '../infrastructure/database/runtime.js';
import { createApprovedProposalApplier, createProposalPlanGateway, createResultSubmissionPort, createTargetWorkerService } from '../infrastructure/automation/index.js';
import { createPostgresMcpOauthRevocationStore } from '../infrastructure/database/index.js';
import { createMcpChangePlanRateLimitPort } from '../infrastructure/rate-limit/index.js';
import type { ApprovedProposalApplier } from '../modules/automation/index.js';
import { createMcpSecurityEpochReader } from './api-mcp-oauth-composition.js';
import { createAutomationBindingVerifier } from './automation-binding-verifier.js';
import type { AppConfig } from './config.js';
import { createPhase4bMcpWriteComposition } from './mcp-write-composition.js';

/**
 * Worker-side application of decided automation proposals, so approvals, expiries and revocations
 * converge without the original worker. It commits only plans the Owner already approved (or that
 * Trusted policy already allowed), through the same change-plan coordinator and commit guard as the API.
 */
export function createWorkerApprovalApplier(config: AppConfig, db: Kysely<DatabaseSchema>, metrics: Metrics): ApprovedProposalApplier | undefined {
  if (!config.automationWorkEnabled || !config.mcp || !config.mcpWrite) return undefined;
  const target = createTargetWorkerService(db, createAutomationBindingVerifier(config,
    createMcpSecurityEpochReader(config, createPostgresMcpOauthRevocationStore({ db }))), async () => {}, { cursorKey: config.productEditorCursor.current.key });
  let results: ReturnType<typeof createResultSubmissionPort> | undefined;
  const composition = createPhase4bMcpWriteComposition({
    db, serverUuid: config.mcp.serverUuid, approvalBaseUri: config.mcpWrite.approvalBaseUri,
    requestStateKey: config.mcpWrite.requestStateKey, allowedScopes: config.mcp.oauth.scopes, metrics,
    planTtlMilliseconds: config.mcpWrite.planTtlMilliseconds, productOrigin: config.productOrigin,
    // Process-local budget: this composition only re-commits plans that are already decided.
    rateLimit: createMcpChangePlanRateLimitPort(config.mcpWrite.commitRateLimit),
    beforeBeginCommit: async input => { await results!.guard(input.transaction, input.planId); },
  });
  results = createResultSubmissionPort(db, config.publication.serverUuid, target.authorize, createProposalPlanGateway(db, composition.changePlanOptions));
  return createApprovedProposalApplier(db, config.publication.serverUuid, results);
}
