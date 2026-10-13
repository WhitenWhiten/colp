import type { RunOutputView,OperationReceipt } from '@know-n/colp/automation';
import type { PageAfter } from './ports.js';
export interface RunOutputStore {
  authorize(runId:string):Promise<void>;
  list(runId:string,after:PageAfter|null,limit:number):Promise<{view:RunOutputView;createdAt:string}[]>;
  markRead(runId:string,input:unknown,ifMatch:string):Promise<{receipt:OperationReceipt;revision:string}>;
}
