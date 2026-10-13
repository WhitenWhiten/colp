import type { Job,JobPage,TaskInputPage,ClaimInput,HeartbeatInput,FailureInput,SubmitResultInput } from '@know-n/colp/automation';
import type { WorkPrincipal } from './claim-job.js';
import { parseContract } from './rule-service.js';

export interface AutomationWorkerService {
  list(actor: WorkPrincipal,query: { targetId?: string; cursor?: string; limit?: string }): Promise<JobPage>;
  get(actor: WorkPrincipal,id: string,deliveryHandle: string): Promise<Job>;
  inputs(actor: WorkPrincipal,id: string,query: { deliveryHandle: string; cursor?: string; limit?: string }): Promise<TaskInputPage>;
  mutate(actor: WorkPrincipal,id: string,operation: WorkerCommand['operation'],body: unknown,commandId: string): Promise<unknown>;
}

export type WorkerCommand =
  | { operation: 'claim'; input: ClaimInput }
  | { operation: 'heartbeat'; input: HeartbeatInput }
  | { operation: 'fail'; input: FailureInput }
  | { operation: 'submit'; input: SubmitResultInput };

export function parseWorkerCommand(operation: WorkerCommand['operation'],body: unknown): WorkerCommand {
  switch (operation) {
    case 'claim': return { operation,input: parseContract('ClaimInput',body) };
    case 'heartbeat': return { operation,input: parseContract('HeartbeatInput',body) };
    case 'fail': return { operation,input: parseContract('FailureInput',body) };
    case 'submit': return { operation,input: parseContract('SubmitResultInput',body) };
  }
}
