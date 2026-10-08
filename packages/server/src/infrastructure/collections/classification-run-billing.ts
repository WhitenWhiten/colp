import { sql, type Kysely } from 'kysely';
import { classificationFailureReceipt } from '../../modules/collections/index.js';
import { CreditError, type AccountCreditsPort, type CreditReleaseReason } from '../../modules/identity/index.js';
import type { DatabaseTransaction, UnitOfWorkOptions } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createClassificationCreditTransactions } from './classification-credit-transactions.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';

export interface ClassificationRunCreditsFactory {
  (transaction: DatabaseTransaction, accountId: string): AccountCreditsPort;
}

export type ClassificationRunCreditsPort = AccountCreditsPort;

const lockTimes = new WeakMap<object, Date|string>();
export function lockedCreditsAsOf(credits: AccountCreditsPort): Date|string {
  const value=lockTimes.get(credits);if(value===undefined)throw new CreditError('credits_unavailable');return value;
}

export interface ClassificationRunBillingOptions {
  readonly credits?: ClassificationRunCreditsFactory;
  readonly creditEnabled?: boolean;
  readonly managedAdmissionEnabled?: boolean;
  readonly cancelBackend?:UnitOfWorkOptions['cancelBackend'];
  readonly faultInjector?:UnitOfWorkOptions['faultInjector'];
}

export interface ClassificationRunChargeOwner {
  readonly accountId: string;
  readonly chargeId: string | null;
  readonly mode: 'managed' | 'byok' | 'legacy_free';
}

export async function lockRunCredits(
  transaction: DatabaseTransaction,
  options: ClassificationRunBillingOptions,
  owner: ClassificationRunChargeOwner,
  allowInactive = false,
): Promise<ClassificationRunCreditsPort | null> {
  const account=await transaction.selectFrom('accounts').select(['status','deleted_at']).where('id','=',owner.accountId).forShare().executeTakeFirst();
  if(!account||(!allowInactive&&(account.status!=='active'||account.deleted_at!==null)))throw new CreditError('credits_unavailable');
  if (owner.mode !== 'managed') return null;
  if (options.credits === undefined) {
    throw new CreditError('credits_unavailable');
  }
  const credits = options.credits(transaction, owner.accountId);
  await credits.lock({ allowInactive });
  const asOf=(await sql<{value:string}>`SELECT clock_timestamp()::text AS value`.execute(transaction)).rows[0]!.value;
  lockTimes.set(credits, asOf);
  return credits;
}

/** Fence child provider work before releasing an action-owned charge. */
export async function lockActionReceipts(
  transaction: DatabaseTransaction,
  accountId: string, executionCommandIds: readonly string[],
): Promise<void> {
  if (executionCommandIds.length === 0) return;
  for(const id of [...executionCommandIds].sort())await sql`SELECT pg_advisory_xact_lock(hashtextextended(
    json_build_array(${accountId}::text,'collections:classification-run-action:v1'::text,${id}::text)::text,0))`.execute(transaction);
  await sql`
    SELECT principal_id, command_scope, command_id
    FROM product_command_receipts
    WHERE principal_id=${accountId} AND command_scope = 'collections:classification-run-action:v1'
      AND command_id = ANY(${[...executionCommandIds]}::text[])
    ORDER BY command_scope, command_id
    FOR UPDATE
  `.execute(transaction);
}

export async function fenceActionExecution(
  transaction: DatabaseTransaction,
  accountId: string, executionCommandId: string,
): Promise<void> {
  // Receipt rows are L2 and must be locked before the L5 execution rows. The
  // child receipt is completed here so every owner (cancel, stop and reaper)
  // releases the parent charge only after the child command is terminal.
  // The caller already holds all child receipt gates/rows at L2.
  const executionRows = await sql<{ id: string; state: string; request_id: string }>`
    SELECT e.id
      , e.state, e.request_id
    FROM classification_provider_executions e
    WHERE e.principal_id=${accountId} AND e.command_scope = 'collections:classification-run-action:v1'
      AND e.command_id = ${executionCommandId}
    ORDER BY e.id
    FOR UPDATE
  `.execute(transaction);
  for (const execution of executionRows.rows) {
    await sql`
      SELECT execution_id
      FROM classification_call_attempts
      WHERE execution_id = ${execution.id}
      ORDER BY stage, chunk_index
      FOR UPDATE
    `.execute(transaction);
    await sql`
      UPDATE classification_call_attempts
      SET state = CASE WHEN state IN ('dispatching','unknown') THEN 'unknown' ELSE state END,
          completed_at = CASE WHEN state IN ('dispatching','unknown') THEN clock_timestamp() ELSE completed_at END,
          settled_microusd=reserved_microusd
      WHERE execution_id = ${execution.id}
        AND state IN ('dispatching','unknown')
    `.execute(transaction);
    await sql`
      UPDATE classification_provider_executions
      SET state = CASE WHEN EXISTS (
            SELECT 1 FROM classification_call_attempts
            WHERE execution_id = ${execution.id} AND state = 'unknown'
          ) THEN 'outcome_unknown' ELSE 'failed' END,
          failure_code = CASE WHEN EXISTS (
            SELECT 1 FROM classification_call_attempts
            WHERE execution_id = ${execution.id} AND state = 'unknown'
          ) THEN 'outcome_unknown' ELSE 'disabled' END,
          generation = generation + 1,
          lease_until = NULL,
          completed_at = clock_timestamp()
      WHERE id = ${execution.id} AND state IN ('pending','running')
    `.execute(transaction);
  }
  const receipts = await sql<{
    principal_id: string; command_scope: string; command_id: string; request_fingerprint: string;
    completed_at: Date | null;
  }>`
    SELECT principal_id, command_scope, command_id, request_fingerprint, completed_at
    FROM product_command_receipts
    WHERE principal_id=${accountId} AND command_scope = 'collections:classification-run-action:v1'
      AND command_id = ${executionCommandId}
    ORDER BY command_scope, command_id
    FOR UPDATE
  `.execute(transaction);
  const receiptPort = createPostgresProductCommandReceiptPort(transaction);
  const successfulExecution = executionRows.rows.some(execution => execution.state === 'succeeded');
  if (!successfulExecution) {
    for (const receipt of receipts.rows) {
      if (receipt.completed_at !== null) continue;
      await receiptPort.complete(
        { principalId: receipt.principal_id, commandScope: receipt.command_scope, commandId: receipt.command_id },
        receipt.request_fingerprint,
        classificationFailureReceipt(executionCommandId, 'cancelled'),
      );
    }
  }
}

export async function finishActionCharge(
  credits: AccountCreditsPort | null,
  chargeId: string | null,
  succeeded: boolean,
  releaseReason: CreditReleaseReason = 'classification_failed',
): Promise<boolean> {
  if (credits === null || chargeId === null) return true;
  const changed=succeeded ? await credits.settle(chargeId) : await credits.release(chargeId, releaseReason);
  if(!changed)throw new CreditError('credits_unavailable');
  return true;
}

/**
 * Run apply mutates every admitted selection inside ONE transaction (atomicity
 * is a product invariant: "one winner, no partial node writes"). The route
 * admits up to 50 items and a 256 KiB body, which measurably exceeds the 2 s
 * credit-transaction default, so the budget grows with the admitted work.
 * Every other run transaction keeps the default.
 */
export const CLASSIFICATION_RUN_APPLY_BASE_TIMEOUT_MS = 3_000;
export const CLASSIFICATION_RUN_APPLY_ITEM_TIMEOUT_MS = 120;
export const CLASSIFICATION_RUN_APPLY_MAX_TIMEOUT_MS = 10_000;

export function classificationRunApplyTimeoutMs(items:number):number{
  const admitted=Number.isSafeInteger(items)&&items>0?items:0;
  return Math.min(CLASSIFICATION_RUN_APPLY_MAX_TIMEOUT_MS,
    CLASSIFICATION_RUN_APPLY_BASE_TIMEOUT_MS+admitted*CLASSIFICATION_RUN_APPLY_ITEM_TIMEOUT_MS);
}

export function createClassificationRunUnitOfWork(db:Kysely<DatabaseSchema>,
  options:Pick<UnitOfWorkOptions,'cancelBackend'|'faultInjector'>&{readonly transactionTimeoutMs?:number}={}){
  return {execute<Result>(work:(context:{transaction:DatabaseTransaction})=>Promise<Result>):Promise<Result>{
    return createClassificationCreditTransactions(db,options).execute(work,true,options.transactionTimeoutMs);
  }};
}

export async function lockRunContext(tx:DatabaseTransaction,runId:string,collectionId:string):Promise<void>{
  // T-10 lock order (ADR-0027): the callers are the classification run worker
  // job/lease transitions (`classification-run-jobs.ts`) and the run apply
  // path (`classification-run-apply.ts`). Run apply reaches this helper from
  // its runs.lock callback and then executes canonical node mutations through
  // `createClassificationCanonicalPorts`, whose operations port marks this
  // collection's active replicas `recovery_required`. Lock the replica rows
  // before `collections` so those commands never invert the Sync prefix.
  // (classify-inbox accept does not use this helper; it takes the collection
  // through `createClassificationCanonicalPorts().collections.lockForUpdate`,
  // which is already replica-first via `lockCollectionForReplicaInvalidation`.)
  await lockActiveSyncReplicasForCollection(tx,collectionId);
  await tx.selectFrom('collections').select('id').where('id','=',collectionId).forUpdate().executeTakeFirst();
  await tx.selectFrom('collection_classification_settings').select('collection_id').where('collection_id','=',collectionId).forShare().executeTakeFirst();
  await sql`SELECT p.id FROM classification_provider_profiles p WHERE p.id=(SELECT snapshot_json->'taxonomy'->'providerBinding'->>'profileId'
    FROM collection_classification_runs WHERE id=${runId}) FOR SHARE`.execute(tx);
}
