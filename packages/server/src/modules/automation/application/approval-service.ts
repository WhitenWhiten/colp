import type { DecisionInput } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import { parseContract, requireEtag } from './rule-service.js';

export interface AutomationApprovalPort {
  inspect(jobId: string): Promise<{ revision: string; proposalDigest: string; planId: string; planEtag: string } | null>;
  decide(input: { planId: string; decision: 'approve' | 'deny'; ifMatch: string; commandId: string }): Promise<unknown>;
}
/** Server-side application of decided proposals ("the server applies results", design 04). */
export interface ApprovedProposalApplier {
  apply(ownerId: string, jobId: string): Promise<void>;
  sweep(ownerId: string): Promise<number>;
}
/** Approval remains exclusively in the existing Owner Plan/Approval ledger. */
export async function decideAutomationProposal(port: AutomationApprovalPort,jobId: string,body: unknown,ifMatch: string,commandId: string) {
  const input: DecisionInput = parseContract('DecisionInput',body), proposal = await port.inspect(jobId);
  if (!proposal) throw new AutomationError('resource_not_found','Proposal is unavailable.');
  requireEtag(proposal.revision,ifMatch);
  if (proposal.proposalDigest !== input.proposalDigest) throw new AutomationError('automation_stale_input','Approval requires the exact current proposal digest.');
  return port.decide({ planId: proposal.planId,decision: input.decision === 'approve' ? 'approve' : 'deny',ifMatch: proposal.planEtag,commandId });
}
