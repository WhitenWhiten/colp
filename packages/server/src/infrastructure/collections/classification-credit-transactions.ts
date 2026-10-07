import { sql, type Kysely } from 'kysely';
import { CreditError, type AccountCreditsPort } from '../../modules/identity/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { DatabaseOperationError } from '../database/errors.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';

export const mapClassificationCreditError=(error:unknown):CreditError=>{
    if(error instanceof CreditError)return error;
    if(error instanceof DatabaseOperationError&&error.kind==='commit_outcome_unknown')return new CreditError('credits_unavailable',undefined,{cause:error});
    if(error instanceof DatabaseOperationError&&error.cause!==undefined)return mapClassificationCreditError(error.cause);
    const value=typeof error==='object'&&error!==null?error as {code?:unknown;message?:unknown;cause?:unknown}:{};
    if(value.cause!==undefined)return mapClassificationCreditError(value.cause);
    if(value.code==='55P03'||value.code==='40P01'||value.code==='40001')return new CreditError('credits_busy',undefined,{cause:error});
    if(value.code==='P0001'&&value.message==='credit_reconciliation_required')return new CreditError('credits_reconciling',undefined,{cause:error});
    if(value.code==='P0001'&&value.message==='insufficient_credits')return new CreditError('insufficient_credits',undefined,{cause:error});
    return new CreditError('credits_unavailable',undefined,{cause:error});
  };

/**
 * Bound on any single credit transaction: how long a credit/row lock may be
 * held. Hot paths (admission, lease, receipt, settlement) stay at this value.
 */
export const CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS = 2_000;

/**
 * Clamps a requested transaction budget. Raising the default is allowed for work
 * the API contract sizes; lowering it never is, so no caller can hold credit
 * locks past the designed bound by accident either way.
 */
export function classificationCreditTransactionTimeoutMs(requested?:number):number{
  return Number.isSafeInteger(requested)&&(requested as number)>=CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS
    ?requested as number:CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS;
}

/**
 * Runs one credit-wrapped transaction. `timeoutMs` may only raise the default
 * bound: an operation whose work is sized by the API contract itself (run apply
 * admits up to 50 items / 256 KiB) passes its own budget, while every other
 * credit path keeps the tight default. Lowering the bound is not possible.
 */
export function createClassificationCreditTransactions(db:Kysely<DatabaseSchema>,options:Pick<UnitOfWorkOptions,'faultInjector'|'signal'|'cancelBackend'>={}){
  const execute=<Result>(work:(context:{readonly transaction:DatabaseTransaction})=>Promise<Result>, includeFault=true,
    timeoutMs:number=CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS):Promise<Result>=>{
    const budget=classificationCreditTransactionTimeoutMs(timeoutMs);
    const deadline=AbortSignal.timeout(budget);
    const signal=options.signal?AbortSignal.any([deadline,options.signal]):deadline;
    const unit=createUnitOfWork(db,{
      faultInjector:includeFault?options.faultInjector:undefined,signal,cancelBackend:options.cancelBackend,
    });
    const pending=unit.execute(async({transaction:tx})=>{
      // The transaction owns its pooled connection until cancellation settles.
      // A fallback cancellation must therefore use an independent control client.
      const disposeCancellation=options.cancelBackend?undefined:await installPostgresTransactionCancellation(tx,signal);
      try {
        if(signal.aborted)throw signal.reason;
        await sql`SET LOCAL lock_timeout='250ms'`.execute(tx);
        // set_config keeps the budget a bind parameter instead of interpolated SQL.
        await sql`SELECT set_config('statement_timeout',${`${budget}ms`},true)`.execute(tx);
        await sql`SELECT set_config('idle_in_transaction_session_timeout',${`${budget}ms`},true)`.execute(tx);
        return await work({transaction:tx});
      } finally {
        await disposeCancellation?.();
      }
    });
    return new Promise<Result>((resolve,reject)=>{
      const abort=()=>reject(options.signal?.aborted?options.signal.reason
        :new CreditError('credits_unavailable',undefined,{cause:signal.reason}));
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      void pending.then(resolve,error=>reject(error instanceof DatabaseOperationError?mapClassificationCreditError(error):error))
        .finally(()=>signal.removeEventListener('abort',abort));
    });
  };
  return {execute};
}

export async function reconcileClassificationCredits(db:Kysely<DatabaseSchema>,factory:((tx:DatabaseTransaction,accountId:string)=>AccountCreditsPort)|undefined,
  accountId:string,options:{allowInactive?:boolean;cancelBackend?:UnitOfWorkOptions['cancelBackend']}={}):Promise<void>{
  if(!factory)throw new CreditError('credits_unavailable');
  const result=await createClassificationCreditTransactions(db,options).execute(async({transaction:tx})=>{
    const credits=factory(tx,accountId);await credits.lock({allowInactive:options.allowInactive});return credits.reconcile();
  });
  if(result.hasMore)throw new CreditError('credits_reconciling');
}
