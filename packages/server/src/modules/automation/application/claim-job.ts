import type { ClaimInput, FailureInput, HeartbeatInput, Lease, LeaseProof } from '@know-n/colp/automation';
import type { AutomationActor } from '../domain/bindings.js';
import { AutomationError } from '../domain/errors.js';
import { parseContract } from './rule-service.js';

export interface WorkPrincipal extends AutomationActor { clientId: string; credentialBindingId: string; scopes: readonly string[]; resourceAudience?: string; securityEpoch?: string }
export type ClaimOutcome = { kind: 'claimed'; lease: Lease } | { kind: 'conflict' | 'uncertain' | 'budget' };
export interface JobLeaseStore {
  claim(actor: WorkPrincipal, jobId: string, input: ClaimInput): Promise<ClaimOutcome>;
  heartbeat(actor: WorkPrincipal, jobId: string, input: HeartbeatInput): Promise<Lease>;
  fail(actor: WorkPrincipal, jobId: string, input: FailureInput): Promise<void>;
  verify(actor: WorkPrincipal, jobId: string, proof: LeaseProof): Promise<void>;
}
export async function claimJob(store: JobLeaseStore, actor: WorkPrincipal, jobId: string, body: unknown): Promise<Lease> {
  const result = await store.claim(actor, jobId, parseContract('ClaimInput', body));
  if (result.kind === 'claimed') return result.lease;
  throw new AutomationError(result.kind === 'budget' ? 'automation_budget_exceeded' : 'automation_claim_conflict',
    result.kind === 'uncertain' ? 'Expired work has an unknown outcome and requires reconciliation.'
      : result.kind === 'budget' ? 'Optional work is held by the execution budget.' : 'Job already has a claimant or is not ready.');
}
export const heartbeatJob = (store: JobLeaseStore, actor: WorkPrincipal, id: string, body: unknown) => store.heartbeat(actor,id,parseContract('HeartbeatInput',body));
export const failJob = (store: JobLeaseStore, actor: WorkPrincipal, id: string, body: unknown) => store.fail(actor,id,parseContract('FailureInput',body));
