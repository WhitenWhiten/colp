import type { ProductCommandBinding, ProductCommandClaim, ProductCommandResult } from '../../commands/index.js';
import type { ClassificationContext, ClassificationCallResult, ClassificationStage } from './classification-provider.js';
import type { ClassificationBillingConsent } from './classification-billing.js';
export type { ClassificationBillingConsent } from './classification-billing.js';

export type ClassificationBillingMode = 'managed' | 'byok' | 'legacy_free';
export type ClassificationBillingOwnerKind = 'execution' | 'action';

export interface ClassificationExecutionSeed {
  readonly binding: ProductCommandBinding; readonly ownerSubjectId: string; readonly collectionId: string;
  readonly fingerprint: string; readonly requestId: string; readonly context: ClassificationContext;
  readonly providerId: string; readonly model: string; readonly policyVersion: string; readonly promptVersion: string;
  readonly deadlineAt: string;
  /** Managed preview admission requires explicit consent; legacy receipts may omit it. */
  readonly billing?: ClassificationBillingConsent;
  readonly source?: 'web' | 'extension' | 'batch' | 'system';
  /** Internal worker fence: batch children inherit the run's persisted billing mode. */
  readonly billingMode?: ClassificationBillingMode;
  readonly billingOwnerKind?: ClassificationBillingOwnerKind;
  readonly creditChargeId?: string | null;
}
export interface ClassificationExecutionLease extends ClassificationExecutionSeed {
  readonly id: string; readonly generation: string; readonly deadlineAt: string;
  readonly billingMode?: ClassificationBillingMode;
  readonly creditChargeId?: string | null;
  readonly billingOwnerKind?: ClassificationBillingOwnerKind;
}
export type ClassificationExecutionAdmission = Exclude<ProductCommandClaim, {kind:'claimed'}> | {readonly kind:'accepted';readonly executionId:string};
/**
 * input_json is re-read on every lease. Derived candidates are rebuilt after
 * deserialization, so persisting them would multiply the raw tree by its depth.
 */
export function persistedClassificationContext(context: ClassificationContext): ClassificationContext {
  return {...context, candidates: null};
}
/**
 * Provider failure codes that prove the upstream never accepted the request: a
 * rejected credential, a 429/529 that was answered (or whose retry never
 * started), and a deadline abort raised before any request body left the
 * process — the transport maps a mid-flight abort to `outcome_unknown` instead.
 * Their dispatch reservation must be released. `contract_drift` and
 * `outcome_unknown` stay conservative because tokens may already have been
 * spent. Only ClassificationProviderError carries these codes.
 */
export function classificationCallProvenNotAccepted(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return code === 'credentials' || code === 'rate_limited' || code === 'deadline';
}
export interface ClassificationExecutionStore {
  lookup(input:Pick<ClassificationExecutionSeed,'binding'|'fingerprint'|'ownerSubjectId'|'collectionId'>):Promise<ClassificationExecutionAdmission|null>;
  admit(seed: ClassificationExecutionSeed): Promise<ClassificationExecutionAdmission>;
  lease(id: string): Promise<ClassificationExecutionLease | null>;
  heartbeat(lease: ClassificationExecutionLease): Promise<boolean>;
  prepare(lease: ClassificationExecutionLease, stage: ClassificationStage, chunk: number, digest: string): Promise<ClassificationCallResult | null>;
  dispatch(lease: ClassificationExecutionLease, stage: ClassificationStage, chunk: number): Promise<void>;
  completeCall(lease: ClassificationExecutionLease, stage: ClassificationStage, chunk: number, result: ClassificationCallResult): Promise<void>;
  rejectCall(lease:ClassificationExecutionLease,stage:ClassificationStage,chunk:number,notAccepted:boolean,attempts?:number):Promise<void>;
  finish(lease: ClassificationExecutionLease, state:'succeeded'|'failed'|'outcome_unknown', result:ProductCommandResult,failureCode?:string):Promise<boolean>;
  pending(): Promise<readonly string[]>;
  reap(): Promise<number>;
}

export interface ClassificationPreviewRuntime {
  preview(input:{readonly actor:{readonly principalId:string;readonly subjectId:string};readonly collectionId:string;
    readonly commandId:string;readonly requestId:string;readonly document:unknown}):Promise<ClassificationExecutionAdmission>;
  start():void;
  stop():Promise<void>;
}

export function classificationFailureReceipt(requestId: string, reason: string): ProductCommandResult {
  const changed = reason === 'configuration_changed';
  return {status: changed ? 409 : 503, contractVersion:'1.0.0', mediaType:'application/json',
    stableHeaders:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'},
    body:Buffer.from(JSON.stringify({error:{code:changed?'revision_conflict':'feature_temporarily_unavailable',
      message:changed?'Classification context changed.':'Classification could not be completed.',requestId,
      recovery:changed?'refresh_and_retry':'user_action',sameRequestRetrySafe:false,precondition:null,currentEtag:null,retryAfterSeconds:null,fieldErrors:[]}}))};
}
