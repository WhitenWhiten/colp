import type { Job,SubmissionResult } from '@know-n/colp/automation';
export interface OwnerJobStore {
  get(id: string): Promise<Job>;
  decide(id: string,body: unknown,ifMatch: string,commandId: string): Promise<SubmissionResult>;
  retry(id: string,body: unknown,ifMatch: string): Promise<Job>;
}
