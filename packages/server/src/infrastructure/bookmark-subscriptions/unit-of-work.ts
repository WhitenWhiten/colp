import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction, type TransactionFaultInjector } from '../database/unit-of-work.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { lockBookmarkSubscriptionAccount } from '../database/account-coordination.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { createPostgresBookmarkPreferencesStore } from '../identity/postgres-bookmark-preferences.js';
import { databaseNow } from '../database/time.js';
import { createBookmarkSubscriptionStore } from './store.js';
import { createActorCollectionReader } from '../collections/index.js';
import { createBookmarkSubscriptionSources } from './sources.js';
import type { Metrics } from '../telemetry/index.js';
import { createSubscriptionExitCoordinator, BookmarkSubscriptionError, fail } from '../../modules/bookmark-subscriptions/index.js';
import type { SubscriptionTransactionPorts, BookmarkSubscriptionUnitOfWork } from '../../modules/bookmark-subscriptions/index.js';
export interface BookmarkSubscriptionAdapterOptions { origin:string; reportsEnabled?:boolean; faultInjector?:TransactionFaultInjector;metrics?:Metrics }
export function createPostgresBookmarkSubscriptionPorts(tx:DatabaseTransaction,options:BookmarkSubscriptionAdapterOptions):SubscriptionTransactionPorts {
  return {store:createBookmarkSubscriptionStore(tx),sources:createBookmarkSubscriptionSources(tx,options,createActorCollectionReader(tx,options.origin)),receipts:createPostgresProductCommandReceiptPort(tx),lockAccount:accountId=>lockBookmarkSubscriptionAccount(tx,accountId),now:()=>databaseNow(tx),async preferences(accountId){return await createPostgresBookmarkPreferencesStore(tx).load(accountId)??{revision:'0',subscriptionOnUnfollow:'keep',subscriptionOnUnsubscribe:'keep'};}};
}
export function createPostgresBookmarkSubscriptionExitPort(tx:DatabaseTransaction,options:BookmarkSubscriptionAdapterOptions={origin:'https://known.invalid'}) {return createSubscriptionExitCoordinator(createPostgresBookmarkSubscriptionPorts(tx,options));}
export function createPostgresBookmarkSubscriptionUnitOfWork(db:Kysely<DatabaseSchema>,options:BookmarkSubscriptionAdapterOptions):BookmarkSubscriptionUnitOfWork {
  return {async execute(work,execution={}) {const started=Date.now();const signal=execution.signal??AbortSignal.timeout(15000);try{return await createUnitOfWork(db,{isolationLevel:execution.write?'read committed':'repeatable read',faultInjector:options.faultInjector}).execute(async({transaction:tx})=>{
    const dispose=await installPostgresTransactionCancellation(tx,signal);
    try {await sql.raw("set local statement_timeout = '15000ms'").execute(tx);if(signal.aborted)fail('feature_temporarily_unavailable');const result=await work(createPostgresBookmarkSubscriptionPorts(tx,options));if(signal.aborted)fail('feature_temporarily_unavailable');return result;}finally{await dispose?.();}
  });}catch(error){
      const code=error instanceof BookmarkSubscriptionError?error.code:'database_or_dependency';
      options.metrics?.increment('bookmark_subscriptions.transaction_error.'+code);
      if(signal.aborted)fail('feature_temporarily_unavailable');throw error;
    }finally{options.metrics?.observe('bookmark_subscriptions.transaction_ms',Date.now()-started);}}};
}
