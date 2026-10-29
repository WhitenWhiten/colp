import { automationDigest, type SubmitResultInput, type SubmissionResult, type TaskSpec } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import { parseContract } from './rule-service.js';
import type { WorkPrincipal } from './claim-job.js';

export interface ResultSubmissionPort {
  task(actor: WorkPrincipal,jobId: string): Promise<{ task: TaskSpec; sourceReferences: string[] }>;
  prepare(actor: WorkPrincipal,jobId: string,input: SubmitResultInput,proposalDigest: string): Promise<void>;
  /** serverApply: the server applies an Owner-approved pinned proposal; the worker need not be online. */
  reconcile(actor: WorkPrincipal,jobId: string,options?: { serverApply?: boolean }): Promise<SubmissionResult>;
}
/** Validate the closed output and each evidence group before persisting a proposal or effect. */
export async function submitResult(port: ResultSubmissionPort,actor: WorkPrincipal,jobId: string,body: unknown): Promise<SubmissionResult> {
  const input = parseContract('SubmitResultInput',body), pin = await port.task(actor,jobId), output = input.output;
  const kind = pin.task.type.startsWith('classify.') ? 'placement' : pin.task.type === 'tags.generate' ? 'tags'
    : pin.task.type === 'metadata.resolve' ? 'metadata' : 'text';
  if (input.outputContract !== pin.task.outputContract || output.kind !== kind
    || (output.kind === 'text' && pin.task.type !== `${output.textType}.generate`))
    throw new AutomationError('invalid_request','Output does not match the pinned task contract.');
  const groups = output.kind === 'tags' ? output.add.map(tag => tag.evidence)
    : output.kind === 'metadata' ? [output.evidence, ...output.tags.map(tag => tag.evidence)] : [output.evidence];
  if (groups.some(evidence => !evidence.some(e => e.kind === 'source' && pin.sourceReferences.includes(e.reference))
    || evidence.some(e => e.kind === 'source' && !pin.sourceReferences.includes(e.reference))))
    throw new AutomationError('invalid_request','Every typed output or added tag requires evidence from the pinned source inputs.');
  const proposalDigest = automationDigest({ inputDigest: input.inputDigest,outputContract: input.outputContract,output });
  await port.prepare(actor,jobId,input,proposalDigest);
  return port.reconcile(actor,jobId);
}
