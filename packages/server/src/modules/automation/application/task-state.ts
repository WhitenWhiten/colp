import type { Job, Run } from '@know-n/colp/automation';

export const PREDECESSOR_FAILED = 'predecessor_failed';
export const ACTIVE_TASK_STATES: ReadonlySet<Job['status']> = new Set(['ready', 'leased', 'committing', 'awaitingApproval', 'uncertain']);

export function taskBlocksSuccessors(job: { state: Job['status']; budget_block_reason: string | null }): boolean {
  return ACTIVE_TASK_STATES.has(job.state) || job.state === 'blocked' && job.budget_block_reason === 'daily';
}

export function terminalTaskRunState(jobs: readonly { state: Job['status'] }[]): Run['status'] {
  if (jobs.every(job => job.state === 'succeeded')) return 'completed';
  if (jobs.some(job => job.state === 'succeeded')) return 'partial';
  if (jobs.some(job => job.state === 'blocked')) return 'blocked';
  return jobs.every(job => job.state === 'failed') ? 'failed' : 'review';
}
