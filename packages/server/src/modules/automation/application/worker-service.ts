import type { Job,JobPage,TaskInputPage } from '@know-n/colp/automation';
import type { WorkPrincipal } from './claim-job.js';
export interface AutomationWorkerService {
  list(actor: WorkPrincipal,query: { targetId?: string; cursor?: string; limit?: string }): Promise<JobPage>;
  get(actor: WorkPrincipal,id: string,deliveryHandle: string): Promise<Job>;
  inputs(actor: WorkPrincipal,id: string,query: { deliveryHandle: string; cursor?: string; limit?: string }): Promise<TaskInputPage>;
  mutate(actor: WorkPrincipal,id: string,operation: 'claim' | 'heartbeat' | 'submit' | 'fail',body: unknown,commandId: string): Promise<unknown>;
}
